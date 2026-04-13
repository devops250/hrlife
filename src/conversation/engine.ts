/**
 * Conversation Engine — Responsável APENAS por:
 * 1. Montar contexto (histórico + system prompt)
 * 2. Chamar Claude
 * 3. Loop de tool calls (delega execução ao tool-executor)
 * 4. Enviar resposta via WhatsApp
 *
 * NÃO faz: CRM sync, agendamento, validações de negócio (isso é do tool-executor)
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { buildSystemPrompt } from './prompt';
import { TOOLS } from './tools';
import { executeTool } from './tool-executor';
import { getHistory, addMessage } from '../database/conversations.repo';
import { findLeadByPhone, updateLeadIaMessage } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { uazapi, NotOnWhatsAppError } from '../whatsapp/uazapi.client';
import { query } from '../database/client';
import { getSaoPauloNow } from '../config/schedule';
import { incrementMetric, trackAiLatency } from '../monitoring/metrics';
import { syncOutgoingMessage } from '../chatwoot/sync';
import { notifyProblem } from '../monitoring/alerts';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const TIMEOUT_MS = 60000;
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

    // Validar que chatInput não está vazio (evitar erro 400 do Claude)
    if (!chatInput || !chatInput.trim()) {
      logger.warn('Mensagem vazia recebida, ignorando', { phone });
      return;
    }

    // Montar contexto
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

    // Chamar Claude (com fallback)
    let response: Anthropic.Message;
    try {
      response = await callClaude(systemPrompt, messages);
    } catch (aiError) {
      await handleAiFailure(phone, aiError);
      return;
    }

    // Loop de tool calls
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

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      // Timeout check
      if (Date.now() - startTime > TIMEOUT_MS) {
        await uazapi.sendText(phone, TIMEOUT_MESSAGE);
        logger.warn('Timeout no engine', { phone, elapsed: Date.now() - startTime });
        return;
      }

      // Re-chamar Claude
      try {
        response = await callClaude(systemPrompt, messages);
      } catch (aiError) {
        await handleAiFailure(phone, aiError);
        return;
      }
    }

    // Extrair e enviar resposta
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    let text = textBlock?.text || '';
    text = text.replace(/\n{2,}/g, '\n');

    if (!text) {
      logger.warn('Resposta vazia do Claude', { phone });
      return;
    }

    // Salvar conversa
    await addMessage(phone, 'assistant', text);
    await updateLeadIaMessage(phone);

    // Métricas
    const latency = Date.now() - startTime;
    trackAiLatency(latency);
    await logEvent('ai_response', phone, { latency_ms: latency, model: env.ANTHROPIC_MODEL });
    incrementMetric('aiResponses');
    incrementMetric('totalResponseTimeMs', latency);
    incrementMetric('responseCount');

    // Espelhar no Chatwoot
    syncOutgoingMessage(phone, text).catch((err) =>
      logger.warn('Chatwoot sync outgoing falhou', { phone, error: err }),
    );

    // Enviar via WhatsApp
    try {
      await uazapi.sendText(phone, text);
      logger.info('Resposta enviada', { phone, latency_ms: latency });
    } catch (sendError) {
      if (sendError instanceof NotOnWhatsAppError) {
        await query("UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1", [phone]);
        await logEvent('lead_invalid_phone', phone);
        logger.warn('Número inválido no WhatsApp', { phone });
      } else {
        logger.error('Falha ao enviar via UAZAPI (conversa salva no DB)', { phone, error: sendError });
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

async function callClaude(
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

async function handleAiFailure(phone: string, error: unknown): Promise<void> {
  logger.error('Claude API falhou, enviando fallback', { phone, error: String(error) });
  await logEvent('error', phone, { ai_fallback: true, error: String(error) });
  incrementMetric('errors');
  await addMessage(phone, 'assistant', FALLBACK_MESSAGE);
  await uazapi.sendText(phone, FALLBACK_MESSAGE);
  notifyProblem('Claude API falhou — fallback enviado', {
    phone,
    erro: String(error).substring(0, 200),
  }).catch(() => {});
}
