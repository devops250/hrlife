const DDD_TO_STATE: Record<string, string> = {
  // São Paulo
  '11': 'SP', '12': 'SP', '13': 'SP', '14': 'SP', '15': 'SP',
  '16': 'SP', '17': 'SP', '18': 'SP', '19': 'SP',
  // Rio de Janeiro
  '21': 'RJ', '22': 'RJ', '24': 'RJ',
  // Espírito Santo
  '27': 'ES', '28': 'ES',
  // Minas Gerais
  '31': 'MG', '32': 'MG', '33': 'MG', '34': 'MG', '35': 'MG',
  '37': 'MG', '38': 'MG',
  // Paraná
  '41': 'PR', '42': 'PR', '43': 'PR', '44': 'PR', '45': 'PR', '46': 'PR',
  // Santa Catarina
  '47': 'SC', '48': 'SC', '49': 'SC',
  // Rio Grande do Sul
  '51': 'RS', '53': 'RS', '54': 'RS', '55': 'RS',
  // Distrito Federal
  '61': 'DF',
  // Goiás
  '62': 'GO', '64': 'GO',
  // Mato Grosso
  '65': 'MT', '66': 'MT',
  // Mato Grosso do Sul
  '67': 'MS',
  // Acre
  '68': 'AC',
  // Rondônia
  '69': 'RO',
  // Bahia
  '71': 'BA', '73': 'BA', '74': 'BA', '75': 'BA', '77': 'BA',
  // Sergipe
  '79': 'SE',
  // Pernambuco
  '81': 'PE', '87': 'PE',
  // Alagoas
  '82': 'AL',
  // Paraíba
  '83': 'PB',
  // Rio Grande do Norte
  '84': 'RN',
  // Ceará
  '85': 'CE', '88': 'CE',
  // Piauí
  '86': 'PI', '89': 'PI',
  // Pará
  '91': 'PA', '93': 'PA', '94': 'PA',
  // Amazonas
  '92': 'AM', '97': 'AM',
  // Roraima
  '95': 'RR',
  // Amapá
  '96': 'AP',
  // Tocantins
  '63': 'TO',
  // Maranhão
  '98': 'MA', '99': 'MA',
};

/**
 * Extrai o estado (UF) a partir do DDD do telefone brasileiro.
 * Espera formato: 55DDXXXXXXXX (13 dígitos com prefixo 55).
 * Retorna null se DDD não reconhecido ou formato inválido.
 */
export function extractStateFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Formato esperado: 55 + DDD(2) + número(8-9) = 12-13 dígitos
  if (digits.length < 12 || !digits.startsWith('55')) return null;
  const ddd = digits.slice(2, 4);
  return DDD_TO_STATE[ddd] ?? null;
}
