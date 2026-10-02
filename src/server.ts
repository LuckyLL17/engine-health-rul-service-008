import Fastify from 'fastify';
import cors from '@fastify/cors';
import { assessEngine, maintenanceWindows, NoUsableTelemetryError, predictRul } from './health.js';
import { LocalStore } from './store.js';
import { Engine, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

export async function createApp(store = new LocalStore()) {
  await store.init();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  const findEngine = (id: string) => store.engines.find(item => item.id === id);
  const requireEngine = (id: string): Engine => { const engine = findEngine(id); if (!engine) throw Object.assign(new Error('engine_not_found'), { statusCode: 404, code: 'engine_not_found' }); return engine; };
  const requireAssessment = (id: string): HealthAssessment => { const assessment = store.assessments.find(item => item.engineId === id); if (!assessment) throw Object.assign(new Error('health_assessment_required'), { statusCode: 422, code: 'health_assessment_required' }); return assessment; };
  const requirePrediction = (id: string): RulPrediction => { const prediction = store.predictions.find(item => item.engineId === id); if (!prediction) throw Object.assign(new Error('rul_prediction_required'), { statusCode: 422, code: 'rul_prediction_required' }); return prediction; };
  const findModel = (id?: string): ModelVersion => store.models.find(item => item.id === id) ?? store.models[store.models.length - 1];
  function fail(message: string, statusCode = 404, code = message): never { const error = new Error(message); (error as Error & { statusCode: number; code: string }).statusCode = statusCode; (error as Error & { statusCode: number; code: string }).code = code; throw error; }

  app.get('/api/health', async () => ({ status: 'ok', service: 'engine-health-rul-service', storage: 'local-json', version: '0.1.0' }));
  app.get('/api/models', async () => store.models);
  app.get('/api/engines', async () => store.engines);
  app.post('/api/engines/import', async request => {
    const body = request.body as { engine?: Engine; telemetry?: TelemetrySample[]; maintenance?: MaintenanceEvent[] };
    const targetId: string | undefined = body.engine?.id ?? body.telemetry?.[0]?.engineId ?? body.maintenance?.[0]?.engineId;
    if (!targetId) fail('engine.id is required', 400);
    if (body.engine) {
      if (!findEngine(body.engine.id)) store.addEngine(body.engine);
    } else {
      requireEngine(targetId);
    }
    if (body.telemetry) store.addTelemetry(body.telemetry);
    for (const event of body.maintenance ?? []) store.addMaintenance(event);
    store.log('engine_import', targetId, { telemetry: body.telemetry?.length ?? 0, maintenance: body.maintenance?.length ?? 0 });
    await store.persist();
    return { engine: body.engine ?? findEngine(targetId), importedTelemetry: body.telemetry?.length ?? 0 };
  });
  app.get('/api/engines/:id', async request => { const id = (request.params as { id: string }).id; const engine = requireEngine(id); return { engine, latestAssessment: store.assessments.find(item => item.engineId === id), latestPrediction: store.predictions.find(item => item.engineId === id) }; });
  app.get('/api/engines/:id/telemetry', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const query = request.query as { flightId?: string; limit?: string }; const rows = store.telemetry.filter(item => item.engineId === id && (!query.flightId || item.flightId === query.flightId)); return rows.slice(-(Number(query.limit) || 200)); });
  app.post('/api/engines/:id/health-assessment', async request => {
    const id = (request.params as { id: string }).id;
    const engine = requireEngine(id);
    const body = (request.body ?? {}) as { modelId?: string; flightId?: string };
    const rows = store.telemetry.filter(item => item.engineId === id && (!body.flightId || item.flightId === body.flightId));
    if (!rows.length) fail('telemetry_not_found', 422);
    // assessEngine 会在没有任何合法样本时抛出 NoUsableTelemetryError；
    // 必须先完成评估再触碰引擎状态/存储/审计，避免写入虚假评估
    const assessment = assessEngine(engine, rows, findModel(body.modelId), store.maintenance.filter(item => item.engineId === id).length);
    engine.currentHealthScore = assessment.healthScore;
    engine.status = assessment.status;
    engine.lastAssessmentAt = assessment.createdAt;
    store.addAssessment(assessment);
    store.log('health_assessment', id, { assessmentId: assessment.assessmentId, modelVersion: assessment.modelVersion });
    await store.persist();
    return assessment;
  });
  app.post('/api/engines/:id/rul-prediction', async request => {
    const id = (request.params as { id: string }).id;
    const engine = requireEngine(id);
    const assessment = requireAssessment(id);
    if (assessment.dataQuality.usableSamples < 1) throw new NoUsableTelemetryError({ totalSamples: assessment.sampleCount, rejectedSamples: assessment.dataQuality.rejectedSamples });
    const body = (request.body ?? {}) as { horizonCycles?: number; modelId?: string };
    const prediction = predictRul(engine, assessment, Math.max(30, Math.min(body.horizonCycles ?? 240, 2000)), findModel(body.modelId));
    store.addPrediction(prediction);
    store.log('rul_prediction', id, { predictionId: prediction.predictionId, estimatedRemainingCycles: prediction.estimatedRemainingCycles });
    await store.persist();
    return prediction;
  });
  app.post('/api/engines/:id/replay', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const rows = store.telemetry.filter(item => item.engineId === id).sort((a, b) => a.timestamp.localeCompare(b.timestamp)); const body = (request.body ?? {}) as { speed?: number; cursor?: number }; return { id: `REPLAY-${Date.now()}`, engineId: id, status: 'ready', speed: body.speed ?? 1, cursor: body.cursor ?? 0, eventCount: rows.length, next: rows[body.cursor ?? 0] }; });
  app.post('/api/engines/:id/maintenance-simulation', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const prediction = requirePrediction(id); const body = (request.body ?? {}) as { delayCycles?: number }; const delay = Math.max(0, body.delayCycles ?? 0); return { engineId: id, delayCycles: delay, windows: maintenanceWindows({ ...prediction, estimatedRemainingCycles: prediction.estimatedRemainingCycles - delay, lowerBound: Math.max(1, prediction.lowerBound - delay), upperBound: Math.max(1, prediction.upperBound - delay) }), impact: { additionalRisk: Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100)), recommendation: delay > prediction.lowerBound ? '延后超过寿命下界，不建议执行' : '当前延后仍在可评估范围内' } }; });
  app.post('/api/models/compare', async request => { const body = request.body as { engineId: string; modelIds?: string[] }; const engine = requireEngine(body.engineId); const rows = store.telemetry.filter(item => item.engineId === body.engineId); return (body.modelIds ?? store.models.map(item => item.id)).map(id => { const model = findModel(id); const result = assessEngine(engine, rows, model, store.maintenance.filter(item => item.engineId === engine.id).length); return { modelId: model.id, label: model.label, healthScore: result.healthScore, status: result.status, dataQuality: result.dataQuality.score, degradationSlope: result.indicators.degradationSlope }; }); });
  app.post('/api/maintenance-events', async request => { const event = request.body as MaintenanceEvent; requireEngine(event.engineId); store.addMaintenance(event); store.log('maintenance_event', event.engineId, { eventId: event.id, component: event.component }); await store.persist(); return event; });
  app.get('/api/engines/:id/risk-events', async request => { const id = (request.params as { id: string }).id; return store.assessments.filter(item => item.engineId === id).flatMap(item => item.anomalies); });
  app.get('/api/audit/:engineId', async request => store.audit.filter(item => item.engineId === (request.params as { engineId: string }).engineId));
  app.setErrorHandler((error: Error, _request, reply) => {
    const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
    const code = (error as Error & { code?: string }).code;
    const details = (error as Error & { details?: unknown }).details;
    reply.code(statusCode).send({ error: error.message, ...(code ? { code } : {}), ...(details ? { details } : {}) });
  });
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await createApp();
  await app.listen({ host: '127.0.0.1', port: 6195 });
}
