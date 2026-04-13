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
  // MULTI/EXEC: lRange + del atômicos — evita perda de itens em caso de crash
  const results = await redisClient.multi().lRange(QUEUE_KEY, 0, -1).del(QUEUE_KEY).exec();
  const raw = ((results?.[0] ?? []) as unknown) as string[];
  return raw.map((r) => JSON.parse(r));
}
