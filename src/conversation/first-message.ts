export function generateFirstMessage(name: string): string {
  const displayName = name || 'Olá';
  return `Olá, ${displayName}! Sou a Helena, assistente virtual da HR Life.
Vi que você demonstrou interesse em proteção familiar e financeira — fico feliz em ajudar 😊

Para montarmos a melhor proposta, preciso de algumas informações:

👤 Nome completo
📆 Data de Nascimento (ex: 01/01/1985)
📏 Altura (ex: 1,75)
⚖️ Peso (ex: 80kg)
💼 Profissão
💰 Renda mensal aproximada (pode ser faixa, ex: "entre 5 e 10 mil")
🚬 Fuma ou fumou nos últimos 24 meses?
🪪 CPF (se preferir não informar, basta digitar "não")`;
}
