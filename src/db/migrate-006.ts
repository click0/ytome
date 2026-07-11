/**
 * Міграція 006: трекінг експортованих Google Sheets
 */
import { getDb } from './init';
import { createLogger } from '../logger';

const log = createLogger('migrate');

export function migrate006(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sheet_exports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      spreadsheet_id  TEXT NOT NULL,
      export_type     TEXT NOT NULL
                      CHECK(export_type IN ('subscriptions','watch_later','stats')),
      url             TEXT NOT NULL,
      title           TEXT NOT NULL,
      last_exported   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(spreadsheet_id, export_type)
    );
  `);

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '6')`).run();
  log.info('migration 006 applied: sheet_exports');
}

if (require.main === module) {
  migrate006();
}
