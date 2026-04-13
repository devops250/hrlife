import { redisClient } from '../config/redis';
import { logger } from '../utils/logger';

const QUEUE_KEY = 'followup:queue';

export async function enqueueForFollowup(phone: string, stage: number, message: string): Promise<void> {
  const item = JSON.stringify({ phone, stage, message, queuedAt: new Date().toISOString() });
  await redisClient.rPush(QUEUE_KEY, item);
  logger.info('Lead enfileirado para follow-up', { phone, stage });
}

export interface QueuedFollowup {
  phone: string;
  stage: number;
  message: string;
  queuedAt: string;
}

export async function getQueuedFollowups(): Promise<QueuedFollowup[]> {
  const raw = await redisClient.lRange(QUEUE_KEY, 0, -1);
  await redisClient.del(QUEUE_KEY);
  return raw.map((r) => JSON.parse(r));
}
