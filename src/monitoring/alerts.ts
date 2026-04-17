import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { uazapi } from '../whatsapp/uazapi.client';
import { testConnection } from '../database/client';
import { redisClient } from '../config/redis';
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
        "SELECT COUNT(*) as count FROM events WHERE type = 'error' AND created_at >= NOW() - INTERVAL '30 minutes'",
      );
      const errorsRecent = parseInt(errorsResult.rows[0]?.count || '0', 10);
      if (errorsRecent > 3) {
        healthy = false;
        issues.push(`${errorsRecent} erros nos últimos 30min — possível problema sistêmico`);
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
        const cooldownKey = 'alert_cooldown:systemic';
        const inCooldown = await redisClient.get(cooldownKey);
        if (!inCooldown) {
          await sendAlert(issues.join('\n'));
          await redisClient.set(cooldownKey, '1', { EX: 3600 }); // cooldown 1h — evita spam
        }
        consecutiveFailures = 0;
      }
    } else {
      consecutiveFailures = 0;
    }
  } catch (error) {
    logger.error('Erro no check de alertas', { error });
  }
}

async function fetchRDFunnel(): Promise<Record<string, number>> {
  const stages: Record<string, number> = {
    'Contato feito': 0,
    'Agendado pela IA': 0,
    'Estudo Apresentado': 0,
    'Proposta Enviada': 0,
    'Convertido': 0,
    'Sem Retorno': 0,
    'Perdido': 0,
  };

  try {
    const rdToken = env.RDSTATION_API_TOKEN;
    if (!rdToken) return stages;

    const pipelineId = env.RD_PIPELINE_ID;
    const stageIds: Record<string, string> = {
      [env.RD_STAGE_CONTATO_FEITO]: 'Contato feito',
      [env.RD_STAGE_AGENDADO]: 'Agendado pela IA',
      [env.RD_STAGE_ESTUDO_APRESENTADO]: 'Estudo Apresentado',
      [env.RD_STAGE_PROPOSTA_ENVIADA]: 'Proposta Enviada',
      [env.RD_STAGE_CONVERTIDO]: 'Convertido',
      [env.RD_STAGE_SEM_RETORNO]: 'Sem Retorno',
      [env.RD_STAGE_PERDIDO]: 'Perdido',
    };

    // Buscar deals do pipeline
    const res = await fetch(
      `https://crm.rdstation.com/api/v1/deals?token=${rdToken}&deal_pipeline_id=${pipelineId}&limit=200`,
    );
    if (!res.ok) {
      logger.warn('Falha ao buscar funil RD', { status: res.status });
      return stages;
    }

    const data = await res.json() as { deals: Array<{ deal_stage: { _id: string } }> };
    for (const deal of data.deals || []) {
      const stageId = deal.deal_stage?._id;
      const stageName = stageIds[stageId];
      if (stageName) stages[stageName]++;
    }
  } catch (error) {
    logger.warn('Erro ao buscar funil RD (continuando)', { error });
  }

  return stages;
}

async function sendDailySummary(): Promise<void> {
  try {
    const pgOk = await testConnection();
    if (!pgOk) return;

    const [leadsResult, scheduledResult, followupsResult, errorsResult, totalResult, conversionResult] = await Promise.all([
      query("SELECT COUNT(*) as count FROM leads WHERE created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as count FROM leads WHERE scheduled = true AND updated_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as count FROM followup_log WHERE sent_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as count FROM events WHERE type = 'error' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'"),
      query("SELECT COUNT(*) as total, COUNT(rd_contact_id) as synced FROM leads"),
      query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE scheduled = true) as scheduled FROM leads WHERE created_at >= NOW() - INTERVAL '7 days'"),
    ]);

    const leadsToday = parseInt(leadsResult.rows[0]?.count || '0', 10);
    const scheduledToday = parseInt(scheduledResult.rows[0]?.count || '0', 10);
    const followupsToday = parseInt(followupsResult.rows[0]?.count || '0', 10);
    const errorsToday = parseInt(errorsResult.rows[0]?.count || '0', 10);
    const totalLeads = parseInt(totalResult.rows[0]?.total || '0', 10);
    const syncedLeads = parseInt(totalResult.rows[0]?.synced || '0', 10);
    const week7Total = parseInt(conversionResult.rows[0]?.total || '0', 10);
    const week7Scheduled = parseInt(conversionResult.rows[0]?.scheduled || '0', 10);
    const conversionRate = week7Total > 0 ? ((week7Scheduled / week7Total) * 100).toFixed(1) : '0.0';
    const summary = getMetricsSummary();

    // Buscar respostas IA do banco (mais confiável que métrica in-memory que reseta com restart)
    const aiResponsesResult = await query(
      "SELECT COUNT(*) as count FROM events WHERE type = 'ai_response' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
    );
    const aiResponsesToday = parseInt(aiResponsesResult.rows[0]?.count || '0', 10);

    // Buscar tool calls do banco
    const toolCallsResult = await query(
      "SELECT COUNT(*) as count FROM events WHERE type = 'tool_called' AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
    );
    const toolCallsToday = parseInt(toolCallsResult.rows[0]?.count || '0', 10);

    // Buscar funil do RD Station
    const funnel = await fetchRDFunnel();

    const funnelTotal = Object.values(funnel).reduce((a, b) => a + b, 0);

    const message = `📊 Resumo Diário — HR Life SDR (Helena IA)

📈 HOJE
├ 📥 Leads novos: ${leadsToday}
├ 📅 Agendamentos: ${scheduledToday}
├ 🤖 Respostas IA: ${aiResponsesToday}
├ 🔧 Tool calls: ${toolCallsToday}
├ 📤 Follow-ups: ${followupsToday}
├ ❌ Erros: ${errorsToday}
└ ⏱️ Latência IA: ${summary.avg_ai_latency_ms}ms

📊 FUNIL RD STATION (${funnelTotal} deals)
├ 📞 Contato feito: ${funnel['Contato feito']}
├ 📅 Agendado pela IA: ${funnel['Agendado pela IA']}
├ 📋 Estudo Apresentado: ${funnel['Estudo Apresentado']}
├ 📄 Proposta Enviada: ${funnel['Proposta Enviada']}
├ ✅ Convertido: ${funnel['Convertido']}
├ ❌ Sem Retorno: ${funnel['Sem Retorno']}
└ 🚫 Perdido: ${funnel['Perdido']}

📉 MÉTRICAS GERAIS
├ Total leads: ${totalLeads} (${syncedLeads} no CRM)
├ Conversão 7 dias: ${conversionRate}% (${week7Scheduled}/${week7Total})
└ 🧠 Modelo: ${summary.ai_model}

${errorsToday > 0 ? '⚠️ Atenção: houve erros hoje.' : '✅ Dia sem erros.'}`;

    const numbers = env.ALERT_WHATSAPP_NUMBERS.split(',').filter(Boolean);
    for (const number of numbers) {
      try {
        await uazapi.sendText(number.trim(), message);
      } catch (error) {
        logger.error('Falha ao enviar resumo diário', { number, error });
      }
    }

    logger.info('Resumo diário enviado', { leadsToday, scheduledToday, funnel, funnelTotal });
  } catch (error) {
    logger.error('Erro ao gerar resumo diário', { error });
  }
}

/**
 * Notificação instantânea: novo lead entrou no sistema
 */
export async function notifyNewLead(phone: string, name: string, source: string): Promise<void> {
  try {
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const sourceLabel = source === 'meta_form' ? 'Meta Ads' : source === 'pluga' ? 'Pluga' : 'WhatsApp direto';

    const message = `📥 Novo Lead — HR Life SDR

👤 ${name || 'Sem nome'}
📱 ${phone}
📍 Fonte: ${sourceLabel}
🕐 ${now}

A Helena já iniciou o atendimento.`;

    const numbers = env.ALERT_WHATSAPP_NUMBERS.split(',').filter(Boolean);
    for (const number of numbers) {
      try {
        await uazapi.sendText(number.trim(), message);
      } catch (error) {
        logger.error('Falha ao notificar novo lead', { number, error });
      }
    }

    logger.info('Notificação de novo lead enviada', { phone, name, source });
  } catch (error) {
    logger.warn('Erro ao notificar novo lead (não bloqueia)', { phone, error });
  }
}

/**
 * Notificação instantânea: problema detectado em tempo real
 */
export async function notifyProblem(description: string, details?: Record<string, unknown>): Promise<void> {
  try {
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    let message = `🚨 Problema Detectado — HR Life SDR\n\n${description}\n\n🕐 ${now}`;

    if (details) {
      const extra = Object.entries(details)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join('\n');
      message += `\n\nDetalhes:\n${extra}`;
    }

    const numbers = env.ALERT_WHATSAPP_NUMBERS.split(',').filter(Boolean);
    for (const number of numbers) {
      try {
        await uazapi.sendText(number.trim(), message);
      } catch (error) {
        logger.error('Falha ao notificar problema', { number, error });
      }
    }

    await logEvent('problem_notified', undefined, { description, ...details });
    logger.warn('Notificação de problema enviada', { description });
  } catch (error) {
    logger.error('Erro ao notificar problema', { error });
  }
}

/**
 * Notificação: lead agendou reunião
 */
export async function notifyLeadScheduled(phone: string, name: string, dateTime: string): Promise<void> {
  try {
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const message = `📅 Agendamento Confirmado — HR Life SDR

👤 ${name}
📱 ${phone}
🗓️ ${dateTime}
🕐 Registrado: ${now}

O lead já recebeu confirmação com link do Google Meet.`;

    const numbers = env.ALERT_WHATSAPP_NUMBERS.split(',').filter(Boolean);
    for (const number of numbers) {
      try {
        await uazapi.sendText(number.trim(), message);
      } catch (error) {
        logger.error('Falha ao notificar agendamento', { number, error });
      }
    }

    logger.info('Notificação de agendamento enviada', { phone, name, dateTime });
  } catch (error) {
    logger.warn('Erro ao notificar agendamento (não bloqueia)', { phone, error });
  }
}

/**
 * Monitor de saldo Anthropic — faz uma chamada mínima (max_tokens=1) para verificar se a API está funcional.
 * Se retornar "credit balance too low", envia alerta via WhatsApp.
 */
async function checkAnthropicBalance(): Promise<void> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (body.includes('credit balance') || body.includes('too low')) {
        await sendAlert(
          '💰 CRÉDITOS ANTHROPIC ESGOTADOS!\n\n' +
          'A Helena não consegue responder leads.\n' +
          'Acesse console.anthropic.com → Plans & Billing para recarregar.\n\n' +
          `API retornou: ${res.status}`,
        );
        logger.error('Anthropic sem créditos — alerta enviado', { status: res.status });
      } else if (res.status === 401) {
        await sendAlert(
          '🔑 API KEY ANTHROPIC INVÁLIDA!\n\n' +
          'A chave da API foi revogada ou está incorreta.\n' +
          `API retornou: ${res.status}`,
        );
        logger.error('Anthropic API key inválida — alerta enviado', { status: res.status });
      } else {
        logger.warn('Anthropic health check falhou', { status: res.status, body: body.substring(0, 200) });
      }
    } else {
      logger.info('Anthropic health check OK — créditos disponíveis');
    }
  } catch (error) {
    logger.error('Erro ao verificar saldo Anthropic', { error: String(error) });
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

  // Monitor de saldo Anthropic — 09h e 15h São Paulo (12:00 e 18:00 UTC)
  cron.schedule('0 12,18 * * *', () => {
    checkAnthropicBalance().catch((err) => {
      logger.error('Erro ao verificar saldo Anthropic', { error: err });
    });
  });
  logger.info('Monitor de saldo Anthropic registrado (09h e 15h São Paulo)');
}

export { sendAlert };
