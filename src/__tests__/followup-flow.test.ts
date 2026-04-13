import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Lead } from '../database/leads.repo';

// ============================================================
// MOCKS
// ============================================================
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('../database/client', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

vi.mock('../config/redis', () => ({
  redisClient: {
    rPush: vi.fn().mockResolvedValue(1),
    lRange: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    multi: vi.fn().mockReturnValue({
      lRange: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[], 0]),
    }),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../whatsapp/uazapi.client', () => ({
  uazapi: { sendText: vi.fn().mockResolvedValue(undefined) },
  UazapiClient: class UazapiClient {},
  NotOnWhatsAppError: class NotOnWhatsAppError extends Error {
    constructor(msg?: string) { super(msg); this.name = 'NotOnWhatsAppError'; }
  },
}));

vi.mock('../crm/rdstation.service', () => ({
  moveDealToStage: vi.fn().mockResolvedValue(undefined),
  updateDeal: vi.fn().mockResolvedValue(undefined),
  updateContact: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================
// IMPORTS
// ============================================================
import { getNextStage, FOLLOWUP_TEMPLATES } from '../followup/stages';
import { enqueueForFollowup, getQueuedFollowups } from '../followup/queue';
import { query } from '../database/client';
import { redisClient } from '../config/redis';
import { reactivatePausedLeads } from '../followup/scheduler';

// ============================================================
// HELPERS
// ============================================================
function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 1,
    phone: '5511999999999',
    name: 'Teste',
    source: 'whatsapp',
    status: 'active',
    birth_date: null,
    height: null,
    weight: null,
    profession: null,
    smoker: null,
    income: null,
    cpf: null,
    scheduled: false,
    scheduled_at: null,
    followup_status: 0,
    last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    last_lead_message: null,
    has_lead_replied: false,
    rd_contact_id: null,
    rd_deal_id: 'deal-123',
    chatwoot_contact_id: null,
    chatwoot_conversation_id: null,
    last_manual_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ============================================================
// TESTES
// ============================================================
describe('Fluxo 2: Follow-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // alreadySentStage retorna false (nao enviou ainda)
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('2.1 Lead elegivel recebe follow-up no estagio correto (followup_status=1 -> stage 2)', async () => {
    const lead = makeLead({
      followup_status: 1,
      last_ia_message: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h atras > 120min
    });

    const next = await getNextStage(lead);

    expect(next).not.toBeNull();
    expect(next!.stage).toBe(2);
    expect(next!.message).toContain('reforçar');
  });

  it('2.2 Lead com followup_status>=4 nao recebe mais follow-up (getNextStage retorna null)', async () => {
    const lead = makeLead({
      followup_status: 4,
      last_ia_message: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const next = await getNextStage(lead);

    expect(next).toBeNull();
  });

  it('2.3 enqueueForFollowup salva, getQueuedFollowups recupera atomicamente (MULTI/EXEC)', async () => {
    const queueItem = JSON.stringify({
      phone: '5511999999999',
      stage: 1,
      message: 'Oi, tudo bem?',
      queuedAt: new Date().toISOString(),
    });

    vi.mocked(redisClient.rPush).mockResolvedValueOnce(1);

    // Mock multi().lRange().del().exec() — node-redis v5 retorna [T1, T2]
    const mockMulti = {
      lRange: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValueOnce([[queueItem], 1]),
    };
    vi.mocked(redisClient.multi).mockReturnValueOnce(mockMulti as ReturnType<typeof redisClient.multi>);

    await enqueueForFollowup('5511999999999', 1, 'Oi, tudo bem?');

    expect(vi.mocked(redisClient.rPush)).toHaveBeenCalledWith(
      'followup:queue',
      expect.stringContaining('"phone":"5511999999999"'),
    );

    const items = await getQueuedFollowups();

    expect(items).toHaveLength(1);
    expect(items[0].phone).toBe('5511999999999');
    expect(items[0].stage).toBe(1);
    expect(items[0].message).toBe('Oi, tudo bem?');
    expect(mockMulti.exec).toHaveBeenCalled();
  });

  it('2.4 Lead pausado ha 30+ min e reativado automaticamente [fix TODO 2.4]', async () => {
    const phone = '5511888000111';
    mockQuery
      .mockResolvedValueOnce({
        rows: [makeLead({ phone, status: 'paused', last_manual_message: new Date(Date.now() - 35 * 60 * 1000) })],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const count = await reactivatePausedLeads();

    expect(count).toBe(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE leads SET status = 'active'"),
      [phone],
    );
  });

  it('2.5 Delay minimo entre estagios e respeitado (15min < 120min = nao envia stage 2)', async () => {
    const lead = makeLead({
      followup_status: 1,
      last_ia_message: new Date(Date.now() - 15 * 60 * 1000), // apenas 15min atras
    });

    const next = await getNextStage(lead);

    expect(next).toBeNull();
  });
});
