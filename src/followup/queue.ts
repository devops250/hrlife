import { redisClient } from '../config/redis';
import { logger } from '../utils/logger';

const PREFIX = 'followup:pending:';
const TTL_SECONDS = 12 * 60 * 60; // 12h

export async function enqueueForFollowup(phone: string, stage: number, message: string): Promise<void> {
  const key = `${PREFIX}${phone}`;
  const value = JSON.stringify({ phone, stage, message, queuedAt: new Date().toISOString() });
  const wasSet = await redisClient.set(key, value, { NX: true, EX: TTL_SECONDS });
  if (wasSet) {
    logger.info('Lead enfileirado para follow-up', { phone, stage });
  } else {
    logger.debug('Lead já está na fila (dedup), ignorando', { phone, stage });
  }
}

export interface QueuedFollowup {
  phone: string;
  stage: number;
  message: string;
  queuedAt: string;
}

export async function getQueuedFollowups(): Promise<QueuedFollowup[]> {
  const keys = await redisClient.keys(`${PREFIX}*`);
  if (keys.length === 0) return [];

  const items: QueuedFollowup[] = [];
  for (const key of keys) {
    const value = await redisClient.get(key);
    if (value) {
      items.push(JSON.parse(value));
      await redisClient.del(key);
    }
  }

  return items;
}
