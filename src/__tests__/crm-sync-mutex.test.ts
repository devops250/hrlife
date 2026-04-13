import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks
vi.mock('../config/redis', () => ({
  redisClient: {
    set: vi.fn(),
    del: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock('../crm/rdstation.service', () => ({
  findContactByPhone: vi.fn(),
  createDeal: vi.fn(),
  findDealsByContact: vi.fn(),
  updateContact: vi.fn(),
  moveDealToStage: vi.fn(),
  updateDealCustomFields: vi.fn(),
}));
vi.mock('../database/leads.repo', () => ({
  findLeadByPhone: vi.fn(),
  updateLeadData: vi.fn(),
}));
vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../crm/sync-contact', () => ({
  resolveContactId: vi.fn().mockResolvedValue(null),
  safeUpdateContact: vi.fn().mockResolvedValue(undefined),
  ensureDealScheduled: vi.fn().mockResolvedValue('deal_ensured'),
}));
vi.mock('../monitoring/metrics', () => ({
  trackRdSync: vi.fn(),
}));
vi.mock('../config/env', () => ({
  env: {
    RD_STAGE_CONTATO_FEITO: 'stage_contato',
    RD_STAGE_AGENDADO: 'stage_agendado',
    RD_STAGE_SEM_RETORNO: 'stage_sem_retorno',
  },
}));

import { redisClient } from '../config/redis';
import { createDeal, findContactByPhone } from '../crm/rdstation.service';
import { findLeadByPhone, updateLeadData } from '../database/leads.repo';
import { syncLeadScheduled } from '../crm/sync';
import type { Lead } from '../database/leads.repo';

const mockLead: Lead = {
  id: 1,
  phone: '5511999990001',
  name: 'Teste Mutex',
  status: 'active',
  scheduled: true,
  rd_contact_id: null,
  rd_deal_id: null,
  created_at: new Date(),
  updated_at: new Date(),
  followup_status: 0,
  followup_sent_at: null,
  has_lead_replied: true,
  last_lead_message: new Date(),
  last_ia_message: null,
  first_message_sent: true,
  invalid_phone: false,
} as unknown as Lead;

describe('CRM sync — mutex Redis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateLeadData).mockResolvedValue(undefined);
    vi.mocked(redisClient.del).mockResolvedValue(1);
  });

  it('adquire lock, executa sync e libera lock', async () => {
    vi.mocked(redisClient.set).mockResolvedValueOnce('OK'); // lock adquirido
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...mockLead, rd_deal_id: null });
    vi.mocked(findContactByPhone).mockResolvedValue(null);
    vi.mocked(createDeal).mockResolvedValue({ _id: 'deal_abc', deal_stage: { _id: 'stage1' } } as any);
    vi.mocked(updateLeadData).mockResolvedValue(undefined);

    await syncLeadScheduled(mockLead);

    expect(vi.mocked(redisClient.set)).toHaveBeenCalledWith(
      `crm_lock:${mockLead.phone}`, '1', { NX: true, EX: 30 }
    );
    expect(vi.mocked(redisClient.del)).toHaveBeenCalledWith(`crm_lock:${mockLead.phone}`);
  });

  it('se lock já existe, aguarda e tenta novamente', async () => {
    vi.mocked(redisClient.set)
      .mockResolvedValueOnce(null)   // primeira tentativa: lock ocupado
      .mockResolvedValueOnce('OK');  // retry: lock adquirido
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...mockLead, rd_deal_id: null });
    vi.mocked(findContactByPhone).mockResolvedValue(null);
    vi.mocked(createDeal).mockResolvedValue({ _id: 'deal_xyz', deal_stage: { _id: 'stage1' } } as any);

    await syncLeadScheduled(mockLead);

    expect(vi.mocked(redisClient.set)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(redisClient.del)).toHaveBeenCalledWith(`crm_lock:${mockLead.phone}`);
  });

  it('se deal já existe no recheck, não cria novo deal', async () => {
    vi.mocked(redisClient.set).mockResolvedValueOnce('OK');
    // Lead já tem rd_deal_id preenchido no recheck
    vi.mocked(findLeadByPhone).mockResolvedValue({ ...mockLead, rd_deal_id: 'deal_existente_123' });

    await syncLeadScheduled(mockLead);

    expect(vi.mocked(createDeal)).not.toHaveBeenCalled();
  });
});
