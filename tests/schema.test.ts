/**
 * ensureSchema: свіжа база отримує всі таблиці без ручних міграцій,
 * актуальна — не змінюється.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { useTempStorage, cleanup } from './helpers/temp-db';

const { tmp } = useTempStorage('schema');
let closeDb: (() => void) | undefined;

afterAll(() => cleanup(tmp, closeDb));

describe('ensureSchema', () => {
  it('creates the full schema on a fresh database, then is a no-op', async () => {
    const init = await import('../src/db/init');
    closeDb = init.closeDb;
    const schema = await import('../src/db/schema');
    expect(schema.currentSchemaVersion()).toBe(0);
    expect(schema.ensureSchema()).toBe(true);
    expect(schema.currentSchemaVersion()).toBe(schema.SCHEMA_VERSION);
    const tables = (init.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      'channels', 'videos', 'transcripts', 'watch_later', 'comments', 'quota_daily', 'proxies',
      'filter_rules', 'profiles', 'music_playlists', 'sheet_exports', 'summaries',
    ]));
    expect(schema.ensureSchema()).toBe(false);
  });
});
