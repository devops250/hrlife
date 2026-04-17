/**
 * Gera os 2 balões da mensagem de boas-vindas da Helena.
 * Balão 1: saudação curta. Balão 2: lista de dados necessários.
 * Retorna array com 2 strings (enviar com 2s de delay entre elas).
 */
export function generateFirstMessages(name: string): [string, string] {
  const displayName = name && name !== 'Olá' ? name.split(' ')[0] : '';

  const greeting = displayName
    ? `Olá ${displayName}, eu sou a Helena 😊`
    : `Olá, eu sou a Helena 😊`;

  const details = `Para montarmos a melhor proposta, preciso de algumas informações:

👤 Nome completo
📆 Data de Nascimento: (ex: 01/01/2026)
📏 Altura? (ex: 1,75)
⚖️ Peso? (ex: 80kg)
💼 Profissão?
💰 Renda mensal aproximada
🚬 Fuma ou fumou nos últimos 24 meses?
🪪 CPF`;

  return [greeting, details];
}

/** Backward-compatible: retorna mensagem única (para logs e Chatwoot) */
export function generateFirstMessage(name: string): string {
  return generateFirstMessages(name).join('\n\n');
}
