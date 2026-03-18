import { createQuotaTable } from './quota';
import { getDb } from './init';

export function migrate003(): void {
  createQuotaTable();

  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '3')`).run();
  db.close();

  console.log('✅ Migration 003 applied: quota_log + quota_daily');
}

if (require.main === module) {
  migrate003();
}
