import cron from 'node-cron';
import { query } from './client';
import { logger } from '../utils/logger';

/**
 * Limpeza de dados antigos:
 * - Conversas com mais de 30 dias (mantém apenas as últimas 20 por lead)
 * - Eventos com mais de 30 dias
 * - Follow-up logs com mais de 60 dias
 *
 * Executa diariamente às 04:00 UTC (01:00 São Paulo)
 */
async function runCleanup(): Promise<void> {
  try {
    // Conversas: manter apenas últimas 20 por lead + apagar > 30 dias
    const convResult = await query(`
      DELETE FROM conversations
      WHERE id IN (
        SELECT id FROM conversations
        WHERE created_at < NOW() - INTERVAL '30 days'
      )
    `);

    // Eventos: apagar > 30 dias (exceto erros críticos que ficam 90 dias)
    const eventsResult = await query(`
      DELETE FROM events
      WHERE (type != 'error' AND created_at < NOW() - INTERVAL '30 days')
         OR (type = 'error' AND created_at < NOW() - INTERVAL '90 days')
    `);

    // Follow-up logs: apagar > 60 dias
    const fupResult = await query(`
      DELETE FROM followup_log
      WHERE sent_at < NOW() - INTERVAL '60 days'
    `);

    logger.info('Limpeza diária concluída', {
      conversations_deleted: convResult.rowCount,
      events_deleted: eventsResult.rowCount,
      followup_logs_deleted: fupResult.rowCount,
    });
  } catch (error) {
    logger.error('Erro na limpeza diária', { error });
  }
}

export function startCleanupScheduler(): void {
  // Diário às 04:00 UTC (01:00 São Paulo)
  cron.schedule('0 4 * * *', () => {
    runCleanup().catch((err) => logger.error('Erro fatal na limpeza', { error: err }));
  });
  logger.info('Cleanup scheduler registrado (diário às 01:00 SP)');
}
