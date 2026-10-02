import { describe, expect, it } from 'vitest';
import { createDemoTelemetry, demoEngine, demoModels } from '../src/demo-data.js';
import { assessEngine, NoUsableTelemetryError, predictRul, validateTelemetry } from '../src/health.js';

describe('engine health domain', () => {
  it('rejects unsafe samples and keeps usable telemetry', () => {
    const rows = createDemoTelemetry();
    rows.push({ ...rows[0], timestamp: '2026-09-30T20:00:00.000Z', exhaustGasTemp: 900 });
    const result = validateTelemetry(rows);
    expect(result.accepted.length).toBe(rows.length - 1);
    expect(result.rejected.length).toBe(1);
    expect(result.anomalies.some(item => item.type === 'range_violation')).toBe(true);
  });

  it('creates component risks and a bounded health score', () => {
    const assessment = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1], 2);
    expect(assessment.healthScore).toBeGreaterThanOrEqual(0);
    expect(assessment.healthScore).toBeLessThanOrEqual(100);
    expect(assessment.componentRisks).toHaveLength(4);
    expect(assessment.dataQuality.usableSamples).toBeGreaterThan(0);
  });

  it('predicts a remaining life interval with evidence', () => {
    const assessment = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1]);
    const prediction = predictRul(demoEngine, assessment, 240, demoModels[1]);
    expect(prediction.lowerBound).toBeLessThanOrEqual(prediction.estimatedRemainingCycles);
    expect(prediction.estimatedRemainingCycles).toBeLessThanOrEqual(prediction.upperBound);
    expect(prediction.evidence.length).toBeGreaterThan(1);
  });

  it('refuses to assess when every raw sample is out of range or illegal', () => {
    const base = createDemoTelemetry()[0];
    const illegal = [
      { ...base, timestamp: '2026-10-01T08:00:00.000Z', exhaustGasTemp: 900 },
      { ...base, timestamp: '2026-10-01T08:10:00.000Z', vibration: 9, oilPressure: 0.2 },
      { ...base, timestamp: '2026-10-01T08:20:00.000Z', fuelFlow: 999 },
    ];
    expect(() => assessEngine(demoEngine, illegal, demoModels[1])).toThrowError(NoUsableTelemetryError);
    try {
      assessEngine(demoEngine, illegal, demoModels[1]);
    } catch (error) {
      expect(error).toBeInstanceOf(NoUsableTelemetryError);
      expect((error as NoUsableTelemetryError).statusCode).toBe(422);
      expect((error as NoUsableTelemetryError).code).toBe('no_usable_telemetry');
      expect((error as NoUsableTelemetryError).details).toEqual({ totalSamples: 3, rejectedSamples: 3 });
    }
  });

  it('refuses to assess when there are no raw samples at all', () => {
    expect(() => assessEngine(demoEngine, [], demoModels[1])).toThrowError(NoUsableTelemetryError);
  });

  it('still assesses when only some of the samples are usable', () => {
    const rows = createDemoTelemetry();
    rows.push({ ...rows[0], timestamp: '2026-09-30T20:00:00.000Z', exhaustGasTemp: 900 });
    const assessment = assessEngine(demoEngine, rows, demoModels[1]);
    expect(assessment.dataQuality.usableSamples).toBe(rows.length - 1);
    expect(assessment.dataQuality.rejectedSamples).toBe(1);
  });

  it('refuses RUL prediction for an assessment without usable samples', () => {
    const bogus = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1]);
    const unusable = { ...bogus, dataQuality: { ...bogus.dataQuality, usableSamples: 0 } };
    expect(() => predictRul(demoEngine, unusable, 240, demoModels[1])).toThrowError(NoUsableTelemetryError);
  });
});
