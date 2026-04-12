import express from 'express';
import { createClient, RedisClientType } from 'redis';
import { env } from './config/env';
import { logger } from './utils/logger';
import { pool, testConnection } from './database/client';
import { runMigrations } from './database/migrate';
import { healthCheck } from './monitoring/health';
import { dashboardHandler, dashboardPage } from './monitoring/dashboard';
import { handleOAuthStart, handleOAuthCallback } from './scheduling/google-oauth';
import { whatsappHandler } from './webhook/whatsapp.handler';
import { formHandler } from './webhook/form.handler';
import { plugaHandler } from './webhook/pluga.handler';
import { startFollowupScheduler } from './followup/scheduler';
import { startAlertScheduler, sendAlert } from './monitoring/alerts';
import { startMetricsResetScheduler } from './monitoring/metrics';
import { startCleanupScheduler } from './database/cleanup';

export let redisClient: RedisClientType;

async function start(): Promise<void> {
  logger.info('Iniciando HR Life SDR...', { port: env.PORT, env: env.NODE_ENV });

  // Testar Postgres
  const pgOk = await testConnection();
  if (!pgOk) {
    logger.error('Não foi possível conectar ao PostgreSQL. Abortando.');
    process.exit(1);
  }
  logger.info('PostgreSQL conectado');

  // Conectar Redis
  redisClient = createClient({ url: env.REDIS_URL }) as RedisClientType;
  redisClient.on('error', (err) => logger.error('Redis erro', { error: err }));
  await redisClient.connect();
  logger.info('Redis conectado');

  // Rodar migrations
  await runMigrations();
  logger.info('Migrations aplicadas');

  // Express
  const app = express();
  app.use(express.json());

  // Routes
  app.get('/health', healthCheck);
  app.get('/dashboard', dashboardPage);
  app.get('/dashboard/api', dashboardHandler);

  // Google Calendar OAuth2
  app.get('/oauth2/google', handleOAuthStart);
  app.get('/oauth2/callback', handleOAuthCallback);

  // Webhooks
  app.post('/sdr', whatsappHandler);
  app.post('/form', formHandler);
  app.post('/webhook/pluga', plugaHandler);
  app.get('/webhook/pluga/test', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), message: 'Webhook Pluga ativo' });
  });

  // Cron jobs
  startFollowupScheduler();
  startAlertScheduler();
  startMetricsResetScheduler();
  startCleanupScheduler();

  app.listen(env.PORT, () => {
    logger.info(`Server rodando na porta ${env.PORT}`);
  });
}

start().catch((err) => {
  logger.error('Erro fatal no startup', { error: err });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recebido, encerrando...');
  await redisClient?.quit();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recebido, encerrando...');
  await redisClient?.quit();
  await pool.end();
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  try {
    await sendAlert(`Erro crítico não tratado: ${err.message}`);
  } catch { /* best effort */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
});
