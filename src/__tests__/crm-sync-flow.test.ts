import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Lead } from '../database/leads.repo';

// ============================================================
// MOCKS
// ============================================================
vi.mock('../crm/rdstation.service', () => ({
  findContactByPhone: vi.fn(),
  createDeal: vi.fn(),
  findDealsByContact: vi.fn(),
  moveDealToStage: vi.fn().mockResolvedValue(undefined),
  updateContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../database/leads.repo', () => ({
  findLeadByPhone: vi.fn(),
  updateLeadData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../monitoring/metrics', () => ({
  trackRdSync: vi.fn(),
  incrementMetric: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/redis', () => ({
  redisClient: {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  },
}));

// ============================================================
// IMPORTS
// ============================================================
import { syncLeadBasic, syncLeadCreated, syncLeadScheduled } from '../crm/sync';
import {
  findContactByPhone,
  createDeal,
  findDealsByContact,
  moveDealToStage,
  updateContact,
} from '../crm/rdstation.service';
import { findLeadByPhone, updateLeadData } from '../database/leads.repo';
import { trackRdSync } from '../monitoring/metrics';
import { env } from '../config/env';

// ============================================================
// HELPERS
// ============================================================
function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 1,
    phone: '5511999999999',
    name: 'Joao Silva',
    source: 'whatsapp',
    status: 'active',
    birth_date: '01/01/1985',
    height: '1.75',
    weight: '80',
    profession: 'Empresario',
    smoker: 'Sim',
    income: '8000',
    cpf: '123.456.789-09',
    scheduled: false,
    scheduled_at: null,
    followup_status: 0,
    last_ia_message: null,
    last_lead_message: null,
    has_lead_replied: false,
    rd_contact_id: null,
    rd_deal_id: null,
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
describe('Fluxo 5: CRM Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(findLeadByPhone).mockResolvedValue(makeLead());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('5.1 syncLeadBasic: lead novo sem contato no RD cria deal em Contato Feito', async () => {
    vi.mocked(findContactByPhone).mockResolvedValue(null);
    vi.mocked(createDeal).mockResolvedValue({ _id: 'deal-new-001' } as any);
    // Apos setTimeout(1000), findContactByPhone retorna contato
    vi.mocked(findContactByPhone)
      .mockResolvedValueOnce(null) // primeira chamada (check contato)
      .mockResolvedValueOnce({ _id: 'contact-001', name: 'Joao', phone: '5511999999999' } as any); // resolveContactId

    const promise = syncLeadBasic('5511999999999');
    await vi.runAllTimersAsync();
    await promise;

    expect(vi.mocked(createDeal)).toHaveBeenCalledWith(
      expect.any(String),
      '5511999999999',
      env.RD_STAGE_CONTATO_FEITO,
    );
    expect(vi.mocked(updateLeadData)).toHaveBeenCalledWith(
      '5511999999999',
      expect.objectContaining({ rd_deal_id: 'deal-new-001' }),
    );
    expect(vi.mocked(trackRdSync)).toHaveBeenCalledWith(true);
  });

  it('5.2 syncLeadBasic: lead com rd_contact_id ja existente pula criacao', async () => {
    vi.mocked(findLeadByPhone).mockResolvedValue(
      makeLead({ rd_contact_id: 'contact-existing', rd_deal_id: 'deal-existing' }),
    );

    const promise = syncLeadBasic('5511999999999');
    await vi.runAllTimersAsync();
    await promise;

    expect(vi.mocked(createDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(findContactByPhone)).not.toHaveBeenCalled();
  });

  it('5.3 syncLeadCreated: contato existente com deal ativo nao duplica deal', async () => {
    const lead = makeLead();
    vi.mocked(findContactByPhone).mockResolvedValue({
      _id: 'contact-123',
      name: 'Joao',
      phone: '5511999999999',
    } as any);
    vi.mocked(findDealsByContact).mockResolvedValue([
      { _id: 'deal-active', deal_stage: { _id: env.RD_STAGE_CONTATO_FEITO, name: 'Contato Feito' } } as any,
    ]);

    const promise = syncLeadCreated(lead);
    await vi.runAllTimersAsync();
    await promise;

    expect(vi.mocked(createDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(updateLeadData)).toHaveBeenCalledWith(
      '5511999999999',
      expect.objectContaining({ rd_contact_id: 'contact-123', rd_deal_id: 'deal-active' }),
    );
  });

  it('5.4 syncLeadScheduled: move deal existente para estagio Agendado', async () => {
    const lead = makeLead({ rd_deal_id: 'deal-to-move', rd_contact_id: 'contact-123' });
    vi.mocked(findLeadByPhone).mockResolvedValue(lead);

    const promise = syncLeadScheduled(lead);
    await vi.runAllTimersAsync();
    await promise;

    expect(vi.mocked(moveDealToStage)).toHaveBeenCalledWith('deal-to-move', env.RD_STAGE_AGENDADO);
    expect(vi.mocked(createDeal)).not.toHaveBeenCalled();
  });

  it('5.5 syncLeadScheduled: sem rd_deal_id executa fluxo completo de criacao', async () => {
    const lead = makeLead({ rd_deal_id: null, rd_contact_id: null });
    vi.mocked(findLeadByPhone).mockResolvedValue(lead);
    vi.mocked(findContactByPhone).mockResolvedValue(null);
    vi.mocked(createDeal).mockResolvedValue({ _id: 'deal-scheduled-001' } as any);
    vi.mocked(findContactByPhone).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const promise = syncLeadScheduled(lead);
    await vi.runAllTimersAsync();
    await promise;

    expect(vi.mocked(createDeal)).toHaveBeenCalledWith(
      expect.any(String),
      '5511999999999',
      env.RD_STAGE_AGENDADO,
    );
  });

  it('5.6 Campos customizados: fumante=Sim vira ["Sim"], CPF com mascara, data ISO', async () => {
    // syncLeadCreated dispara safeUpdateContact que chama updateContact com custom_fields
    const lead = makeLead({
      smoker: 'Sim, fumo bastante',
      cpf: '123.456.789-09',
      birth_date: '01/01/1985',
      rd_contact_id: null,
    });
    vi.mocked(findLeadByPhone).mockResolvedValue(lead);
    vi.mocked(findContactByPhone).mockResolvedValue(null);
    vi.mocked(createDeal).mockResolvedValue({ _id: 'deal-cf' } as any);
    // resolveContactId retorna um contactId para disparar safeUpdateContact
    vi.mocked(findContactByPhone)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'contact-cf', name: 'Joao', phone: '5511999999999' } as any);

    const promise = syncLeadCreated(lead);
    await vi.runAllTimersAsync();
    await promise;
    // safeUpdateContact envia tudo em um unico batch (RD substitui array inteiro no PUT)
    const calls = vi.mocked(updateContact).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const batchPayload = calls[0][1] as Record<string, unknown>;

    // Nome incluso no batch
    expect(batchPayload.name).toBe('Joao Silva');

    // Campos customizados enviados em array unico
    const fields = batchPayload.contact_custom_fields as Array<{ custom_field_id: string; value: unknown }>;
    expect(fields).toBeDefined();
    expect(fields.length).toBeGreaterThanOrEqual(4);

    const values = fields.map(f => f.value);
    expect(values).toContainEqual(['Sim']); // fumante
    expect(values).toContainEqual('123.456.789-09'); // cpf com mascara
    expect(values).toContainEqual('1985-01-01'); // data ISO
    expect(values).toContainEqual('SP'); // estado via DDD
  });
});
