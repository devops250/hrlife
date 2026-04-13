import { createClient, RedisClientType } from 'redis';
import { env } from './env';
import { logger } from '../utils/logger';

let redisClient: RedisClientType;

export async function connectRedis(): Promise<RedisClientType> {
  redisClient = createClient({ url: env.REDIS_URL }) as RedisClientType;
  redisClient.on('error', (err) => logger.error('Redis erro', { error: err }));
  await redisClient.connect();
  logger.info('Redis conectado');
  return redisClient;
}

export function getRedisClient(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis não conectado. Chame connectRedis() primeiro.');
  }
  return redisClient;
}

export { redisClient };
