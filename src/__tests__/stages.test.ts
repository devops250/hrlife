import { describe, it, expect } from 'vitest';
import { getNextStage } from '../followup/stages';
import type { Lead } from '../database/leads.repo';

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
    last_ia_message: new Date(Date.now() - 31 * 60 * 1000), // 31min atrás
    last_lead_message: null,
    has_lead_replied: false,
    rd_contact_id: null,
    rd_deal_id: null,
    chatwoot_contact_id: null,
    chatwoot_conversation_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('getNextStage', () => {
  it('retorna stage 1 quando followup_status=0 e 31min sem resposta', () => {
    const lead = makeLead({ followup_status: 0, last_ia_message: new Date(Date.now() - 31 * 60 * 1000) });
    const result = getNextStage(lead);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe(1);
  });

  it('retorna null quando followup_status=0 e apenas 29min', () => {
    const lead = makeLead({ followup_status: 0, last_ia_message: new Date(Date.now() - 29 * 60 * 1000) });
    expect(getNextStage(lead)).toBeNull();
  });

  it('retorna stage 2 quando followup_status=1 e 121min', () => {
    const lead = makeLead({ followup_status: 1, last_ia_message: new Date(Date.now() - 121 * 60 * 1000) });
    const result = getNextStage(lead);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe(2);
  });

  it('retorna null quando lead está agendado (scheduled=true)', () => {
    const lead = makeLead({ scheduled: true, followup_status: 0, last_ia_message: new Date(Date.now() - 60 * 60 * 1000) });
    expect(getNextStage(lead)).toBeNull();
  });

  it('retorna null quando followup_status >= 4', () => {
    const lead = makeLead({ followup_status: 4 });
    expect(getNextStage(lead)).toBeNull();
  });

  it('retorna null quando last_ia_message é null', () => {
    const lead = makeLead({ last_ia_message: null });
    expect(getNextStage(lead)).toBeNull();
  });

  it('inclui nome do lead na mensagem', () => {
    const lead = makeLead({ name: 'João', followup_status: 0, last_ia_message: new Date(Date.now() - 31 * 60 * 1000) });
    const result = getNextStage(lead);
    expect(result!.message).toContain('João');
  });
});
