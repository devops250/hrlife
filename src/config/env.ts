import dotenv from 'dotenv';
dotenv.config();

const required = [
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'UAZAPI_BASE_URL',
  'UAZAPI_INSTANCE_TOKEN',
  'OPENAI_API_KEY',
  'RDSTATION_API_TOKEN',
  'GOOGLE_CALENDAR_ID',
] as const;

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Variáveis de ambiente obrigatórias faltando: ${missing.join(', ')}`);
  process.exit(1);
}

export const env = {
  PORT: parseInt(process.env.PORT!, 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL!,
  REDIS_URL: process.env.REDIS_URL!,
  UAZAPI_BASE_URL: process.env.UAZAPI_BASE_URL!,
  UAZAPI_INSTANCE_TOKEN: process.env.UAZAPI_INSTANCE_TOKEN!,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  RDSTATION_API_TOKEN: process.env.RDSTATION_API_TOKEN!,
  RD_PIPELINE_ID: process.env.RD_PIPELINE_ID || '699f644acf837a001d6d8dcd',
  RD_STAGE_CONTATO_FEITO: process.env.RD_STAGE_CONTATO_FEITO || '699f644acf837a001d6d8dd0',
  RD_STAGE_AGENDADO: process.env.RD_STAGE_AGENDADO || '699f644acf837a001d6d8dd1',
  RD_STAGE_SEM_RETORNO: process.env.RD_STAGE_SEM_RETORNO || '69b9e2e15d653100132f334e',
  RD_USER_ID: process.env.RD_USER_ID || '699f641152ebb7001765af28',
  GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID!,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'https://sdr-hrlife.cognitaai.com.br/oauth2/callback',
  ALERT_WHATSAPP_NUMBERS: process.env.ALERT_WHATSAPP_NUMBERS || '',
  SPECIALIST_NAME: process.env.SPECIALIST_NAME || 'Rodrigo Souza Lima',
  CHATWOOT_API_URL: process.env.CHATWOOT_API_URL || 'https://tecnologias-chatwoot.rjrumo.easypanel.host',
  CHATWOOT_API_TOKEN: process.env.CHATWOOT_API_TOKEN || '',
  CHATWOOT_ACCOUNT_ID: process.env.CHATWOOT_ACCOUNT_ID || '2',
  CHATWOOT_INBOX_ID: process.env.CHATWOOT_INBOX_ID || '2',
} as const;
