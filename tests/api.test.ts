import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoTelemetry } from '../src/demo-data.js';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import { Engine, TelemetrySample } from '../src/types.js';

const engine: Engine = { id: 'ENG-EMPTY-001', serialNumber: 'CFM-TEST-0001', model: 'AeroCore-X90', aircraftId: 'AC-4096', installedAt: '2026-01-15', totalCycles: 12, status: 'healthy', currentHealthScore: 91 };

const invalidRows = (flightId: string): TelemetrySample[] => createDemoTelemetry(engine.id).slice(0, 10).map((item, index) => index % 2 === 0
  ? { ...item, flightId, exhaustGasTemp: 900 }
  : { ...item, flightId, vibration: Number.NaN });

const validRows = (flightId: string): TelemetrySample[] => createDemoTelemetry(engine.id).map(item => ({ ...item, flightId }));

describe('health assessment api chain', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'engine-health-'));
    app = await createApp(new LocalStore(join(dir, 'state.json')));
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const importEngine = (telemetry: TelemetrySample[]) => app.inject({ method: 'POST', url: '/api/engines/import', payload: { engine, telemetry } });
  const assess = (payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/engines/${engine.id}/health-assessment`, payload });
  const detail = async () => (await app.inject({ method: 'GET', url: `/api/engines/${engine.id}` })).json();
  const audit = async (): Promise<Array<{ action: string }>> => (await app.inject({ method: 'GET', url: `/api/audit/${engine.id}` })).json();

  it('rejects assessment without usable samples and records nothing', async () => {
    await importEngine(invalidRows('FLIGHT-BAD-1'));
    const res = await assess();
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('no_usable_telemetry');

    const state = await detail();
    expect(state.engine.status).toBe('healthy');
    expect(state.engine.currentHealthScore).toBe(91);
    expect(state.engine.lastAssessmentAt).toBeUndefined();
    expect(state.latestAssessment ?? null).toBeNull();
    expect(state.latestPrediction ?? null).toBeNull();

    const prediction = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/rul-prediction`, payload: {} });
    expect(prediction.statusCode).toBe(422);

    expect((await audit()).map(item => item.action)).toEqual(['engine_import']);
  });

  it('assesses normally once valid telemetry is imported after a failure', async () => {
    await importEngine(invalidRows('FLIGHT-BAD-1'));
    expect((await assess()).statusCode).toBe(422);

    await importEngine(validRows('FLIGHT-GOOD-1'));
    const res = await assess();
    expect(res.statusCode).toBe(200);
    const assessment = res.json();
    expect(assessment.dataQuality.usableSamples).toBe(72);
    expect(assessment.dataQuality.rejectedSamples).toBe(10);
    expect(assessment.healthScore).toBeGreaterThanOrEqual(0);
    expect(assessment.healthScore).toBeLessThanOrEqual(100);

    const prediction = await app.inject({ method: 'POST', url: `/api/engines/${engine.id}/rul-prediction`, payload: { horizonCycles: 120 } });
    expect(prediction.statusCode).toBe(200);
    expect(prediction.json().estimatedRemainingCycles).toBeGreaterThan(0);
  });

  it('does not overwrite existing valid state when a later assessment fails', async () => {
    await importEngine(validRows('FLIGHT-GOOD-1'));
    const first = (await assess()).json();
    const before = await detail();
    expect(before.latestAssessment.assessmentId).toBe(first.assessmentId);

    await importEngine(invalidRows('FLIGHT-BAD-2'));
    const res = await assess({ flightId: 'FLIGHT-BAD-2' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('no_usable_telemetry');

    const after = await detail();
    expect(after.engine.status).toBe(before.engine.status);
    expect(after.engine.currentHealthScore).toBe(before.engine.currentHealthScore);
    expect(after.engine.lastAssessmentAt).toBe(before.engine.lastAssessmentAt);
    expect(after.latestAssessment.assessmentId).toBe(first.assessmentId);

    expect((await audit()).filter(item => item.action === 'health_assessment')).toHaveLength(1);
  });
});
