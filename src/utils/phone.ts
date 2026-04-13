export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  const digits = input.replace(/\D/g, "");

  // Rejeitar vazio, muito curto, ou muito longo (CNPJ tem 14 dígitos)
  if (digits.length < 10 || digits.length > 13) return null;

  // 13 dígitos com prefixo 55 — formato correto
  if (digits.length === 13 && digits.startsWith("55")) {
    return digits;
  }

  // 12 dígitos com prefixo 55 — inserir 9 de celular
  if (digits.length === 12 && digits.startsWith("55")) {
    return digits.slice(0, 4) + "9" + digits.slice(4);
  }

  // 12 dígitos começando com 0 (ex: 051995318698) — strip do 0 + adicionar 55
  if (digits.length === 12 && digits.startsWith("0")) {
    return "55" + digits.slice(1);
  }

  // 11 dígitos (DDD + 9 + 8 dígitos)
  if (digits.length === 11) {
    return "55" + digits;
  }

  // 10 dígitos (DDD + 8 dígitos) — inserir 9
  if (digits.length === 10) {
    return "55" + digits.slice(0, 2) + "9" + digits.slice(2);
  }

  // Formato não reconhecido
  return null;
}
