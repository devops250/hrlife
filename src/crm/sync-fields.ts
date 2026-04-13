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
  estado: process.env.RD_FIELD_ESTADO ?? '',
};

export function buildCustomFields(lead: Lead): Array<{ custom_field_id: string; value: string | string[] }> {
  const fields: Array<{ custom_field_id: string; value: string | string[] }> = [];
  if (lead.birth_date) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.data_nascimento, value: lead.birth_date });
  if (lead.height) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.altura, value: lead.height });
  if (lead.weight) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.peso, value: lead.weight });
  if (lead.profession) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.profissao, value: lead.profession });
  if (lead.income) fields.push({ custom_field_id: RD_CUSTOM_FIELDS.renda_mensal, value: lead.income });
  if (lead.smoker) {
    const smokerValue = lead.smoker.toLowerCase().includes('sim') ? ['Sim'] : ['Não'];
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.fumante, value: smokerValue });
  }
  if (lead.cpf) {
    const cleanCpf = lead.cpf.replace(/[.\-\s]/g, '');
    if (/^\d{11}$/.test(cleanCpf)) {
      fields.push({ custom_field_id: RD_CUSTOM_FIELDS.cpf, value: cleanCpf });
    }
  }
  if (RD_CUSTOM_FIELDS.estado) {
    const estado = extractStateFromPhone(lead.phone);
    if (estado) {
      fields.push({ custom_field_id: RD_CUSTOM_FIELDS.estado, value: estado });
    }
  }
  return fields;
}
