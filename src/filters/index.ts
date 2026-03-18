import { getDb } from '../db/init';

// =============================================
// Типи
// =============================================

export type FilterType  = 'whitelist' | 'blacklist';
export type FilterScope = 'channel' | 'description';

export interface FilterRule {
  id:         number;
  type:       FilterType;
  scope:      FilterScope;
  value:      string;       // channel_id/@handle | keyword | 'video'|'short'
  case_sensitive: boolean;
  note?:      string;
  enabled:    boolean;
  created_at: string;
  hit_count:  number;       // скільки разів спрацювало
}

export interface VideoCandidate {
  youtube_id:          string;
  channel_youtube_id:  string;
  title:               string;
  description?:        string;
  type:                'video' | 'short';
}

export interface FilterResult {
  allowed:  boolean;
  reason?:  string;         // пояснення якщо заблоковано/дозволено правилом
  rule_id?: number;
}

// =============================================
// Схема БД (викликається з migrate-004)
// =============================================

export function createFilterTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS filter_rules (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      type           TEXT    NOT NULL CHECK(type IN ('whitelist','blacklist')),
      scope          TEXT    NOT NULL CHECK(scope IN ('channel','description')),
      value          TEXT    NOT NULL,
      case_sensitive BOOLEAN NOT NULL DEFAULT 0,
      note           TEXT,
      enabled        BOOLEAN NOT NULL DEFAULT 1,
      hit_count      INTEGER NOT NULL DEFAULT 0,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type, scope, value)
    );

    CREATE INDEX IF NOT EXISTS idx_filter_type  ON filter_rules(type);
    CREATE INDEX IF NOT EXISTS idx_filter_scope ON filter_rules(scope);
  `);
  db.close();
}

// =============================================
// CRUD
// =============================================

export function addFilterRule(input: {
  type:           FilterType;
  scope:          FilterScope;
  value:          string;
  caseSensitive?: boolean;
  note?:          string;
}): FilterRule {
  const db  = getDb();
  const row = db.prepare(`
    INSERT INTO filter_rules (type, scope, value, case_sensitive, note)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type, scope, value) DO UPDATE SET
      enabled        = 1,
      case_sensitive = excluded.case_sensitive,
      note           = excluded.note
    RETURNING *
  `).get(
    input.type,
    input.scope,
    input.value,
    input.caseSensitive ? 1 : 0,
    input.note || null,
  ) as any;
  db.close();
  return rowToRule(row);
}

export function removeFilterRule(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM filter_rules WHERE id = ?').run(id);
  db.close();
}

export function setFilterEnabled(id: number, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE filter_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  db.close();
}

export function listFilterRules(opts: {
  type?:  FilterType;
  scope?: FilterScope;
} = {}): FilterRule[] {
  const db = getDb();
  let sql  = 'SELECT * FROM filter_rules WHERE 1=1';
  const params: any[] = [];

  if (opts.type)  { sql += ' AND type = ?';  params.push(opts.type); }
  if (opts.scope) { sql += ' AND scope = ?'; params.push(opts.scope); }

  sql += ' ORDER BY type, scope, value';

  const rows = db.prepare(sql).all(...params) as any[];
  db.close();
  return rows.map(rowToRule);
}

export function clearFilterRules(type?: FilterType): void {
  const db = getDb();
  type
    ? db.prepare('DELETE FROM filter_rules WHERE type = ?').run(type)
    : db.prepare('DELETE FROM filter_rules').run();
  db.close();
}

// =============================================
// Движок фільтрації
// =============================================

/**
 * Перевірити відео проти всіх активних правил.
 *
 * Логіка:
 *   1. Якщо є хоча б одне WHITELIST-правило в даному scope —
 *      відео ПОВИННО відповідати хоча б одному з них, інакше блокується.
 *   2. Якщо відео відповідає будь-якому BLACKLIST-правилу — блокується.
 *   3. Якщо жодне правило не спрацювало — дозволяється.
 */
export function applyFilters(video: VideoCandidate): FilterResult {
  const db   = getDb();
  const rules = db.prepare(
    'SELECT * FROM filter_rules WHERE enabled = 1 ORDER BY type, scope'
  ).all() as any[];
  db.close();

  if (rules.length === 0) return { allowed: true };

  const typed = rules.map(rowToRule);

  // ── WHITELIST перевірка ──────────────────────────
  const whitelists = typed.filter(r => r.type === 'whitelist');

  if (whitelists.length > 0) {
    // Групуємо по scope — кожен scope незалежний
    const wlScopes = [...new Set(whitelists.map(r => r.scope))];

    for (const scope of wlScopes) {
      const scopeRules = whitelists.filter(r => r.scope === scope);
      const matched    = scopeRules.find(r => matchRule(r, video));

      if (!matched) {
        return {
          allowed: false,
          reason:  `whitelist [${scope}]: no matching rule for "${getField(video, scope)}"`,
        };
      }
      incrementHit(matched.id);
    }
  }

  // ── BLACKLIST перевірка ──────────────────────────
  const blacklists = typed.filter(r => r.type === 'blacklist');

  for (const rule of blacklists) {
    if (matchRule(rule, video)) {
      incrementHit(rule.id);
      return {
        allowed:  false,
        reason:   `blacklist [${rule.scope}]: "${rule.value}" matched "${getField(video, rule.scope)}"`,
        rule_id:  rule.id,
      };
    }
  }

  return { allowed: true };
}

/**
 * Пакетна фільтрація — повертає тільки дозволені відео
 * та статистику по відфільтрованих.
 */
export function filterVideos<T extends VideoCandidate>(videos: T[]): {
  allowed:  T[];
  blocked:  Array<{ video: T; reason: string }>;
} {
  const allowed:  T[]                               = [];
  const blocked:  Array<{ video: T; reason: string }> = [];

  for (const video of videos) {
    const result = applyFilters(video);
    if (result.allowed) {
      allowed.push(video);
    } else {
      blocked.push({ video, reason: result.reason || 'filtered' });
    }
  }

  return { allowed, blocked };
}

// =============================================
// Утиліти
// =============================================

function matchRule(rule: FilterRule, video: VideoCandidate): boolean {
  const field = getField(video, rule.scope);
  if (!field) return false;

  const value = rule.case_sensitive ? rule.value        : rule.value.toLowerCase();
  const text  = rule.case_sensitive ? field             : field.toLowerCase();

  if (rule.scope === 'channel') {
    // Точний збіг для channel ID або @handle
    const normalized = rule.value.startsWith('@')
      ? rule.value.toLowerCase()
      : rule.value;
    return text === normalized || text === rule.value;
  }

  if (rule.scope === 'content_type') {
    return text === value;
  }

  // title / description — пошук підрядка
  return text.includes(value);
}

function getField(video: VideoCandidate, scope: FilterScope): string {
  switch (scope) {
    case 'channel':     return video.channel_youtube_id;
    case 'description': return video.description || '';
  }
}

function incrementHit(id: number) {
  const db = getDb();
  db.prepare('UPDATE filter_rules SET hit_count = hit_count + 1 WHERE id = ?').run(id);
  db.close();
}

function rowToRule(r: any): FilterRule {
  return {
    id:             r.id,
    type:           r.type,
    scope:          r.scope,
    value:          r.value,
    case_sensitive: !!r.case_sensitive,
    note:           r.note,
    enabled:        !!r.enabled,
    created_at:     r.created_at,
    hit_count:      r.hit_count,
  };
}
