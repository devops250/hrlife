import { Request, Response } from 'express';
import { testConnection } from '../database/client';
import { redisClient } from '../config/redis';
import { query } from '../database/client';
import { getLastWebhookTime } from '../database/events.repo';
import { metrics, getAvgResponseTimeMs, getMetricsSummary } from './metrics';
import { isBusinessHours } from '../config/schedule';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { uazapi } from '../whatsapp/uazapi.client';

export async function healthCheck(_req: Request, res: Response): Promise<void> {
  let postgresOk = false;
  let redisOk = false;
  let leadsToday = 0;
  let responsesToday = 0;
  let errorsToday = 0;
  let lastWebhook: string | null = null;
  let followupLastRun: string | null = null;
  let minutesSinceLastWebhook: number | null = null;
  let whatsappStatus: 'connected' | 'disconnected' | 'error' = 'error';
  let whatsappInstance = '';
  let whatsappCircuitBreaker = false;

  try {
    postgresOk = await testConnection();
  } catch {
    postgresOk = false;
  }

  try {
    await redisClient.ping();
    redisOk = true;
  } catch {
    redisOk = false;
  }

  if (postgresOk) {
    try {
      const leadsResult = await query(
        "SELECT COUNT(*) as count FROM leads WHERE created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
      );
      leadsToday = parseInt(leadsResult.rows[0]?.count || '0', 10);

      const responsesResult = await query(
        "SELECT COUNT(*) as count FROM events WHERE type = 'ai_response' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
      );
      responsesToday = parseInt(responsesResult.rows[0]?.count || '0', 10);

      const errorsResult = await query(
        "SELECT COUNT(*) as count FROM events WHERE type = 'error' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
      );
      errorsToday = parseInt(errorsResult.rows[0]?.count || '0', 10);

      const lastWh = await getLastWebhookTime();
      lastWebhook = lastWh ? lastWh.toISOString() : null;
      if (lastWh) {
        minutesSinceLastWebhook = Math.round((Date.now() - lastWh.getTime()) / (1000 * 60));
      }

      const followupResult = await query(
        "SELECT created_at FROM events WHERE type = 'followup_sent' ORDER BY created_at DESC LIMIT 1",
      );
      followupLastRun = followupResult.rows[0]?.created_at?.toISOString() || null;
    } catch (error) {
      logger.warn('Erro ao buscar métricas para health check', { error });
    }
  }

  // Checar WhatsApp (UAZAPI)
  try {
    const wa = await uazapi.checkHealth();
    whatsappStatus = wa.connected ? 'connected' : 'disconnected';
    whatsappInstance = wa.instanceName;
  } catch {
    whatsappStatus = 'error';
  }

  // Checar circuit breaker do Fix 3
  try {
    const flag = await redisClient.get('whatsapp_disconnected');
    whatsappCircuitBreaker = flag !== null;
  } catch { /* best effort */ }

  let status: 'ok' | 'degraded' | 'down' = 'ok';

  if (!postgresOk) {
    status = 'down';
  } else if (!redisOk || errorsToday > 5 || whatsappStatus !== 'connected') {
    status = 'degraded';
  } else if (lastWebhook && isBusinessHours()) {
    const lastWhDate = new Date(lastWebhook);
    const hoursSinceWebhook = (Date.now() - lastWhDate.getTime()) / (1000 * 60 * 60);
    if (hoursSinceWebhook > 1) {
      status = 'degraded';
    }
  }

  const statusCode = status === 'down' ? 503 : status === 'degraded' ? 503 : 200;

  res.status(statusCode).json({
    status,
    postgres: postgresOk ? 'ok' : 'error',
    redis: redisOk ? 'ok' : 'error',
    ai_model: env.ANTHROPIC_MODEL,
    ai_engine: 'anthropic',
    uptime_seconds: Math.floor(process.uptime()),
    last_webhook_received: lastWebhook,
    minutes_since_last_webhook: minutesSinceLastWebhook,
    leads_today: leadsToday,
    responses_today: responsesToday,
    errors_today: errorsToday,
    followup_last_run: followupLastRun,
    avg_response_time_ms: getAvgResponseTimeMs(),
    metrics_live: getMetricsSummary(),
    whatsapp: whatsappStatus,
    whatsapp_instance: whatsappInstance,
    whatsapp_circuit_breaker: whatsappCircuitBreaker,
  });
}
