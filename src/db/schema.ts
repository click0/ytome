/**
 * Повна схема БД при старті: init + міграції 002–007 (усі ідемпотентні).
 * Свіжа інсталяція працює без ручного запуску міграцій; актуальна база — без змін.
 */
import { getDb, initDb } from './init';
import { migrate002 } from './migrate-002';
import { migrate003 } from './migrate-003';
import { migrate004 } from './migrate-004';
import { migrate005 } from './migrate-005';
import { migrate006 } from './migrate-006';
import { migrate007 } from './migrate-007';

export const SCHEMA_VERSION = 7;

export function currentSchemaVersion(): number {
  const db = getDb();
  const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
  if (!hasSettings) return 0;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return parseInt(row?.value || '0') || 0;
}

/** Довести схему до SCHEMA_VERSION; повертає true, якщо щось змінилось */
export function ensureSchema(): boolean {
  if (currentSchemaVersion() >= SCHEMA_VERSION) return false;
  initDb();
  migrate002();
  migrate003();
  migrate004();
  migrate005();
  migrate006();
  migrate007();
  return true;
}
