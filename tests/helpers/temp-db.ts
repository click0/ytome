/**
 * Тимчасове сховище й БД для тестів, що працюють зі справжнім getDb().
 *
 * Модулі читають STORAGE_PATH / DB_PATH під час імпорту, тому
 * useTempStorage() викликається на верхньому рівні тест-файлу,
 * а модулі src/ імпортуються динамічно вже після нього.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export function useTempStorage(prefix: string): { tmp: string; storage: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ytome-${prefix}-`));
  const storage = path.join(tmp, 'storage');
  process.env.STORAGE_PATH = storage;
  process.env.DB_PATH = path.join(storage, 'test.db');
  process.env.LOG_LEVEL = 'silent';
  process.env.LOG_PRETTY = 'false';
  return { tmp, storage };
}

/** Схема як у робочій інсталяції: init + усі міграції */
export async function initTestDb() {
  const init = await import('../../src/db/init');
  init.initDb();
  (await import('../../src/db/migrate-002')).migrate002();
  (await import('../../src/db/migrate-003')).migrate003();
  (await import('../../src/db/migrate-004')).migrate004();
  (await import('../../src/db/migrate-005')).migrate005();
  (await import('../../src/db/migrate-006')).migrate006();
  return init;
}

/** Канал + відео в БД; повертає id каналу */
export function seedChannel(
  db: import('better-sqlite3').Database,
  ch: { youtube_id: string; name: string; handle?: string; visibility?: 'private' | 'public' },
): number {
  return (db.prepare(`
    INSERT INTO channels (youtube_id, name, handle, visibility) VALUES (?, ?, ?, ?) RETURNING id
  `).get(ch.youtube_id, ch.name, ch.handle ?? null, ch.visibility ?? 'private') as { id: number }).id;
}

export function seedVideo(
  db: import('better-sqlite3').Database,
  channelId: number,
  v: { youtube_id: string; title: string; published_at: string; type?: 'video' | 'short'; description?: string },
): number {
  return (db.prepare(`
    INSERT INTO videos (youtube_id, channel_id, title, description, published_at, type)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `).get(v.youtube_id, channelId, v.title, v.description ?? null, v.published_at, v.type ?? 'video') as { id: number }).id;
}

export function cleanup(tmp: string, closeDb?: () => void): void {
  closeDb?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
