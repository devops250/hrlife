import { redisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { uazapi } from '../whatsapp/uazapi.client';
import { transcribeAudio } from '../whatsapp/audio.service';
import { analyzeImage } from '../whatsapp/image.service';
import { findLeadByPhone } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { processConversation } from './engine';

interface BufferedMessage {
  text: string;
  type: 'text' | 'audio' | 'image';
  mediaId?: string;
}

const debounceTimers = new Map<string, NodeJS.Timeout>();

const DEBOUNCE_MS = 3000;

export async function addToBuffer(phone: string, message: BufferedMessage): Promise<void> {
  const key = `buffer:${phone}`;
  await redisClient.rPush(key, JSON.stringify(message));
  await redisClient.expire(key, 60);

  const existing = debounceTimers.get(phone);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(phone);
    processBuffer(phone).catch((err) => {
      logger.error('Erro ao processar buffer', { phone, error: err });
    });
  }, DEBOUNCE_MS);

  debounceTimers.set(phone, timer);
}

async function processBuffer(phone: string): Promise<void> {
  const key = `buffer:${phone}`;
  const raw = await redisClient.lRange(key, 0, -1);
  await redisClient.del(key);

  if (raw.length === 0) return;

  const messages: BufferedMessage[] = raw.map((r) => JSON.parse(r));
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.type === 'audio' && msg.mediaId) {
      try {
        const buffer = await uazapi.downloadMedia(msg.mediaId);
        const transcription = await transcribeAudio(buffer);
        parts.push(`[Áudio transcrito]: ${transcription}`);
      } catch (err) {
        logger.error('Erro ao transcrever áudio', { phone, error: err });
        parts.push('[Áudio não transcrito]');
      }
    } else if (msg.type === 'image' && msg.mediaId) {
      try {
        const buffer = await uazapi.downloadMedia(msg.mediaId);
        const description = await analyzeImage(buffer);
        parts.push(`[Imagem]: ${description}`);
      } catch (err) {
        logger.error('Erro ao analisar imagem', { phone, error: err });
        parts.push('[Imagem não analisada]');
      }
    } else {
      parts.push(msg.text);
    }
  }

  const chatInput = parts.join('\n');
  const lead = await findLeadByPhone(phone);

  if (!lead) {
    logger.error('Lead não encontrado após buffer', { phone });
    return;
  }

  // Verificar se lead foi pausado durante o debounce (Rodrigo assumiu)
  if (lead.status === 'paused') {
    logger.info('Lead pausado durante buffer, descartando mensagens', { phone, messageCount: messages.length });
    return;
  }

  await logEvent('buffer_processed', phone, { messageCount: messages.length });

  logger.info('Buffer processado, enviando para engine', {
    phone,
    chatInput: chatInput.substring(0, 100),
    messageCount: messages.length,
  });

  await processConversation(phone, chatInput);
}

export { processBuffer };
