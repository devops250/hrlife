import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// MOCKS
// ============================================================
vi.mock('../database/leads.repo', () => ({
  findLeadByPhone: vi.fn(),
  updateLeadData: vi.fn().mockResolvedValue(undefined),
  updateLeadIaMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../database/events.repo', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../scheduling/calendar.service', () => ({
  checkFreeBusy: vi.fn().mockResolvedValue([]),
  createEvent: vi.fn(),
  deleteEvent: vi.fn().mockResolvedValue(undefined),
  updateEvent: vi.fn(),
  findEventByLeadName: vi.fn().mockResolvedValue(null),
  listEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../scheduling/availability', () => ({
  getNextAvailableSlots: vi.fn(),
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
import { getNextAvailableSlots } from '../scheduling/availability';
import { checkFreeBusy, createEvent } from '../scheduling/calendar.service';
import { getAvailableSlots, SCHEDULE } from '../config/schedule';

const PHONE = '5511999999999';

const mockSlots = [
  { date: new Date('2026-04-14T09:00:00'), time: '09:00', formatted: 'Segunda-feira (14/04) as 09h' },
  { date: new Date('2026-04-14T10:00:00'), time: '10:00', formatted: 'Segunda-feira (14/04) as 10h' },
  { date: new Date('2026-04-15T08:00:00'), time: '08:00', formatted: 'Terca-feira (15/04) as 08h' },
];

// ============================================================
// TESTES
// ============================================================
describe('Fluxo 3: Agendamento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('3.1 consulta_horario retorna slots disponiveis formatados em pt-BR', async () => {
    vi.mocked(getNextAvailableSlots).mockResolvedValueOnce(mockSlots);

    const result = await executeTool('consulta_horario', { periodo: 'manha' }, PHONE);

    expect(result).toContain('Segunda-feira (14/04) as 09h');
    expect(result).toContain('1.');
    expect(result).toContain('manhã');
    expect(vi.mocked(getNextAvailableSlots)).toHaveBeenCalledWith('manha', 3);
  });

  it('3.2 registra_agendamento cria evento com Google Meet e marca lead.scheduled=true', async () => {
    vi.mocked(checkFreeBusy).mockResolvedValue([]);
    vi.mocked(createEvent).mockResolvedValueOnce({
      id: 'evt-001',
      summary: 'HR Life - Joao',
      start: new Date('2026-04-20T09:00:00'),
      end: new Date('2026-04-20T10:00:00'),
      meetLink: 'https://meet.google.com/abc-xyz',
      status: 'confirmed',
    });

    const { updateLeadData } = await import('../database/leads.repo');

    const result = await executeTool(
      'registra_agendamento',
      { data: '2026-04-20', horario: '09:00', nome_lead: 'Joao' },
      PHONE,
    );

    expect(result).toContain('confirmado');
    expect(result).toContain('meet.google.com');
    expect(vi.mocked(updateLeadData)).toHaveBeenCalledWith(
      PHONE,
      expect.objectContaining({ scheduled: true }),
    );
  });

  it('3.3 Slot ocupado retorna mensagem de alternativas automaticamente', async () => {
    // checkFreeBusy retorna conflito no slot solicitado
    vi.mocked(checkFreeBusy).mockResolvedValue([
      {
        start: new Date('2026-04-20T08:00:00-03:00'),
        end: new Date('2026-04-20T10:00:00-03:00'),
      },
    ]);
    vi.mocked(getNextAvailableSlots).mockResolvedValueOnce(mockSlots);

    const result = await executeTool(
      'registra_agendamento',
      { data: '2026-04-20', horario: '09:00', nome_lead: 'Joao' },
      PHONE,
    );

    expect(result).toContain('não está mais disponível');
    expect(result).toContain('NÃO diga que o agendamento foi confirmado');
    expect(vi.mocked(createEvent)).not.toHaveBeenCalled();
  });

  it('3.4 Sabado (6) e domingo (0) nao tem slots na grade de horarios', () => {
    expect(getAvailableSlots(0, 'manha')).toHaveLength(0); // domingo
    expect(getAvailableSlots(0, 'tarde')).toHaveLength(0);
    expect(getAvailableSlots(6, 'manha')).toHaveLength(0); // sabado
    expect(getAvailableSlots(6, 'tarde')).toHaveLength(0);
    // Dias uteis tem slots
    expect(getAvailableSlots(1, 'manha').length).toBeGreaterThan(0); // segunda
    expect(getAvailableSlots(3, 'tarde').length).toBeGreaterThan(0); // quarta
    // Dias sem schedule retornam vazio (nao comissao de erro)
    expect(SCHEDULE[0]).toBeUndefined();
    expect(SCHEDULE[6]).toBeUndefined();
  });

  it('3.5 horario 23:00 nao gera endDateTime T24:00:00 invalido [fix M12]', async () => {
    vi.mocked(checkFreeBusy).mockResolvedValue([]);
    vi.mocked(createEvent).mockResolvedValueOnce({
      id: 'evt-23h',
      summary: 'HR Life - Teste23h',
      start: new Date('2026-04-20T23:00:00'),
      end: new Date('2026-04-21T00:00:00'),
      meetLink: null,
      status: 'confirmed',
    });

    await executeTool(
      'registra_agendamento',
      { data: '2026-04-20', horario: '23:00', nome_lead: 'Teste23h' },
      PHONE,
    );

    const callArgs = vi.mocked(createEvent).mock.calls[0][0];
    expect(callArgs.endDateTime).not.toContain('T24:');
    expect(callArgs.endDateTime).toBe('2026-04-21T00:00:00');
  });
});
