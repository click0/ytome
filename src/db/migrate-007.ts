/**
 * Міграція 007: підсумки транскриптів + позначка автопідсумків каналу.
 *
 * Модуль підсумків викликає ensureSummarySchema() сам, тож окремий запуск
 * потрібен лише для явного оновлення схеми (node dist/db/migrate-007.js).
 */
import { getDb } from './init';
import { createLogger } from '../logger';

const log = createLogger('migrate');

export function migrate007(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id        INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
      status          TEXT    NOT NULL DEFAULT 'ok'
                              CHECK(status IN ('ok', 'retry', 'skipped')),
      language        TEXT,
      tldr            TEXT,
      key_points      TEXT,              -- JSON: string[]
      chapters        TEXT,              -- JSON: [{ start, title }]
      provider        TEXT,              -- хто згенерував (groq:..., claude:...)
      prompt_version  INTEGER,
      transcript_hash TEXT,
      reason          TEXT,              -- чому retry/skipped
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at DATETIME,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_status ON summaries(status, next_attempt_at);
  `);

  const cols = db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'auto_summary')) {
    db.exec('ALTER TABLE channels ADD COLUMN auto_summary BOOLEAN NOT NULL DEFAULT 0');
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '7')`).run();
  log.info('migration 007 applied: summaries + channels.auto_summary');
}

let ensured = false;

/** Схема підсумків — один раз на процес, ідемпотентно */
export function ensureSummarySchema(): void {
  if (ensured) return;
  const db = getDb();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'summaries'").get();
  const hasColumn = (db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>)
    .some(c => c.name === 'auto_summary');
  if (!hasTable || !hasColumn) migrate007();
  ensured = true;
}

if (require.main === module) {
  migrate007();
}
