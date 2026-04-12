import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { buildSystemPrompt } from './prompt';
import { TOOLS } from './tools';
import { getHistory, addMessage } from '../database/conversations.repo';
import { findLeadByPhone, updateLeadIaMessage, updateLeadData } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { uazapi, NotOnWhatsAppError } from '../whatsapp/uazapi.client';
import { query } from '../database/client';
import { getSaoPauloNow } from '../config/schedule';
import { getNextAvailableSlots } from '../scheduling/availability';
import { createEvent, deleteEvent, updateEvent, findEventByLeadName, listEvents } from '../scheduling/calendar.service';
import { syncLeadCreated, syncLeadScheduled } from '../crm/sync';
import { incrementMetric, trackToolCall, trackAiLatency } from '../monitoring/metrics';
import { syncOutgoingMessage } from '../chatwoot/sync';
import { notifyProblem, notifyLeadScheduled } from '../monitoring/alerts';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const TIMEOUT_MS = 30000;
const TIMEOUT_MESSAGE = 'Desculpe, estou com lentidão. Pode repetir sua mensagem?';
const FALLBACK_MESSAGE = 'Nosso sistema está temporariamente indisponível. Um de nossos especialistas vai entrar em contato com você em breve. Pedimos desculpas pelo inconveniente! 🙏';

export async function processConversation(phone: string, chatInput: string): Promise<void> {
  const startTime = Date.now();

  try {
    const lead = await findLeadByPhone(phone);
    if (!lead) {
      logger.error('Lead não encontrado no engine', { phone });
      return;
    }

    if (lead.status === 'paused') {
      logger.info('Lead pausado, engine não processa', { phone });
      return;
    }

    const history = await getHistory(phone, 20);
    const now = getSaoPauloNow();
    const dateStr = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const systemPrompt = buildSystemPrompt(lead.name || '', dateStr);

    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: chatInput },
    ];

    await addMessage(phone, 'user', chatInput);

    let response: Anthropic.Message;
    try {
      response = await callClaudeWithTimeout(systemPrompt, messages);
    } catch (aiError) {
      logger.error('Claude API falhou, enviando fallback', { phone, error: String(aiError) });
      await logEvent('error', phone, { ai_fallback: true, error: String(aiError) });
      incrementMetric('errors');
      await addMessage(phone, 'assistant', FALLBACK_MESSAGE);
      await uazapi.sendText(phone, FALLBACK_MESSAGE);
      notifyProblem('Claude API falhou — fallback enviado ao lead', { phone, erro: String(aiError).substring(0, 200) }).catch(() => {});
      return;
    }

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolBlock of toolUseBlocks) {
        const args = toolBlock.input as Record<string, string>;
        const result = await executeTool(toolBlock.name, args, phone);

        await logEvent('tool_called', phone, {
          tool: toolBlock.name,
          args,
          result: result.substring(0, 500),
        });
        trackToolCall(toolBlock.name);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (Date.now() - startTime > TIMEOUT_MS) {
        await uazapi.sendText(phone, TIMEOUT_MESSAGE);
        logger.warn('Timeout no engine', { phone, elapsed: Date.now() - startTime });
        return;
      }

      try {
        response = await callClaudeWithTimeout(systemPrompt, messages);
      } catch (aiError) {
        logger.error('Claude API falhou no loop de tools, enviando fallback', { phone, error: String(aiError) });
        await logEvent('error', phone, { ai_fallback: true, error: String(aiError) });
        incrementMetric('errors');
        await addMessage(phone, 'assistant', FALLBACK_MESSAGE);
        await uazapi.sendText(phone, FALLBACK_MESSAGE);
        notifyProblem('Claude API falhou no loop de tools', { phone, erro: String(aiError).substring(0, 200) }).catch(() => {});
        return;
      }
    }

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    let text = textBlock?.text || '';
    text = text.replace(/\n{2,}/g, '\n');

    if (!text) {
      logger.warn('Resposta vazia do Claude', { phone });
      return;
    }

    await addMessage(phone, 'assistant', text);
    await updateLeadIaMessage(phone);

    const latency = Date.now() - startTime;
    trackAiLatency(latency);
    await logEvent('ai_response', phone, { latency_ms: latency, model: env.ANTHROPIC_MODEL });
    incrementMetric('aiResponses');
    incrementMetric('totalResponseTimeMs', latency);
    incrementMetric('responseCount');

    syncOutgoingMessage(phone, text).catch((err) =>
      logger.warn('Chatwoot sync outgoing falhou', { phone, error: err }),
    );

    try {
      await uazapi.sendText(phone, text);
      logger.info('Resposta enviada', { phone, latency_ms: latency });
    } catch (sendError) {
      if (sendError instanceof NotOnWhatsAppError) {
        await query("UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1", [phone]);
        await logEvent('lead_invalid_phone', phone);
        logger.warn('Número não está no WhatsApp, lead marcado como invalid_phone', { phone });
      } else {
        logger.error('Falha ao enviar resposta via UAZAPI (conversa salva no DB)', { phone, error: sendError });
        await logEvent('error', phone, { send_failed: true, error: String(sendError), latency_ms: latency });
        incrementMetric('errors');
      }
    }
  } catch (error) {
    const latency = Date.now() - startTime;
    logger.error('Erro no engine de conversa', { phone, error, latency_ms: latency });
    await logEvent('error', phone, { engine: true, error: String(error), latency_ms: latency });
    incrementMetric('errors');
  }
}

async function callClaudeWithTimeout(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  return anthropic.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: TOOLS,
    temperature: 0.3,
  });
}

async function executeTool(name: string, args: Record<string, string>, phone: string): Promise<string> {
  logger.info(`Executando tool: ${name}`, { phone, args });

  switch (name) {
    case 'cadastra_lead':
      return await execCadastraLead(args, phone);

    case 'consulta_horario':
      return await execConsultaHorario(args);

    case 'registra_agendamento':
      return await execRegistraAgendamento(args, phone);

    case 'cancela_agendamento':
      return await execCancelaAgendamento(args, phone);

    case 'update_agendamento':
      return await execUpdateAgendamento(args, phone);

    default:
      logger.warn(`Tool desconhecida: ${name}`, { phone });
      return `Tool "${name}" não encontrada.`;
  }
}

// Dedup: evitar cadastra_lead duplicada na mesma fase
const recentCadastro = new Map<string, number>();

async function execCadastraLead(args: Record<string, string>, phone: string): Promise<string> {
  // Validar nome
  const invalidNames = ['cliente', 'lead', 'usuário', 'usuario', 'olá', 'ola', ''];
  if (invalidNames.includes(args.nome_completo?.toLowerCase()?.trim())) {
    return 'Nome inválido. Pergunte o nome completo do lead antes de cadastrar.';
  }

  // Dedup: se já chamou nos últimos 30s com mesmo agendado, pular
  const dedupeKey = `${phone}:${args.agendado}`;
  const lastCall = recentCadastro.get(dedupeKey);
  if (lastCall && Date.now() - lastCall < 30000) {
    logger.info('cadastra_lead duplicada ignorada', { phone, agendado: args.agendado });
    return `Dados de ${args.nome_completo} já registrados.`;
  }
  recentCadastro.set(dedupeKey, Date.now());

  try {
    await updateLeadData(phone, {
      name: args.nome_completo || undefined,
      birth_date: args.data_nascimento || undefined,
      cpf: args.cpf || undefined,
      height: args.altura || undefined,
      weight: args.peso || undefined,
      profession: args.profissao || undefined,
      income: args.renda_mensal || undefined,
      smoker: args.fumante || undefined,
      scheduled: args.agendado === 'true',
    });

    const status = args.agendado === 'true' ? 'agendado' : 'cadastrado';
    logger.info(`Lead ${status}`, { phone, nome: args.nome_completo });

    const lead = await findLeadByPhone(phone);
    if (lead) {
      if (args.agendado === 'true') {
        syncLeadScheduled(lead).catch((err) => logger.error('CRM sync async falhou', { phone, error: err }));
      } else {
        syncLeadCreated(lead).catch((err) => logger.error('CRM sync async falhou', { phone, error: err }));
      }
    }

    return `Lead ${args.nome_completo} ${status} com sucesso no sistema.`;
  } catch (error) {
    logger.error('Erro ao cadastrar lead', { phone, error });
    return 'Erro ao cadastrar dados. Os dados foram recebidos e serão processados.';
  }
}

async function execConsultaHorario(args: Record<string, string>): Promise<string> {
  try {
    const period = args.periodo as 'manha' | 'tarde' | 'noite';
    const slots = await getNextAvailableSlots(period, 3);

    const periodNames = { manha: 'manhã', tarde: 'tarde', noite: 'noite' };
    const periodName = periodNames[period] || period;

    if (slots.length === 0) {
      return `Não há horários disponíveis no período da ${periodName} nos próximos 14 dias. Sugira outro período ao lead.`;
    }

    const formatted = slots.map((s, i) => `${i + 1}. ${s.formatted}`).join('\n');
    return `Horários disponíveis (${periodName}):\n${formatted}\n\nApresente estas opções ao lead.`;
  } catch (error) {
    logger.error('Erro ao consultar horários', { error });
    return 'Erro ao consultar horários. Peça desculpas ao lead e tente novamente.';
  }
}

async function execRegistraAgendamento(args: Record<string, string>, phone: string): Promise<string> {
  try {
    const { data, horario, nome_lead } = args;
    const startDateTime = `${data}T${horario}:00`;
    const endHour = parseInt(horario.split(':')[0], 10) + 1;
    const endDateTime = `${data}T${String(endHour).padStart(2, '0')}:${horario.split(':')[1]}:00`;

    // Double-check: verificar se o slot ainda está disponível antes de criar
    const slotStart = new Date(`${data}T${horario}:00-03:00`);
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const checkStart = new Date(slotStart.getTime() - 60 * 60 * 1000);
    const checkEnd = new Date(slotEnd.getTime() + 60 * 60 * 1000);
    const existingEvents = await listEvents(checkStart, checkEnd);
    const conflict = existingEvents.find((e) =>
      e.start.getTime() < slotEnd.getTime() && e.end.getTime() > slotStart.getTime(),
    );
    if (conflict) {
      logger.warn('Slot ocupado no momento do registro', { phone, data, horario, conflict: conflict.summary });
      return `O horário ${horario} do dia ${data} acabou de ser ocupado. Por favor, chame consulta_horario novamente para oferecer horários atualizados ao lead.`;
    }

    const event = await createEvent({
      summary: `HR Life - ${nome_lead}`,
      description: `Apresentação de proteção familiar e financeira para ${nome_lead}.\nTelefone: ${phone}`,
      startDateTime,
      endDateTime,
    });

    await updateLeadData(phone, {
      scheduled: true,
      scheduled_at: new Date(`${data}T${horario}:00-03:00`),
    });

    const meetInfo = event.meetLink ? `\nLink do Google Meet: ${event.meetLink}` : '';

    // Notificar Gabriel sobre agendamento
    notifyLeadScheduled(phone, nome_lead, `${data} às ${horario}`).catch(() => {});

    return `Agendamento confirmado para ${nome_lead} em ${data} às ${horario}.${meetInfo}\nID do evento: ${event.id}`;
  } catch (error) {
    logger.error('Erro ao registrar agendamento', { phone, error });
    return 'Erro ao registrar agendamento. Peça desculpas ao lead e tente novamente.';
  }
}

async function execCancelaAgendamento(args: Record<string, string>, phone: string): Promise<string> {
  try {
    const event = await findEventByLeadName(args.nome_lead);
    if (!event) {
      return `Não foi encontrado agendamento para ${args.nome_lead}.`;
    }

    await deleteEvent(event.id);
    await updateLeadData(phone, { scheduled: false, scheduled_at: null });

    return `Agendamento de ${args.nome_lead} cancelado com sucesso.`;
  } catch (error) {
    logger.error('Erro ao cancelar agendamento', { phone, error });
    return 'Erro ao cancelar agendamento. Peça desculpas ao lead e tente novamente.';
  }
}

async function execUpdateAgendamento(args: Record<string, string>, phone: string): Promise<string> {
  try {
    const event = await findEventByLeadName(args.nome_lead);
    if (!event) {
      return `Não foi encontrado agendamento para ${args.nome_lead} para reagendar.`;
    }

    const { nova_data, novo_horario } = args;
    const startDateTime = `${nova_data}T${novo_horario}:00`;
    const endHour = parseInt(novo_horario.split(':')[0], 10) + 1;
    const endDateTime = `${nova_data}T${String(endHour).padStart(2, '0')}:${novo_horario.split(':')[1]}:00`;

    const updated = await updateEvent(event.id, { startDateTime, endDateTime });
    await updateLeadData(phone, {
      scheduled_at: new Date(`${nova_data}T${novo_horario}:00-03:00`),
    });

    const meetInfo = updated.meetLink ? `\nLink do Google Meet: ${updated.meetLink}` : '';
    return `Agendamento de ${args.nome_lead} reagendado para ${nova_data} às ${novo_horario}.${meetInfo}`;
  } catch (error) {
    logger.error('Erro ao reagendar', { phone, error });
    return 'Erro ao reagendar. Peça desculpas ao lead e tente novamente.';
  }
}
