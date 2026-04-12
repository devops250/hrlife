import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { uazapi } from '../whatsapp/uazapi.client';
import { testConnection } from '../database/client';
import { redisClient } from '../index';
import { query } from '../database/client';
import { isBusinessHours } from '../config/schedule';
import { logEvent, getLastWebhookTime } from '../database/events.repo';
import { metrics, getMetricsSummary } from './metrics';

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

        // Check nenhum lead processado nas últimas 6h em dia útil
        const now = new Date();
        const dayOfWeek = now.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          const noLeadsResult = await query(
            "SELECT COUNT(*) as count FROM events WHERE type = 'ai_response' AND created_at >= NOW() - INTERVAL '6 hours'",
          );
          const recentResponses = parseInt(noLeadsResult.rows[0]?.count || '0', 10);
          if (recentResponses === 0) {
            issues.push('Nenhum lead processado nas últimas 6h (horário comercial)');
          }
        }
      }

      // Check latência alta consecutiva
      if (metrics.consecutiveHighLatency >= 3) {
        healthy = false;
        issues.push(`Latência da IA > 15s por ${metrics.consecutiveHighLatency} chamadas consecutivas`);
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

async function sendDailySummary(): Promise<void> {
  try {
    const pgOk = await testConnection();
    if (!pgOk) return;

    const [leadsResult, scheduledResult, followupsResult, errorsResult] = await Promise.all([
      query("SELECT COUNT(*) as count FROM leads WHERE created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as count FROM leads WHERE scheduled = true AND updated_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as count FROM followup_log WHERE sent_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as count FROM events WHERE type = 'error' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
    ]);

    const leadsToday = parseInt(leadsResult.rows[0]?.count || '0', 10);
    const scheduledToday = parseInt(scheduledResult.rows[0]?.count || '0', 10);
    const followupsToday = parseInt(followupsResult.rows[0]?.count || '0', 10);
    const errorsToday = parseInt(errorsResult.rows[0]?.count || '0', 10);
    const summary = getMetricsSummary();

    const message = `📊 Resumo Diário — HR Life SDR (Helena IA)

📥 Leads novos: ${leadsToday}
📅 Agendamentos: ${scheduledToday}
🤖 Respostas IA: ${summary.ai_responses}
🔧 Tool calls: ${summary.tool_calls}
📤 Follow-ups: ${followupsToday}
❌ Erros: ${errorsToday}
⏱️ Latência média IA: ${summary.avg_ai_latency_ms}ms
🧠 Modelo: ${summary.ai_model}

${errorsToday > 0 ? '⚠️ Atenção: houve erros hoje. Verificar logs.' : '✅ Sem erros hoje.'}`;

    const numbers = env.ALERT_WHATSAPP_NUMBERS.split(',').filter(Boolean);
    for (const number of numbers) {
      try {
        await uazapi.sendText(number.trim(), message);
      } catch (error) {
        logger.error('Falha ao enviar resumo diário', { number, error });
      }
    }

    logger.info('Resumo diário enviado', { leadsToday, scheduledToday, followupsToday, errorsToday });
  } catch (error) {
    logger.error('Erro ao gerar resumo diário', { error });
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

  // Resumo diário às 20h (São Paulo = 23:00 UTC)
  cron.schedule('0 23 * * *', () => {
    sendDailySummary().catch((err) => {
      logger.error('Erro ao enviar resumo diário', { error: err });
    });
  });
  logger.info('Resumo diário registrado (20h São Paulo)');
}

export { sendAlert };
