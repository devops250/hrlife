export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.length === 13 && digits.startsWith('55')) {
    return digits;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    // 55 + DDD(2) + 8 dígitos — inserir 9
    return digits.slice(0, 4) + '9' + digits.slice(4);
  }
  if (digits.length === 11) {
    // DDD(2) + 9 dígitos
    return '55' + digits;
  }
  if (digits.length === 10) {
    // DDD(2) + 8 dígitos — inserir 9
    return '55' + digits.slice(0, 2) + '9' + digits.slice(2);
  }
  if (digits.length === 9) {
    // Sem DDD — não é possível determinar, retorna como está com prefixo
    return '55' + digits;
  }

  return digits;
}
