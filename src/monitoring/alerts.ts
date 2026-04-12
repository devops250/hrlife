import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { uazapi } from '../whatsapp/uazapi.client';
import { testConnection } from '../database/client';
import { redisClient } from '../index';
import { query } from '../database/client';
import { isBusinessHours } from '../config/schedule';
import { logEvent, getLastWebhookTime } from '../database/events.repo';

let consecutiveFailures = 0;

async function sendAlert(message: string): Promise<void> {
  const numbers = env.ALERT_WHATSAPP_NUMBERS.split(',').filter(Boolean);
  const alertText = `⚠️ ALERTA HR Life SDR\n\n${message}\n\nHora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;

  for (const number of numbers) {
    try {
      await uazapi.sendText(number.trim(), alertText);
    } catch (error) {
      logger.error('Falha ao enviar alerta WhatsApp', { number, error });
    }
  }

  await logEvent('alert_sent', undefined, { message });
  logger.warn('Alerta enviado', { message, recipients: numbers.length });
}

async function checkAndAlert(): Promise<void> {
  try {
    let healthy = true;
    const issues: string[] = [];

    // Check Postgres
    const pgOk = await testConnection();
    if (!pgOk) {
      healthy = false;
      issues.push('PostgreSQL está fora do ar');
    }

    // Check Redis
    try {
      await redisClient.ping();
    } catch {
      healthy = false;
      issues.push('Redis está fora do ar');
    }

    // Check erros do dia
    if (pgOk) {
      const errorsResult = await query(
        "SELECT COUNT(*) as count FROM events WHERE type = 'error' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
      );
      const errorsToday = parseInt(errorsResult.rows[0]?.count || '0', 10);
      if (errorsToday > 5) {
        healthy = false;
        issues.push(`${errorsToday} erros hoje — possível problema sistêmico`);
      }

      // Check em horário comercial
      if (isBusinessHours()) {
        // Check leads sem resposta há 3+ minutos
        const stuckResult = await query(
          `SELECT phone FROM leads
           WHERE status = 'active'
             AND has_lead_replied = false
             AND last_lead_message IS NOT NULL
             AND last_ia_message IS NULL
             AND last_lead_message < NOW() - INTERVAL '3 minutes'
           LIMIT 5`,
        );
        if (stuckResult.rows.length > 0) {
          const phones = stuckResult.rows.map((r: { phone: string }) => r.phone).join(', ');
          healthy = false;
          issues.push(`${stuckResult.rows.length} lead(s) sem resposta da IA há 3+ min: ${phones}`);
        }
      }
    }

    if (!healthy) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        await sendAlert(issues.join('\n'));
        consecutiveFailures = 0;
      }
    } else {
      consecutiveFailures = 0;
    }
  } catch (error) {
    logger.error('Erro no check de alertas', { error });
  }
}

export function startAlertScheduler(): void {
  // Check a cada 2 minutos
  cron.schedule('*/2 * * * *', () => {
    checkAndAlert().catch((err) => {
      logger.error('Erro fatal no alert scheduler', { error: err });
    });
  });
  logger.info('Alert scheduler registrado (a cada 2 minutos)');
}

// Exportar para uso externo (uncaught exceptions)
export { sendAlert };
