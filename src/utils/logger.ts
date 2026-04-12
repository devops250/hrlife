import winston from 'winston';
import { env } from '../config/env';

const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, phone, duration_ms, ...rest }) => {
    let line = `${timestamp} ${level}: ${message}`;
    if (phone) line += ` [${phone}]`;
    if (duration_ms) line += ` (${duration_ms}ms)`;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return line + extra;
  }),
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
);

export const logger = winston.createLogger({
  level: 'info',
  format: env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});
