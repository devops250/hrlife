import type { Lead } from '../database/leads.repo';
import { extractStateFromPhone } from '../utils/ddd-to-state';

// IDs dos campos customizados do RD Station CRM (mapeados do contato real)
export const RD_CUSTOM_FIELDS = {
  data_nascimento: '69bb4655626559001e2972b4',
  altura: '69bddd471c94960018bc1e3b',
  peso: '69bddd58fb02050016cc04c0',
  profissao: '69c2fe8d92aa8d001fd8313e',
  renda_mensal: '69bddc67d1fc640019a59ba9',
  fumante: '69bc628005b2d80026edfa48',
  cpf: '69bd76d25047c3001da71f9f',
  filhos: '69bb46a542ab9c00191305f8',
  estado: '69d39f982108b8001335a66e',
};

/** FIX 1: Campo CPF e tipo "cpf" no RD — exige mascara "000.000.000-00" */
function formatCpf(cpf: string): string | null {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return null;
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/** FIX 2: Campo Data de Nascimento e tipo "date" no RD — exige ISO "YYYY-MM-DD" */
function formatDateForRD(dateBR: string): string | null {
  const match = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function buildCustomFields(lead: Lead): Array<{ custom_field_id: string; value: string | string[] }> {
  const fields: Array<{ custom_field_id: string; value: string | string[] }> = [];

  if (lead.birth_date) {
    const isoDate = formatDateForRD(lead.birth_date);
    if (isoDate) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.data_nascimento, value: isoDate });
  }
  if (lead.height) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.altura, value: lead.height });
  if (lead.weight) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.peso, value: lead.weight });
  if (lead.profession) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.profissao, value: lead.profession });
  if (lead.income) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.renda_mensal, value: lead.income });
  if (lead.smoker) {
    const smokerValue = lead.smoker.toLowerCase().includes('sim') ? ['Sim'] : ['Não'];
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.fumante, value: smokerValue });
  }
  if (lead.cpf) {
    const maskedCpf = formatCpf(lead.cpf);
    if (maskedCpf) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.cpf, value: maskedCpf });
  }
  const estado = extractStateFromPhone(lead.phone);
  if (estado) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.estado, value: estado });
  if (lead.filhos) {
    const filhosValue = lead.filhos.toLowerCase().includes('sim') ? ['Sim'] : ['Não'];
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.filhos, value: filhosValue });
  }
  return fields;
}
