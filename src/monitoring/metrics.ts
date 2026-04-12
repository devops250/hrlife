import cron from 'node-cron';
import { logger } from '../utils/logger';

export const metrics = {
  webhooksReceived: 0,
  aiResponses: 0,
  followupsSent: 0,
  toolCalls: 0,
  errors: 0,
  totalResponseTimeMs: 0,
  responseCount: 0,
};

export function incrementMetric(key: keyof typeof metrics, value = 1): void {
  metrics[key] += value;
}

export function getAvgResponseTimeMs(): number {
  if (metrics.responseCount === 0) return 0;
  return Math.round(metrics.totalResponseTimeMs / metrics.responseCount);
}

export function startMetricsResetScheduler(): void {
  // Reset à meia-noite (São Paulo)
  cron.schedule('0 3 * * *', () => {
    logger.info('Resetando métricas diárias', { ...metrics, avgResponseTimeMs: getAvgResponseTimeMs() });
    metrics.webhooksReceived = 0;
    metrics.aiResponses = 0;
    metrics.followupsSent = 0;
    metrics.toolCalls = 0;
    metrics.errors = 0;
    metrics.totalResponseTimeMs = 0;
    metrics.responseCount = 0;
  });
}
