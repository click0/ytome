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

dotenv.config({ quiet: true });

const level  = process.env.LOG_LEVEL  || 'info';
const pretty = process.env.LOG_PRETTY !== 'false';

// Логи — лише в stderr: у stdio MCP-сервері stdout є каналом протоколу,
// і будь-який рядок, що не є JSON-RPC, ламає з'єднання з клієнтом.
const STDERR = 2;

export const logger = pretty
  ? pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          destination: STDERR,
        },
      },
    })
  : pino({ level }, pino.destination(STDERR));

/** Дочірній логер з контекстом модуля */
export function createLogger(module: string) {
  return logger.child({ module });
}
