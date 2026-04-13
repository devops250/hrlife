
export function generateFirstMessage(name: string): string {
  const displayName = name && name !== 'Olá' ? name.split(' ')[0] : '';

  // Mensagem curta e direta — melhor taxa de resposta
  if (displayName) {
    return `Oi, ${displayName}! Sou a Helena, da HR Life. Vi que você se interessou pela proteção familiar.

Para preparar sua cotação personalizada, me conta:
- Sua data de nascimento
- Altura e peso
- Profissão

Pode mandar tudo junto ou uma por uma, como preferir! 😊`;
  }

  return `Oi! Sou a Helena, da HR Life. Vi que você se interessou pela proteção familiar.

Para preparar sua cotação, preciso de algumas informações. Pode me dizer seu nome completo e data de nascimento? 😊`;
}
