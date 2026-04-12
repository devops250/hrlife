import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
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
import { createEvent, deleteEvent, updateEvent, findEventByLeadName } from '../scheduling/calendar.service';
import { syncLeadCreated, syncLeadScheduled } from '../crm/sync';
import { incrementMetric } from '../monitoring/metrics';
import { syncOutgoingMessage } from '../chatwoot/sync';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const TIMEOUT_MS = 30000;
const TIMEOUT_MESSAGE = 'Desculpe, estou com lentidão. Pode repetir sua mensagem?';

export async function processConversation(phone: string, chatInput: string): Promise<void> {
  const startTime = Date.now();

  try {
    const lead = await findLeadByPhone(phone);
    if (!lead) {
      logger.error('Lead não encontrado no engine', { phone });
      return;
    }

    // Verificar se lead foi pausado (Rodrigo assumiu atendimento)
    if (lead.status === 'paused') {
      logger.info('Lead pausado, engine não processa', { phone });
      return;
    }

    // Histórico
    const history = await getHistory(phone, 20);
    const now = getSaoPauloNow();
    const dateStr = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // Montar mensagens
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(lead.name || '', dateStr) },
      ...history.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: chatInput },
    ];

    // Salvar mensagem do usuário
    await addMessage(phone, 'user', chatInput);

    // Loop de chamadas OpenAI com tool calls
    let response = await callOpenAIWithTimeout(messages);
    let choice = response.choices[0]?.message;

    while (choice?.tool_calls && choice.tool_calls.length > 0) {
      // Adicionar resposta do assistant com tool_calls
      messages.push(choice as ChatCompletionMessageParam);

      // Executar cada tool
      for (const toolCall of choice.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const fn = toolCall.function;
        const args = JSON.parse(fn.arguments);
        const result = await executeTool(fn.name, args, phone);

        await logEvent('tool_called', phone, {
          tool: fn.name,
          args,
          result: result.substring(0, 500),
        });
        incrementMetric('toolCalls');

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Verificar timeout
      if (Date.now() - startTime > TIMEOUT_MS) {
        await uazapi.sendText(phone, TIMEOUT_MESSAGE);
        logger.warn('Timeout no engine', { phone, elapsed: Date.now() - startTime });
        return;
      }

      // Re-chamar OpenAI
      response = await callOpenAIWithTimeout(messages);
      choice = response.choices[0]?.message;
    }

    // Extrair texto final
    let text = choice?.content || '';
    text = text.replace(/\n{2,}/g, '\n');

    if (!text) {
      logger.warn('Resposta vazia da OpenAI', { phone });
      return;
    }

    // Salvar conversa ANTES de enviar (não perder se envio falhar)
    await addMessage(phone, 'assistant', text);
    await updateLeadIaMessage(phone);

    const latency = Date.now() - startTime;
    await logEvent('ai_response', phone, { latency_ms: latency });
    incrementMetric('aiResponses');
    incrementMetric('totalResponseTimeMs', latency);
    incrementMetric('responseCount');

    // Espelhar no Chatwoot
    syncOutgoingMessage(phone, text).catch((err) =>
      logger.warn('Chatwoot sync outgoing falhou', { phone, error: err }),
    );

    // Enviar via UAZAPI (separado do try principal)
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

async function callOpenAIWithTimeout(messages: ChatCompletionMessageParam[]) {
  return openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.3,
    messages,
    tools: TOOLS,
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

async function execCadastraLead(args: Record<string, string>, phone: string): Promise<string> {
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

    // Sync com RD Station (assíncrono, não bloqueia a resposta)
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
