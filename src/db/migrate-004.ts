import { createProxyTable } from '../proxy/manager';
import { createFilterTable } from '../filters/index';
import { getDb } from './init';

export function migrate004(): void {
  createProxyTable();
  createFilterTable();

  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '4')`).run();
  db.close();

  console.log('✅ Migration 004 applied: proxies + filter_rules');
}

if (require.main === module) {
  migrate004();
}
