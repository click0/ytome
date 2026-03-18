/**
 * Структуроване логування через pino.
 *
 * Рівні: trace → debug → info → warn → error → fatal
 * Формат: JSON (production) або pretty-print (development)
 *
 * .env:
 *   LOG_LEVEL=info          (trace|debug|info|warn|error|fatal)
 *   LOG_PRETTY=true         (pretty-print замість JSON)
 */

import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const level  = process.env.LOG_LEVEL  || 'info';
const pretty = process.env.LOG_PRETTY !== 'false';

const transport = pretty
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = pino({
  level,
  ...(transport ? { transport } : {}),
});

/** Дочірній логер з контекстом модуля */
export function createLogger(module: string) {
  return logger.child({ module });
}
