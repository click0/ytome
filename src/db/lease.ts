/**
 * Міжпроцесне «оренда» в SQLite: одна перевірка каналів і одна черга підсумків
 * одночасно — навіть коли їх запускають і планувальник (npm run scheduler),
 * і MCP-сервер (sync / summary_run). Після збою процесу оренда спливає сама.
 */
import crypto from 'crypto';
import { getDb } from './init';

export function tryAcquireLease(name: string, ttlSec: number): string | null {
  const token = crypto.randomUUID();
  const now = Date.now();
  const res = getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE json_extract(settings.value, '$.until') < ?
  `).run(`lease:${name}`, JSON.stringify({ token, until: now + ttlSec * 1000 }), now);
  return res.changes > 0 ? token : null;
}

export function releaseLease(name: string, token: string): void {
  getDb().prepare(`DELETE FROM settings WHERE key = ? AND json_extract(value, '$.token') = ?`)
    .run(`lease:${name}`, token);
}

/** fn під орендою; null — інший запуск ще працює */
export async function withLease<T>(name: string, ttlSec: number, fn: () => Promise<T>): Promise<T | null> {
  const token = tryAcquireLease(name, ttlSec);
  if (!token) return null;
  try {
    return await fn();
  } finally {
    releaseLease(name, token);
  }
}
