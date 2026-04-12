import { google } from 'googleapis';
import { Request, Response } from 'express';
import { env } from '../config/env';
import { query } from '../database/client';
import { logger } from '../utils/logger';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

export function handleOAuthStart(_req: Request, res: Response): void {
  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.redirect(authUrl);
}

export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const code = req.query.code as string;

  if (!code) {
    res.status(400).send('Parâmetro "code" ausente.');
    return;
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    await query(
      `INSERT INTO google_tokens (id, access_token, refresh_token, expiry_date)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         access_token = $1,
         refresh_token = COALESCE($2, google_tokens.refresh_token),
         expiry_date = $3,
         updated_at = NOW()`,
      [tokens.access_token, tokens.refresh_token, tokens.expiry_date?.toString()],
    );

    logger.info('Google OAuth2 tokens salvos com sucesso');
    res.send('Google Calendar conectado com sucesso! Pode fechar esta janela.');
  } catch (error) {
    logger.error('Erro no OAuth2 callback', { error });
    res.status(500).send('Erro ao conectar com Google Calendar.');
  }
}

export async function getAuthenticatedClient() {
  const oauth2Client = getOAuth2Client();

  const result = await query('SELECT access_token, refresh_token, expiry_date FROM google_tokens WHERE id = 1');

  if (result.rows.length === 0) {
    throw new Error('Google Calendar não autorizado. Acesse /oauth2/google para autorizar.');
  }

  const { access_token, refresh_token, expiry_date } = result.rows[0];

  oauth2Client.setCredentials({
    access_token,
    refresh_token,
    expiry_date: expiry_date ? parseInt(expiry_date, 10) : undefined,
  });

  oauth2Client.on('tokens', async (newTokens) => {
    try {
      await query(
        `UPDATE google_tokens SET
           access_token = $1,
           expiry_date = $2,
           updated_at = NOW()
         WHERE id = 1`,
        [newTokens.access_token, newTokens.expiry_date?.toString()],
      );
      logger.info('Google OAuth2 tokens atualizados (refresh automático)');
    } catch (err) {
      logger.error('Erro ao salvar tokens atualizados', { error: err });
    }
  });

  return oauth2Client;
}
