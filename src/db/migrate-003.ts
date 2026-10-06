import { createQuotaTable } from './quota';
import { getDb } from './init';
import { createLogger } from '../logger';

export function migrate003(): void {
  createQuotaTable();

  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '3')`).run();

  createLogger('migrate').info('migration 003 applied: quota_log + quota_daily');
}

if (require.main === module) {
  migrate003();
}
