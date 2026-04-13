import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// MOCKS
// ============================================================
vi.mock('../database/leads.repo', () => ({
  findLeadByPhone: vi.fn(),
  updateLeadData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../scheduling/availability', () => ({
  getNextAvailableSlots: vi.fn().mockResolvedValue([]),
}));

vi.mock('../scheduling/calendar.service', () => ({
  checkFreeBusy: vi.fn().mockResolvedValue([]),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
  updateEvent: vi.fn(),
  findEventByLeadName: vi.fn().mockResolvedValue(null),
  listEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../crm/sync', () => ({
  syncLeadCreated: vi.fn().mockResolvedValue(undefined),
  syncLeadScheduled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../crm/rdstation.service', () => ({
  updateDeal: vi.fn().mockResolvedValue(undefined),
  updateContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../monitoring/metrics', () => ({
  trackToolCall: vi.fn(),
  incrementMetric: vi.fn(),
  trackRdSync: vi.fn(),
}));

vi.mock('../monitoring/alerts', () => ({
  notifyLeadScheduled: vi.fn().mockResolvedValue(undefined),
  notifyProblem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ============================================================
// IMPORTS
// ============================================================
import { executeTool } from '../conversation/tool-executor';
import { findLeadByPhone, updateLeadData } from '../database/leads.repo';
import { syncLeadCreated, syncLeadScheduled } from '../crm/sync';

const PHONE = '5511999999999';

const baseLead = {
  id: 1,
  phone: PHONE,
  name: null,
  source: 'meta_form',
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
describe('Fluxo 4: Coleta de Dados (cadastra_lead)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...baseLead });
  });

  it('4.1 cadastra_lead salva todos os campos e chama syncLeadCreated', async () => {
    const args = {
      nome_completo: 'João Silva',
      data_nascimento: '01/01/1980',
      cpf: '123.456.789-09',
      altura: '1.75',
      peso: '80',
      profissao: 'Empresario',
      renda_mensal: '10000',
      fumante: 'nao',
      agendado: 'false',
    };

    const result = await executeTool('cadastra_lead', args, PHONE);

    expect(result).toContain('João Silva');
    expect(result).toContain('cadastrado');
    expect(vi.mocked(updateLeadData)).toHaveBeenCalledWith(
      PHONE,
      expect.objectContaining({
        name: 'João Silva',
        birth_date: '01/01/1980',
        profession: 'Empresario',
      }),
    );
    // syncLeadCreated chamado assincronamente (nao bloqueia)
    // Aguardar microtasks
    await new Promise((r) => setImmediate(r));
    expect(vi.mocked(syncLeadCreated)).toHaveBeenCalled();
  });

  it('4.2 Nome invalido (cliente/lead/teste) e rejeitado, updateLeadData NAO chamado', async () => {
    for (const nome of ['cliente', 'lead', 'usuário', '']) {
      vi.clearAllMocks();
      const result = await executeTool(
        'cadastra_lead',
        { nome_completo: nome, agendado: 'false' },
        PHONE,
      );

      expect(result).toContain('Nome inválido');
      expect(vi.mocked(updateLeadData)).not.toHaveBeenCalled();
    }
  });

  it('4.3 Dedup bloqueia chamada duplicada em menos de 30s', async () => {
    // Phone exclusivo para nao colidir com dedup de testes anteriores
    const phone3 = '5531999888777';
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...baseLead, phone: phone3 });
    const args = { nome_completo: 'Maria Santos', agendado: 'false' };

    const result1 = await executeTool('cadastra_lead', args, phone3);
    const result2 = await executeTool('cadastra_lead', args, phone3);

    expect(result1).toContain('cadastrado');
    expect(result2).toContain('já registrados');
    // updateLeadData chamado apenas 1x
    expect(vi.mocked(updateLeadData)).toHaveBeenCalledTimes(1);
  });

  it('4.4 cadastra_lead com agendado=true aciona syncLeadScheduled (nao syncLeadCreated)', async () => {
    const args = {
      nome_completo: 'Carlos Oliveira',
      agendado: 'true',
    };

    // Usar phone diferente para evitar dedup do teste anterior
    const phone2 = '5521999888777';
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...baseLead, phone: phone2 });

    const result = await executeTool('cadastra_lead', args, phone2);

    expect(result).toContain('agendado');
    await new Promise((r) => setImmediate(r));
    expect(vi.mocked(syncLeadScheduled)).toHaveBeenCalled();
    expect(vi.mocked(syncLeadCreated)).not.toHaveBeenCalled();
  });
});
