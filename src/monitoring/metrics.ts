import cron from 'node-cron';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export const metrics = {
  webhooksReceived: 0,
  aiResponses: 0,
  followupsSent: 0,
  toolCalls: 0,
  errors: 0,
  totalResponseTimeMs: 0,
  responseCount: 0,
  // Novas métricas
  toolCallsByType: {} as Record<string, number>,
  rdSyncSuccess: 0,
  rdSyncFailed: 0,
  consecutiveHighLatency: 0,
  lastAiLatencies: [] as number[],
};

export function incrementMetric(key: keyof typeof metrics, value = 1): void {
  const current = metrics[key];
  if (typeof current === 'number') {
    (metrics as Record<string, unknown>)[key] = current + value;
  }
}

export function trackToolCall(toolName: string): void {
  metrics.toolCallsByType[toolName] = (metrics.toolCallsByType[toolName] || 0) + 1;
  metrics.toolCalls += 1;
}

export function trackAiLatency(latencyMs: number): void {
  metrics.lastAiLatencies.push(latencyMs);
  if (metrics.lastAiLatencies.length > 10) {
    metrics.lastAiLatencies.shift();
  }
  if (latencyMs > 15000) {
    metrics.consecutiveHighLatency++;
  } else {
    metrics.consecutiveHighLatency = 0;
  }
}

export function trackRdSync(success: boolean): void {
  if (success) {
    metrics.rdSyncSuccess++;
  } else {
    metrics.rdSyncFailed++;
  }
}

export function getAvgResponseTimeMs(): number {
  if (metrics.responseCount === 0) return 0;
  return Math.round(metrics.totalResponseTimeMs / metrics.responseCount);
}

export function getAvgAiLatencyMs(): number {
  if (metrics.lastAiLatencies.length === 0) return 0;
  const sum = metrics.lastAiLatencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / metrics.lastAiLatencies.length);
}

export function getMetricsSummary() {
  return {
    webhooks: metrics.webhooksReceived,
    ai_responses: metrics.aiResponses,
    followups: metrics.followupsSent,
    tool_calls: metrics.toolCalls,
    tool_calls_by_type: { ...metrics.toolCallsByType },
    errors: metrics.errors,
    avg_response_time_ms: getAvgResponseTimeMs(),
    avg_ai_latency_ms: getAvgAiLatencyMs(),
    rd_sync: { success: metrics.rdSyncSuccess, failed: metrics.rdSyncFailed },
    ai_model: env.ANTHROPIC_MODEL,
    consecutive_high_latency: metrics.consecutiveHighLatency,
  };
}

export function startMetricsResetScheduler(): void {
  // Reset à meia-noite (São Paulo = 03:00 UTC)
  cron.schedule('0 3 * * *', () => {
    logger.info('Resetando métricas diárias', {
      ...getMetricsSummary(),
    });
    metrics.webhooksReceived = 0;
    metrics.aiResponses = 0;
    metrics.followupsSent = 0;
    metrics.toolCalls = 0;
    metrics.errors = 0;
    metrics.totalResponseTimeMs = 0;
    metrics.responseCount = 0;
    metrics.toolCallsByType = {};
    metrics.rdSyncSuccess = 0;
    metrics.rdSyncFailed = 0;
    metrics.consecutiveHighLatency = 0;
    metrics.lastAiLatencies = [];
  });
}
