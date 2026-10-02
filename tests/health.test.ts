import { describe, expect, it } from 'vitest';
import { createDemoTelemetry, demoEngine, demoModels } from '../src/demo-data.js';
import { assessEngine, predictRul, validateTelemetry } from '../src/health.js';

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

  it('refuses to assess when no sample survives validation', () => {
    const rows = createDemoTelemetry().map((item, index) => index % 2 === 0
      ? { ...item, exhaustGasTemp: 900 }
      : { ...item, vibration: Number.NaN });
    expect(validateTelemetry(rows).accepted).toHaveLength(0);
    expect(() => assessEngine(demoEngine, rows, demoModels[1])).toThrowError('no_usable_telemetry');
  });

  it('assesses partially valid telemetry with reduced data quality', () => {
    const rows = createDemoTelemetry();
    rows.push({ ...rows[0], timestamp: '2026-09-30T20:00:00.000Z', exhaustGasTemp: 900 });
    const assessment = assessEngine(demoEngine, rows, demoModels[1]);
    expect(assessment.dataQuality.usableSamples).toBe(rows.length - 1);
    expect(assessment.dataQuality.rejectedSamples).toBe(1);
    expect(assessment.dataQuality.score).toBeLessThan(100);
  });

  it('refuses to predict from an assessment without usable samples', () => {
    const assessment = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1]);
    const bogus = { ...assessment, dataQuality: { ...assessment.dataQuality, usableSamples: 0 } };
    expect(() => predictRul(demoEngine, bogus, 240, demoModels[1])).toThrowError('no_usable_telemetry');
  });

  it('predicts a remaining life interval with evidence', () => {
    const assessment = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1]);
    const prediction = predictRul(demoEngine, assessment, 240, demoModels[1]);
    expect(prediction.lowerBound).toBeLessThanOrEqual(prediction.estimatedRemainingCycles);
    expect(prediction.estimatedRemainingCycles).toBeLessThanOrEqual(prediction.upperBound);
    expect(prediction.evidence.length).toBeGreaterThan(1);
  });
});
