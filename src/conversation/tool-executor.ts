/**
 * Tool Executor — Separa execução de tools do engine de conversa.
 *
 * Resolve:
 * - Engine.ts era "god object" com 330+ linhas
 * - Cada tool agora é isolada e testável
 * - Validações centralizadas
 * - Dedup de cadastra_lead
 */

import { logger } from '../utils/logger';
import { findLeadByPhone, updateLeadData } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { getNextAvailableSlots } from '../scheduling/availability';
import { createEvent, deleteEvent, updateEvent, findEventByLeadName, listEvents, checkFreeBusy } from '../scheduling/calendar.service';
import { syncLeadCreated, syncLeadScheduled } from '../crm/sync';
import { updateDeal, updateContact } from '../crm/rdstation.service';
import { trackToolCall } from '../monitoring/metrics';
import { notifyLeadScheduled } from '../monitoring/alerts';

// Dedup: evitar cadastra_lead duplicada na mesma fase
const recentCadastro = new Map<string, number>();

// Nomes inválidos
const INVALID_NAMES = ['cliente', 'lead', 'usuário', 'usuario', 'olá', 'ola', 'oi', ''];

export async function executeTool(name: string, args: Record<string, string>, phone: string): Promise<string> {
  logger.info(`Executando tool: ${name}`, { phone, args });
  trackToolCall(name);

  switch (name) {
    case 'cadastra_lead':
      return execCadastraLead(args, phone);
    case 'consulta_horario':
      return execConsultaHorario(args);
    case 'registra_agendamento':
      return execRegistraAgendamento(args, phone);
    case 'cancela_agendamento':
      return execCancelaAgendamento(args, phone);
    case 'update_agendamento':
      return execUpdateAgendamento(args, phone);
    default:
      logger.warn(`Tool desconhecida: ${name}`, { phone });
      return `Tool "${name}" não encontrada.`;
  }
}

async function execCadastraLead(args: Record<string, string>, phone: string): Promise<string> {
  // Validar nome
  if (INVALID_NAMES.includes(args.nome_completo?.toLowerCase()?.trim())) {
    return 'Nome inválido. Pergunte o nome completo do lead antes de cadastrar.';
  }

  // Dedup: se já chamou nos últimos 30s com mesmo estado, pular
  const dedupeKey = `${phone}:${args.agendado}`;
  const lastCall = recentCadastro.get(dedupeKey);
  if (lastCall && Date.now() - lastCall < 30000) {
    logger.info('cadastra_lead duplicada ignorada', { phone, agendado: args.agendado });
    return `Dados de ${args.nome_completo} já registrados.`;
  }
  recentCadastro.set(dedupeKey, Date.now());

  try {
    await updateLeadData(phone, {
      name: args.nome_completo || undefined,
      birth_date: args.data_nascimento || undefined,
      cpf: args.cpf || undefined,
      height: args.altura || undefined,
      weight: args.peso || undefined,
      profession: args.profissao || undefined,
      income: args.renda_mensal || undefined,
      smoker: args.fumante || undefined,
      scheduled: args.agendado === 'true',
    });

    const status = args.agendado === 'true' ? 'agendado' : 'cadastrado';
    logger.info(`Lead ${status}`, { phone, nome: args.nome_completo });

    // CRM Sync (assíncrono — não bloqueia resposta ao lead)
    const lead = await findLeadByPhone(phone);
    if (lead) {
      if (args.agendado === 'true') {
        syncLeadScheduled(lead).catch((err) => logger.error('CRM sync falhou (scheduled)', { phone, error: err }));
      } else {
        syncLeadCreated(lead).catch((err) => logger.error('CRM sync falhou (created)', { phone, error: err }));
      }

      // Atualizar nome do deal e contato no RD (se nome mudou)
      if (args.nome_completo && lead.rd_deal_id) {
        updateDeal(lead.rd_deal_id, { name: `${args.nome_completo} - Lead IA` }).catch((err) =>
          logger.warn('Falha ao atualizar nome do deal no RD', { phone, error: err }),
        );
      }
      if (args.nome_completo && lead.rd_contact_id) {
        updateContact(lead.rd_contact_id, { name: args.nome_completo }).catch((err) =>
          logger.warn('Falha ao atualizar nome do contato no RD', { phone, error: err }),
        );
      }
    }

    return `Lead ${args.nome_completo} ${status} com sucesso no sistema.`;
  } catch (error) {
    logger.error('Erro ao cadastrar lead', { phone, error });
    return 'Erro ao cadastrar dados. Os dados foram recebidos e serão processados.';
  }
}

async function execConsultaHorario(args: Record<string, string>): Promise<string> {
  try {
    const period = args.periodo as 'manha' | 'tarde' | 'noite';
    const slots = await getNextAvailableSlots(period, 3);

    const periodNames = { manha: 'manhã', tarde: 'tarde', noite: 'noite' };
    const periodName = periodNames[period] || period;

    if (slots.length === 0) {
      return `Não há horários disponíveis no período da ${periodName} nos próximos 14 dias. Sugira outro período ao lead.`;
    }

    const formatted = slots.map((s, i) => `${i + 1}. ${s.formatted}`).join('\n');
    return `Horários disponíveis (${periodName}):\n${formatted}\n\nApresente estas opções ao lead.`;
  } catch (error) {
    logger.error('Erro ao consultar horários', { error });
    return 'Erro ao consultar horários. Peça desculpas ao lead e tente novamente.';
  }
}

async function execRegistraAgendamento(args: Record<string, string>, phone: string): Promise<string> {
  try {
    const { data, horario, nome_lead } = args;
    const startDateTime = `${data}T${horario}:00`;
    const startDate = new Date(`${data}T${horario}:00`);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const endDateTime = `${endDate.getFullYear()}-${pad2(endDate.getMonth() + 1)}-${pad2(endDate.getDate())}T${pad2(endDate.getHours())}:${pad2(endDate.getMinutes())}:00`;

    // Double-check: verificar se o slot ainda está disponível (freeBusy)
    const slotStart = new Date(`${data}T${horario}:00-03:00`);
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const busyPeriods = await checkFreeBusy(
      new Date(slotStart.getTime() - 60 * 60 * 1000),
      new Date(slotEnd.getTime() + 60 * 60 * 1000),
    );
    const conflict = busyPeriods.find((b) =>
      b.start.getTime() < slotEnd.getTime() && b.end.getTime() > slotStart.getTime(),
    );
    if (conflict) {
      logger.warn('Slot ocupado no momento do registro, buscando alternativos', { phone, data, horario });

      // Buscar horários alternativos automaticamente
      const hour = parseInt(horario.split(':')[0], 10);
      const autoPeriod = hour < 12 ? 'manha' : hour < 18 ? 'tarde' : 'noite';
      const altSlots = await getNextAvailableSlots(autoPeriod as 'manha' | 'tarde' | 'noite', 3);

      if (altSlots.length > 0) {
        const formatted = altSlots.map((s, i) => `${i + 1}. ${s.formatted}`).join('\n');
        return `O horário ${horario} do dia ${data} não está mais disponível. Horários atualizados:\n${formatted}\n\nApresente ESTES horários ao lead e peça para escolher. NÃO diga que o agendamento foi confirmado.`;
      }
      return `O horário ${horario} do dia ${data} não está mais disponível e não há outros horários nesse período. Sugira outro período ao lead. NÃO diga que o agendamento foi confirmado.`;
    }

    const event = await createEvent({
      summary: `HR Life - ${nome_lead}`,
      description: `Apresentação de proteção familiar e financeira para ${nome_lead}.\nTelefone: ${phone}`,
      startDateTime,
      endDateTime,
    });

    await updateLeadData(phone, {
      scheduled: true,
      scheduled_at: new Date(`${data}T${horario}:00-03:00`),
    });

    // Notificar Gabriel
    notifyLeadScheduled(phone, nome_lead, `${data} às ${horario}`).catch(() => {});

    const meetInfo = event.meetLink ? `\nLink do Google Meet: ${event.meetLink}` : '';
    return `Agendamento confirmado para ${nome_lead} em ${data} às ${horario}.${meetInfo}\nID do evento: ${event.id}`;
  } catch (error) {
    logger.error('Erro ao registrar agendamento', { phone, error });
    return 'Erro ao registrar agendamento. Peça desculpas ao lead e tente novamente.';
  }
}

async function execCancelaAgendamento(args: Record<string, string>, phone: string): Promise<string> {
  try {
    const event = await findEventByLeadName(args.nome_lead);
    if (!event) {
      return `Não foi encontrado agendamento para ${args.nome_lead}.`;
    }

    await deleteEvent(event.id);
    await updateLeadData(phone, { scheduled: false, scheduled_at: null });

    return `Agendamento de ${args.nome_lead} cancelado com sucesso.`;
  } catch (error) {
    logger.error('Erro ao cancelar agendamento', { phone, error });
    return 'Erro ao cancelar agendamento. Peça desculpas ao lead e tente novamente.';
  }
}

async function execUpdateAgendamento(args: Record<string, string>, phone: string): Promise<string> {
  try {
    const event = await findEventByLeadName(args.nome_lead);
    if (!event) {
      return `Não foi encontrado agendamento para ${args.nome_lead} para reagendar.`;
    }

    const { nova_data, novo_horario } = args;
    const startDateTime = `${nova_data}T${novo_horario}:00`;
    const endHour = parseInt(novo_horario.split(':')[0], 10) + 1;
    const endDateTime = `${nova_data}T${String(endHour).padStart(2, '0')}:${novo_horario.split(':')[1]}:00`;

    const updated = await updateEvent(event.id, { startDateTime, endDateTime });
    await updateLeadData(phone, {
      scheduled_at: new Date(`${nova_data}T${novo_horario}:00-03:00`),
    });

    const meetInfo = updated.meetLink ? `\nLink do Google Meet: ${updated.meetLink}` : '';
    return `Agendamento de ${args.nome_lead} reagendado para ${nova_data} às ${novo_horario}.${meetInfo}`;
  } catch (error) {
    logger.error('Erro ao reagendar', { phone, error });
    return 'Erro ao reagendar. Peça desculpas ao lead e tente novamente.';
  }
}
