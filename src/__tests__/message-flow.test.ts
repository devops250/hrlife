import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ============================================================
// MOCKS
// ============================================================
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('../database/client', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

vi.mock('../database/leads.repo', () => ({
  findLeadByPhone: vi.fn(),
  createLead: vi.fn().mockResolvedValue({}),
  updateLeadOnMessage: vi.fn().mockResolvedValue(undefined),
  clearLeadHistory: vi.fn().mockResolvedValue(undefined),
  updateLeadData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock parcial: addToBuffer = mock, processBuffer = implementação real
vi.mock('../conversation/message-buffer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversation/message-buffer')>();
  return {
    addToBuffer: vi.fn().mockResolvedValue(undefined),
    processBuffer: actual.processBuffer,
  };
});

vi.mock('../conversation/engine', () => ({
  processConversation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../whatsapp/uazapi.client', () => ({
  uazapi: {
    sendText: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn().mockResolvedValue(Buffer.from('')),
  },
  NotOnWhatsAppError: class NotOnWhatsAppError extends Error {},
}));

vi.mock('../whatsapp/audio.service', () => ({
  transcribeAudio: vi.fn().mockResolvedValue('audio'),
}));

vi.mock('../whatsapp/image.service', () => ({
  analyzeImage: vi.fn().mockResolvedValue('imagem'),
}));

vi.mock('../monitoring/metrics', () => ({
  incrementMetric: vi.fn(),
  trackToolCall: vi.fn(),
  trackRdSync: vi.fn(),
}));

vi.mock('../chatwoot/sync', () => ({
  syncIncomingMessage: vi.fn().mockResolvedValue(undefined),
  syncOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../webhook/lead-pipeline', () => ({
  processIncomingLead: vi.fn().mockResolvedValue({ success: true, isNew: false, isDuplicate: false, phone: '5511999999999' }),
}));

vi.mock('../config/redis', () => ({
  redisClient: {
    rPush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    lRange: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
  },
}));

// ============================================================
// IMPORTS
// ============================================================
import { whatsappHandler } from '../webhook/whatsapp.handler';
import { findLeadByPhone, clearLeadHistory } from '../database/leads.repo';
import { addToBuffer, processBuffer } from '../conversation/message-buffer';
import { processConversation } from '../conversation/engine';
import { uazapi } from '../whatsapp/uazapi.client';
import { redisClient } from '../config/redis';

// ============================================================
// HELPERS
// ============================================================
function makeReq(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

function makeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function makePayload({
  phone = '5511999999999',
  text = 'oi',
  fromMe = false,
  messageType = 'textMessage',
}: { phone?: string; text?: string; fromMe?: boolean; messageType?: string } = {}) {
  return {
    message: { fromMe, messageType, text, id: 'msg-1' },
    chat: { phone },
  };
}

const baseLead = {
  id: 1,
  phone: '5511999999999',
  name: 'Teste Lead',
  source: 'whatsapp',
  status: 'active',
  followup_status: 0,
  scheduled: false,
  has_lead_replied: false,
  last_ia_message: null,
  last_lead_message: null,
  rd_contact_id: null,
  rd_deal_id: null,
  birth_date: null,
  height: null,
  weight: null,
  profession: null,
  smoker: null,
  income: null,
  cpf: null,
  scheduled_at: null,
  chatwoot_contact_id: null,
  chatwoot_conversation_id: null,
  last_manual_message: null,
  created_at: new Date(),
  updated_at: new Date(),
};

// ============================================================
// TESTES
// ============================================================
describe('Fluxo 1: Mensagem Recebida', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...baseLead });
    vi.mocked(redisClient.lRange).mockResolvedValue([]);
  });

  it('1.1 Webhook recebe mensagem e chama addToBuffer com telefone normalizado', async () => {
    const req = makeReq(makePayload({ phone: '5511999999999', text: 'oi' }));
    await whatsappHandler(req, makeRes());

    expect(vi.mocked(addToBuffer)).toHaveBeenCalledWith(
      '5511999999999',
      expect.objectContaining({ text: 'oi', type: 'text' }),
    );
  });

  it('1.2 fromMe=true pausa o lead (addToBuffer NAO chamado)', async () => {
    const req = makeReq(makePayload({ fromMe: true, text: 'atendimento manual' }));
    await whatsappHandler(req, makeRes());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'paused'"),
      expect.arrayContaining(['5511999999999']),
    );
    expect(vi.mocked(addToBuffer)).not.toHaveBeenCalled();
  });

  it('1.3 Numero do Rodrigo (5512996217353) e ignorado completamente', async () => {
    const req = makeReq(makePayload({ phone: '5512996217353', text: 'oi' }));
    await whatsappHandler(req, makeRes());

    expect(vi.mocked(findLeadByPhone)).not.toHaveBeenCalled();
    expect(vi.mocked(addToBuffer)).not.toHaveBeenCalled();
  });

  it('1.4 Lead exhausted e reativado ao receber mensagem', async () => {
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...baseLead, status: 'exhausted' });

    const req = makeReq(makePayload({ text: 'voltei' }));
    await whatsappHandler(req, makeRes());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE leads SET status'),
      expect.arrayContaining(['active', '5511999999999']),
    );
    expect(vi.mocked(addToBuffer)).toHaveBeenCalled();
  });

  it('1.5 processBuffer agrega multiplas msgs e chama processConversation 1x', async () => {
    vi.mocked(redisClient.lRange).mockResolvedValueOnce([
      JSON.stringify({ text: 'primeira', type: 'text' }),
      JSON.stringify({ text: 'segunda', type: 'text' }),
    ]);
    vi.mocked(redisClient.del).mockResolvedValueOnce(1);
    vi.mocked(findLeadByPhone).mockResolvedValueOnce({ ...baseLead });

    await processBuffer('5511999999999');

    expect(vi.mocked(processConversation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(processConversation)).toHaveBeenCalledWith(
      '5511999999999',
      'primeira\nsegunda',
    );
  });

  it('1.6 Comando #reset limpa historico e envia confirmacao', async () => {
    const req = makeReq(makePayload({ text: '#reset' }));
    await whatsappHandler(req, makeRes());

    expect(vi.mocked(clearLeadHistory)).toHaveBeenCalledWith('5511999999999');
    expect(vi.mocked(uazapi.sendText)).toHaveBeenCalledWith(
      '5511999999999',
      expect.stringContaining('Memória resetada'),
    );
    expect(vi.mocked(addToBuffer)).not.toHaveBeenCalled();
  });
});
