import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * Basic Auth middleware para dashboard.
 * Se DASHBOARD_PASS não configurado, retorna 503 (dashboard desabilitado).
 */
export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const dashUser = env.DASHBOARD_USER;
  const dashPass = env.DASHBOARD_PASS;

  if (!dashPass) {
    res.status(503).json({ error: 'Dashboard desabilitado. Configure DASHBOARD_PASS.' });
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Helena Dashboard"');
    res.status(401).json({ error: 'Autenticação necessária' });
    return;
  }

  const base64 = authHeader.slice(6);
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');

  if (user === dashUser && pass === dashPass) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Helena Dashboard"');
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
}
