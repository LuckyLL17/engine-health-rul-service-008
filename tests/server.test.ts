import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import { createDemoTelemetry } from '../src/demo-data.js';
import type { FastifyInstance } from 'fastify';
import { Engine, TelemetrySample } from '../src/types.js';

let dirs: string[] = [];
async function appFor(id: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ehs-test-'));
  dirs.push(dir);
  const store = new LocalStore(join(dir, 'state.json'));
  const app = await createApp(store);
  return { app, store };
}

const engine: Engine = {
  id: 'ENG-EMPTY-001', serialNumber: 'TEST-001', model: 'AeroCore-X90', aircraftId: 'AC-TEST',
  installedAt: '2026-10-01', totalCycles: 10, status: 'healthy', currentHealthScore: 90,
};

const illegalRow = (flightId: string, timestamp: string, override: Partial<TelemetrySample> = {}): TelemetrySample => ({
  engineId: engine.id, flightId, timestamp, cycle: 1, phase: 'takeoff',
  rpm: 7400, exhaustGasTemp: 900, fuelFlow: 999, vibration: 9, oilPressure: 0.2,
  oilTemperature: 90, ambientTemperature: 20, altitude: 800, thrust: 40, ...override,
});

const validRows = (): TelemetrySample[] =>
  createDemoTelemetry(engine.id).map(row => ({ ...row, flightId: 'FLIGHT-OK' }));

async function audit(app: FastifyInstance) {
  const reply = await app.inject({ method: 'GET', url: `/api/audit/${engine.id}` });
  return reply.json() as Array<{ action: string }>;
}

afterEach(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe('health-assessment unusable telemetry chain', () => {
  it('returns a clear business error and creates nothing when all telemetry is unusable', async () => {
    const { app, store } = await appFor(engine.id);
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: {
        engine,
        telemetry: [
          illegalRow('F-BAD-1', '2026-10-01T08:00:00.000Z', { exhaustGasTemp: 900 }),
          illegalRow('F-BAD-2', '2026-10-01T08:10:00.000Z', { rpm: Number.NaN }),
          illegalRow('F-BAD-3', '2026-10-01T08:20:00.000Z', { fuelFlow: 500, vibration: 8 }),
        ],
      },
    });

    const assess = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    expect(assess.statusCode).toBe(422);
    const body = assess.json() as { error: string; code: string; details: unknown };
    expect(body.code).toBe('no_usable_telemetry');
    expect(body.error).toContain('合法遥测样本');
    expect(body.details).toEqual({ totalSamples: 3, rejectedSamples: 3 });

    // RUL cannot ride on a phantom assessment
    const rul = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/rul-prediction` });
    expect(rul.statusCode).toBe(422);
    expect((rul.json() as { code?: string }).code).toBe('health_assessment_required');

    // No assessment / prediction / assessment-or-rul audit persisted
    expect(store.assessments).toHaveLength(0);
    expect(store.predictions).toHaveLength(0);
    const actions = (await audit(app)).map(item => item.action);
    expect(actions).not.toContain('health_assessment');
    expect(actions).not.toContain('rul_prediction');

    // Engine state untouched
    const got = (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}` })).json();
    expect(got.engine.status).toBe('healthy');
    expect(got.engine.currentHealthScore).toBe(90);
    expect(got.engine.lastAssessmentAt).toBeUndefined();
    expect(got.latestAssessment).toBeFalsy();
    expect(got.latestPrediction).toBeFalsy();

    // Risk-events stays empty because no assessment anomalies were stored
    const events = await app.inject({ method: 'GET', url: `/api/engines/${engine.id}/risk-events` });
    expect(events.json()).toEqual([]);
    await app.close();
  });

  it('still 422s when only the filtered flight has no usable samples', async () => {
    const { app } = await appFor(engine.id);
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: { engine, telemetry: [illegalRow('F-BAD', '2026-10-01T08:00:00.000Z')] },
    });
    const reply = await app.inject({
      method: 'POST', url: `/api/engines/${engine.id}/health-assessment`,
      payload: { flightId: 'F-BAD' },
    });
    expect(reply.statusCode).toBe(422);
    expect((reply.json() as { code: string }).code).toBe('no_usable_telemetry');
    await app.close();
  });

  it('assesses normally when only part of the telemetry is rejected', async () => {
    const { app, store } = await appFor(engine.id);
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: { engine, telemetry: [...validRows(), illegalRow('F-BAD', '2026-09-30T20:00:00.000Z')] },
    });

    const assess = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    expect(assess.statusCode).toBe(200);
    const assessment = assess.json() as { dataQuality: { usableSamples: number; rejectedSamples: number } };
    expect(assessment.dataQuality.usableSamples).toBe(72);
    expect(assessment.dataQuality.rejectedSamples).toBe(1);

    const rul = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/rul-prediction` });
    expect(rul.statusCode).toBe(200);
    expect(store.predictions).toHaveLength(1);

    const actions = (await audit(app)).map(item => item.action);
    expect(actions).toContain('health_assessment');
    expect(actions).toContain('rul_prediction');
    await app.close();
  });

  it('recovers after a failed attempt once valid telemetry is re-imported', async () => {
    const { app, store } = await appFor(engine.id);
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: { engine, telemetry: [illegalRow('F-BAD', '2026-10-01T08:00:00.000Z')] },
    });

    const failed = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    expect(failed.statusCode).toBe(422);

    // Re-import legitimate data
    await app.inject({ method: 'POST', url: '/api/engines/import', payload: { telemetry: validRows() } });

    const assess = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    expect(assess.statusCode).toBe(200);
    const assessment = assess.json() as { sampleCount: number; dataQuality: { usableSamples: number; rejectedSamples: number } };
    expect(assessment.dataQuality.usableSamples).toBe(72);
    expect(assessment.dataQuality.rejectedSamples).toBe(1);
    expect(assessment.sampleCount).toBe(73);
    expect(store.assessments).toHaveLength(1);

    const rul = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/rul-prediction` });
    expect(rul.statusCode).toBe(200);

    const got = (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}` })).json();
    expect(got.engine.lastAssessmentAt).toBeTruthy();
    await app.close();
  });

  it('does not overwrite an existing valid state with a later all-bad assessment', async () => {
    const { app, store } = await appFor(engine.id);
    await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine, telemetry: validRows() } });
    const first = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { assessmentId: string; healthScore: number; status: string; createdAt: string };
    const snapshot = {
      status: store.engines[0].status,
      currentHealthScore: store.engines[0].currentHealthScore,
      lastAssessmentAt: store.engines[0].lastAssessmentAt,
    };

    // Later import containing only garbage under a new flight, then an assessment scoped to that flight
    await app.inject({
      method: 'POST', url: '/api/engines/import',
      payload: { telemetry: [illegalRow('F-BAD', '2026-10-02T08:00:00.000Z')] },
    });
    const retry = await app.inject({
      method: 'POST', url: `/api/engines/${engine.id}/health-assessment`,
      payload: { flightId: 'F-BAD' },
    });
    expect(retry.statusCode).toBe(422);
    expect((retry.json() as { code: string }).code).toBe('no_usable_telemetry');

    expect(store.engines[0].status).toBe(snapshot.status);
    expect(store.engines[0].currentHealthScore).toBe(snapshot.currentHealthScore);
    expect(store.engines[0].lastAssessmentAt).toBe(snapshot.lastAssessmentAt);
    expect(store.assessments).toHaveLength(1);
    expect(store.assessments[0].assessmentId).toBe(firstBody.assessmentId);

    // Latest assessment endpoint still returns the valid one
    const got = (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}` })).json();
    expect(got.latestAssessment.assessmentId).toBe(firstBody.assessmentId);
    expect(got.latestAssessment.healthScore).toBe(firstBody.healthScore);
    await app.close();
  });

  it('returns telemetry_not_found when no rows exist at all', async () => {
    const { app } = await appFor(engine.id);
    await app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine } });
    const reply = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment` });
    expect(reply.statusCode).toBe(422);
    expect(reply.json()).toMatchObject({ error: 'telemetry_not_found' });
    await app.close();
  });
});
