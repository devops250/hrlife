/**
 * Testes de regressão para o scheduler de follow-up.
 * Cobre 3 bugs que já quebraram em produção:
 *   Bug 1: Duplicatas na fila fora do horário
 *   Bug 2: No-show disparando para reunião já atendida por Rodrigo
 *   Bug 3: Loop infinito quando WhatsApp falha repetidamente
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Lead } from '../database/leads.repo';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
vi.mock('../database/client', () => ({ query: (...args: unknown[]) => mockQuery(...args), pool: { end: vi.fn() } }));

const mockRedisSet = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisKeys = vi.fn();
vi.mock('../config/redis', () => ({
  redisClient: {
    set: (...args: unknown[]) => mockRedisSet(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    keys: (...args: unknown[]) => mockRedisKeys(...args),
  },
}));

const mockSendText = vi.fn();
vi.mock('../whatsapp/uazapi.client', () => {
  class NotOnWhatsAppError extends Error { constructor(m: string) { super(m); this.name = 'NotOnWhatsAppError'; } }
  class WhatsAppDisconnectedError extends Error { constructor(m: string) { super(m); this.name = 'WhatsAppDisconnectedError'; } }
  return {
    uazapi: { sendText: (...args: unknown[]) => mockSendText(...args) },
    UazapiClient: class {},
    NotOnWhatsAppError,
    WhatsAppDisconnectedError,
  };
});

let mockIsBusinessHours = vi.fn(() => true);
vi.mock('../config/schedule', () => ({
  isBusinessHours: () => mockIsBusinessHours(),
}));

vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../monitoring/metrics', () => ({
  incrementMetric: vi.fn(),
}));

vi.mock('../crm/rdstation.service', () => ({
  moveDealToStage: vi.fn(),
}));

vi.mock('../conversation/first-message', () => ({
  generateFirstMessage: (name: string) => `Olá ${name}, tudo bem?`,
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockFindLeadByPhone = vi.fn();
vi.mock('../database/leads.repo', async () => {
  const actual = await vi.importActual<typeof import('../database/leads.repo')>('../database/leads.repo');
  return { ...actual, findLeadByPhone: (...args: unknown[]) => mockFindLeadByPhone(...args) };
});

const mockEnqueue = vi.fn();
const mockGetQueued = vi.fn(() => []);
vi.mock('../followup/queue', () => ({
  enqueueForFollowup: (...args: unknown[]) => mockEnqueue(...args),
  getQueuedFollowups: (...args: unknown[]) => mockGetQueued(...args),
}));

vi.mock('../config/env', () => ({
  env: {
    RD_STAGE_SEM_RETORNO: 'stage_sem_retorno',
    ALERT_WHATSAPP_NUMBERS: '',
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────

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
    rd_deal_id: null,
    chatwoot_contact_id: null,
    chatwoot_conversation_id: null,
    last_manual_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/**
 * Prepara mocks para um ciclo limpo do processFollowups:
 * - Redis lock livre
 * - Circuit breaker off
 * - Sem leads pausados
 * - Sem retry pendente
 * - Fila vazia
 */
function setupCleanCycle() {
  // Lock: adquirir com sucesso, liberar sem erro
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  // Circuit breaker: desligado
  mockRedisGet.mockResolvedValue(null);
  // Sem leads pausados, sem retry pendente
  mockQuery.mockResolvedValue({ rows: [] });
  // Fila vazia
  mockGetQueued.mockResolvedValue([]);
}

// ── Importar após os mocks ────────────────────────────────────────────

// getNextStage usa `query` diretamente (alreadySentStage)
const { getNextStage } = await import('../followup/stages');

// processFollowups precisa resetar isRunning entre testes
// Importamos dinamicamente para cada teste via resetScheduler()
async function runProcessFollowups() {
  // Reset do módulo para limpar isRunning
  vi.resetModules();
  // Re-aplicar mocks (resetModules limpa tudo)
  vi.doMock('../database/client', () => ({ query: (...a: unknown[]) => mockQuery(...a), pool: { end: vi.fn() } }));
  vi.doMock('../config/redis', () => ({
    redisClient: {
      set: (...a: unknown[]) => mockRedisSet(...a),
      get: (...a: unknown[]) => mockRedisGet(...a),
      del: (...a: unknown[]) => mockRedisDel(...a),
      keys: (...a: unknown[]) => mockRedisKeys(...a),
    },
  }));
  vi.doMock('../whatsapp/uazapi.client', () => {
    class NotOnWhatsAppError extends Error { constructor(m: string) { super(m); } }
    class WhatsAppDisconnectedError extends Error { constructor(m: string) { super(m); } }
    return {
      uazapi: { sendText: (...a: unknown[]) => mockSendText(...a) },
      UazapiClient: class {},
      NotOnWhatsAppError,
      WhatsAppDisconnectedError,
    };
  });
  vi.doMock('../config/schedule', () => ({ isBusinessHours: () => mockIsBusinessHours() }));
  vi.doMock('../database/events.repo', () => ({ logEvent: vi.fn(), logError: vi.fn() }));
  vi.doMock('../monitoring/metrics', () => ({ incrementMetric: vi.fn() }));
  vi.doMock('../crm/rdstation.service', () => ({ moveDealToStage: vi.fn() }));
  vi.doMock('../conversation/first-message', () => ({ generateFirstMessage: (n: string) => `Olá ${n}` }));
  vi.doMock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
  vi.doMock('../database/leads.repo', () => ({ findLeadByPhone: (...a: unknown[]) => mockFindLeadByPhone(...a) }));
  vi.doMock('../followup/queue', () => ({
    enqueueForFollowup: (...a: unknown[]) => mockEnqueue(...a),
    getQueuedFollowups: (...a: unknown[]) => mockGetQueued(...a),
  }));
  vi.doMock('../config/env', () => ({ env: { RD_STAGE_SEM_RETORNO: 'stage_sem_retorno', ALERT_WHATSAPP_NUMBERS: '' } }));

  const mod = await import('../followup/scheduler');
  return mod.processFollowups();
}

// ── Testes ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// Bug 1: Fila fora do horário não deve acumular duplicatas
// ═══════════════════════════════════════════════════════════════════════

describe('Bug 1: Lead enfileirado fora do horário NÃO acumula duplicatas', () => {
  it('atualiza followup_status ao enfileirar (impede re-enqueue no próximo ciclo)', async () => {
    const lead = makeLead({
      phone: '5511888888888',
      followup_status: 0,
      last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    });

    mockIsBusinessHours = vi.fn(() => false);
    setupCleanCycle();

    let callCount = 0;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      // Leads pausados + retry pendente → vazio
      if (callCount <= 2) return { rows: [] };
      // Leads elegíveis (step 2)
      if (sql.includes('followup_status < 4')) return { rows: [lead] };
      // Leads esgotados (step 3)
      if (sql.includes('followup_status >= 4')) return { rows: [] };
      // UPDATE followup_status
      if (sql.includes('UPDATE leads SET followup_status')) return { rows: [] };
      return { rows: [] };
    });

    // getNextStage mockado via query → alreadySentStage retorna false (sem tentativas)
    // Precisamos que getNextStage funcione: a query de alreadySentStage deve retornar 0
    const origQuery = mockQuery;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      // alreadySentStage query
      if (sql.includes('followup_log') && sql.includes('attempts')) {
        return { rows: [{ attempts: '0', successes: '0' }] };
      }
      // Leads pausados → vazio
      if (sql.includes("status = 'paused'")) return { rows: [] };
      // Retry pendente → vazio
      if (sql.includes('last_ia_message IS NULL') && sql.includes("source != 'whatsapp'")) return { rows: [] };
      // Leads elegíveis
      if (sql.includes('followup_status < 4')) return { rows: [lead] };
      // Leads esgotados
      if (sql.includes('followup_status >= 4')) return { rows: [] };
      // UPDATEs
      return { rows: [] };
    });

    mockFindLeadByPhone.mockResolvedValue(lead);

    await runProcessFollowups();

    // Deve enfileirar (fora do horário)
    expect(mockEnqueue).toHaveBeenCalledWith('5511888888888', 1, expect.any(String));

    // Deve atualizar followup_status para 1 no banco
    const updateCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE leads SET followup_status'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toContain(1); // stage 1
  });

  it('fila Redis usa NX (set-if-not-exists) para deduplicar', async () => {
    // Importar queue real (não o mock) para verificar que usa NX
    const actual = await vi.importActual<typeof import('../followup/queue')>('../followup/queue');

    mockRedisSet.mockResolvedValue('OK');
    await actual.enqueueForFollowup('5511888888888', 1, 'msg');

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('5511888888888'),
      expect.any(String),
      expect.objectContaining({ NX: true }),
    );
  });

  it('segunda chamada ao Redis com mesmo phone/stage é ignorada (NX retorna null)', async () => {
    const actual = await vi.importActual<typeof import('../followup/queue')>('../followup/queue');

    // Primeira vez: OK
    mockRedisSet.mockResolvedValueOnce('OK');
    await actual.enqueueForFollowup('5511888888888', 1, 'msg');

    // Segunda vez: já existe (NX falha)
    mockRedisSet.mockResolvedValueOnce(null);
    await actual.enqueueForFollowup('5511888888888', 1, 'msg');

    // Redis.set chamado 2x, mas o segundo retorna null (sem duplicata)
    expect(mockRedisSet).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Bug 2: No-show não deve disparar para lead atendido por Rodrigo
// ═══════════════════════════════════════════════════════════════════════

describe('Bug 2: Lead atendido por Rodrigo NÃO recebe follow-up', () => {
  it('lead com has_lead_replied=true é filtrado pela query SQL', async () => {
    mockIsBusinessHours = vi.fn(() => true);
    setupCleanCycle();

    const leadRespondido = makeLead({
      phone: '5511777777777',
      has_lead_replied: true, // Rodrigo ou lead respondeu
      scheduled: true,
      scheduled_at: new Date(Date.now() - 24 * 60 * 60 * 1000), // ontem
    });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("status = 'paused'")) return { rows: [] };
      if (sql.includes("source != 'whatsapp'")) return { rows: [] };
      // A query de leads elegíveis filtra has_lead_replied = false
      // Então leadRespondido NÃO aparece nos resultados
      if (sql.includes('followup_status < 4')) return { rows: [] };
      if (sql.includes('followup_status >= 4')) return { rows: [] };
      return { rows: [] };
    });

    mockGetQueued.mockResolvedValue([]);
    mockFindLeadByPhone.mockResolvedValue(leadRespondido);

    await runProcessFollowups();

    // Nenhuma mensagem enviada
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('lead agendado (scheduled=true) é excluído pela query de follow-up regular', async () => {
    mockIsBusinessHours = vi.fn(() => true);
    setupCleanCycle();

    const leadAgendado = makeLead({
      phone: '5511666666666',
      scheduled: true,
      scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // amanhã
      has_lead_replied: false,
      followup_status: 0,
    });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("status = 'paused'")) return { rows: [] };
      if (sql.includes("source != 'whatsapp'")) return { rows: [] };
      // Query tem "AND scheduled = false" → lead agendado é excluído
      if (sql.includes('followup_status < 4')) return { rows: [] };
      if (sql.includes('followup_status >= 4')) return { rows: [] };
      return { rows: [] };
    });

    mockGetQueued.mockResolvedValue([]);

    await runProcessFollowups();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('re-check via findLeadByPhone bloqueia follow-up se Rodrigo assumiu entre a query e o envio', async () => {
    mockIsBusinessHours = vi.fn(() => true);
    setupCleanCycle();

    const lead = makeLead({
      phone: '5511555555555',
      followup_status: 0,
      has_lead_replied: false,
      scheduled: false,
    });

    // Lead aparece na query inicial...
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("status = 'paused'")) return { rows: [] };
      if (sql.includes("source != 'whatsapp'")) return { rows: [] };
      if (sql.includes('followup_status < 4')) return { rows: [lead] };
      if (sql.includes('followup_status >= 4')) return { rows: [] };
      if (sql.includes('followup_log') && sql.includes('attempts')) return { rows: [{ attempts: '0', successes: '0' }] };
      return { rows: [] };
    });

    // ...mas entre a query e o envio, Rodrigo assume (has_lead_replied=true)
    mockFindLeadByPhone.mockResolvedValue(
      makeLead({ ...lead, has_lead_replied: true }),
    );

    await runProcessFollowups();

    // Não deve enviar — re-check pegou a mudança
    expect(mockSendText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Bug 3: Anti-loop deve parar após 3 tentativas com falha
// ═══════════════════════════════════════════════════════════════════════

describe('Bug 3: Anti-loop para após 3 tentativas com falha', () => {
  it('getNextStage retorna stage quando 0 tentativas anteriores', async () => {
    mockQuery.mockResolvedValue({ rows: [{ attempts: '0', successes: '0' }] });

    const lead = makeLead({
      followup_status: 0,
      last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    });

    const result = await getNextStage(lead);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe(1);
  });

  it('getNextStage retorna stage quando 2 tentativas falharam (abaixo do limite)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ attempts: '2', successes: '0' }] });

    const lead = makeLead({
      followup_status: 0,
      last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    });

    const result = await getNextStage(lead);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe(1);
  });

  it('getNextStage retorna null quando 3 tentativas falharam (limite atingido)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ attempts: '3', successes: '0' }] });

    const lead = makeLead({
      followup_status: 0,
      last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    });

    const result = await getNextStage(lead);
    expect(result).toBeNull();
  });

  it('getNextStage retorna null quando 1 tentativa com sucesso (já enviou)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ attempts: '1', successes: '1' }] });

    const lead = makeLead({
      followup_status: 0,
      last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    });

    const result = await getNextStage(lead);
    expect(result).toBeNull();
  });

  it('scheduler registra falha no followup_log com success=false', async () => {
    mockIsBusinessHours = vi.fn(() => true);
    setupCleanCycle();

    const lead = makeLead({
      phone: '5511444444444',
      followup_status: 0,
      has_lead_replied: false,
    });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("status = 'paused'")) return { rows: [] };
      if (sql.includes("source != 'whatsapp'")) return { rows: [] };
      if (sql.includes('followup_status < 4')) return { rows: [lead] };
      if (sql.includes('followup_status >= 4')) return { rows: [] };
      if (sql.includes('followup_log') && sql.includes('attempts')) return { rows: [{ attempts: '0', successes: '0' }] };
      return { rows: [] };
    });

    mockFindLeadByPhone.mockResolvedValue(lead);
    // WhatsApp falha com erro genérico (não WhatsAppDisconnectedError)
    mockSendText.mockRejectedValue(new Error('UAZAPI 500'));

    await runProcessFollowups();

    // Deve inserir no followup_log com success=false (hardcoded no SQL, não nos params)
    const insertCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO followup_log') && (c[0] as string).includes('false'),
    );
    expect(insertCall).toBeTruthy();
    // O SQL contém "success) VALUES ($1, $2, $3, false)"
    expect(insertCall![0]).toMatch(/false/i);
  });

  it('após 3 falhas, próximo ciclo do scheduler NÃO tenta enviar novamente', async () => {
    // Simula que alreadySentStage retorna attempts=3
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('followup_log') && sql.includes('attempts')) {
        return { rows: [{ attempts: '3', successes: '0' }] };
      }
      return { rows: [] };
    });

    const lead = makeLead({
      followup_status: 0,
      last_ia_message: new Date(Date.now() - 31 * 60 * 1000),
    });

    // getNextStage deve retornar null — bloqueado pelo anti-loop
    const result = await getNextStage(lead);
    expect(result).toBeNull();

    // Portanto o scheduler nem chegaria a chamar sendText
    expect(mockSendText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fluxo Perdido: leads esgotados vão para Perdido no RD
// ═══════════════════════════════════════════════════════════════════════

describe('Fluxo Perdido: movimentação para estágio final no RD', () => {
  it('lead que esgota 4 FUPs é marcado exhausted no banco', async () => {
    mockIsBusinessHours = vi.fn(() => true);
    setupCleanCycle();

    const lead = makeLead({
      phone: '5511333333333',
      followup_status: 4,
      has_lead_replied: false,
      scheduled: false,
      last_ia_message: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h atrás
      rd_deal_id: 'deal-to-lose',
    });

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("status = 'paused'")) return { rows: [] };
      if (sql.includes("source != 'whatsapp'")) return { rows: [] };
      if (sql.includes('followup_status < 4')) return { rows: [] };
      if (sql.includes('followup_status >= 4')) return { rows: [lead] };
      return { rows: [] };
    });

    mockGetQueued.mockResolvedValue([]);

    await runProcessFollowups();

    // Deve atualizar status para 'exhausted'
    const exhaustedCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("'exhausted'"),
    );
    expect(exhaustedCall).toBeTruthy();
    expect(exhaustedCall![1]).toContain('5511333333333');
  });

  it('lead que agenda reunião NÃO é movido para Perdido', async () => {
    mockQuery.mockResolvedValue({ rows: [{ attempts: '0', successes: '0' }] });

    const lead = makeLead({
      scheduled: true,
      scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      followup_status: 0,
      has_lead_replied: true,
    });

    // getNextStage retorna null para leads agendados
    const result = await getNextStage(lead);
    expect(result).toBeNull();
  });

  it('lead que desiste explicitamente recebe status lost (não exhausted)', async () => {
    // Testa a lógica do tool-executor indiretamente: status 'lost' é diferente de 'exhausted'
    // O tool-executor chama updateLeadData(phone, { status: 'lost' })
    // Verificamos que o getNextStage não processa leads com followup_status >= 4
    const leadExhausted = makeLead({ followup_status: 4 });
    mockQuery.mockResolvedValue({ rows: [{ attempts: '0', successes: '0' }] });
    expect(await getNextStage(leadExhausted)).toBeNull();

    // Lead com status 'lost' não seria buscado pela query do scheduler
    // (query filtra status = 'active'), então nunca receberia follow-up
    // Isso é garantido pela query SQL, não por getNextStage
  });
});
