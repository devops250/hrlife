import type { Lead } from '../database/leads.repo';
import { query } from '../database/client';

export const FOLLOWUP_TEMPLATES = {
  1: { delayMinutes: 30,   message: (name: string) => `${name}, tudo certo? Pode ter sido um momento corrido. Podemos continuar de onde paramos.` },
  2: { delayMinutes: 120,  message: (name: string) => `${name}, queria reforçar que a proposta da HR Life é montada de forma personalizada para o seu perfil — por isso precisamos de algumas informações antes de apresentá-la. O processo é direto e leva poucos minutos. Vamos dar sequência?` },
  3: { delayMinutes: 360,  message: (name: string) => `${name}, nosso consultor Rodrigo Souza Lima tem disponibilidade limitada na agenda desta semana. Para garantir um horário exclusivo para a sua apresentação, preciso finalizar o seu cadastro antes da reserva. Se ainda tiver interesse, é só retornar por aqui.` },
  4: { delayMinutes: 1440, message: (name: string) => `${name}, esta será minha última tentativa de contato por agora. Caso queira conhecer as soluções de proteção familiar e financeira da HR Life em outro momento, basta me enviar uma mensagem e retomamos o processo. Obrigada.` },
} as const;

/**
 * Verifica se já enviou (ou tentou demais) follow-up deste stage para este lead.
 * Conta TODAS as tentativas (sucesso + falha) para evitar loop infinito quando WhatsApp desconecta.
 */
async function alreadySentStage(phone: string, stage: number): Promise<boolean> {
  const result = await query(
    "SELECT COUNT(*) as attempts, COUNT(*) FILTER (WHERE success IS NULL OR success = true) as successes FROM followup_log WHERE phone = $1 AND stage = $2",
    [phone, stage],
  );
  const attempts = parseInt(result.rows[0]?.attempts || '0', 10);
  const successes = parseInt(result.rows[0]?.successes || '0', 10);
  // Bloquear se já enviou com sucesso OU se já tentou 3 vezes (evita spam em caso de falha)
  return successes > 0 || attempts >= 3;
}

export async function getNextStage(lead: Lead): Promise<{ stage: number; message: string } | null> {
  if (lead.scheduled) return null;
  if (lead.followup_status >= 4) return null;
  if (!lead.last_ia_message) return null;

  const now = new Date();
  const lastMsg = new Date(lead.last_ia_message);
  const minutesSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60);

  const nextStage = lead.followup_status + 1;
  const template = FOLLOWUP_TEMPLATES[nextStage as keyof typeof FOLLOWUP_TEMPLATES];

  if (!template) return null;
  if (minutesSince < template.delayMinutes) return null;

  // Verificar se já enviou este stage (anti-loop)
  const sent = await alreadySentStage(lead.phone, nextStage);
  if (sent) return null;

  const name = lead.name || 'Olá';
  return {
    stage: nextStage,
    message: template.message(name),
  };
}
