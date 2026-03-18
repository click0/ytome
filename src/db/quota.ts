import { getDb } from './init';

// =============================================
// Вартість операцій YouTube Data API v3
// https://developers.google.com/youtube/v3/determine_quota_cost
// =============================================

export const QUOTA_COSTS = {
  // search.list — найдорожча операція
  'search.list':            100,

  // videos.list — дешева, batch до 50 відео за раз
  'videos.list':            1,

  // channels.list
  'channels.list':          1,

  // commentThreads.list
  'commentThreads.list':    1,

  // comments.list (replies)
  'comments.list':          1,

  // captions.list
  'captions.list':          50,
} as const;

export type QuotaOperation = keyof typeof QUOTA_COSTS;

export const DAILY_QUOTA_LIMIT = 10_000;

// =============================================
// Схема таблиці (додається в migrate-003)
// =============================================

export function createQuotaTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT    NOT NULL,              -- YYYY-MM-DD (UTC)
      operation   TEXT    NOT NULL,              -- search.list, videos.list, ...
      units       INTEGER NOT NULL,              -- скільки одиниць витрачено
      context     TEXT,                          -- channel_id / video_id / etc
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_quota_date ON quota_log(date);

    CREATE TABLE IF NOT EXISTS quota_daily (
      date        TEXT PRIMARY KEY,              -- YYYY-MM-DD (UTC)
      total_used  INTEGER NOT NULL DEFAULT 0,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();
}

// =============================================
// Запис використання квоти
// =============================================

export function trackQuota(
  operation: QuotaOperation,
  context?: string,
  multiplier = 1                               // для batch операцій
): number {
  const cost  = QUOTA_COSTS[operation] * multiplier;
  const today = utcDate();
  const db    = getDb();

  // Детальний лог
  db.prepare(`
    INSERT INTO quota_log (date, operation, units, context)
    VALUES (?, ?, ?, ?)
  `).run(today, operation, cost, context || null);

  // Денний агрегат
  db.prepare(`
    INSERT INTO quota_daily (date, total_used, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(date) DO UPDATE SET
      total_used = total_used + excluded.total_used,
      updated_at = CURRENT_TIMESTAMP
  `).run(today, cost);

  db.close();
  return cost;
}

// =============================================
// Перевірка залишку квоти
// =============================================

export function getQuotaStatus(): {
  date: string;
  used: number;
  remaining: number;
  limit: number;
  percent: number;
  warning: boolean;       // > 80%
  critical: boolean;      // > 95%
} {
  const today = utcDate();
  const db    = getDb();

  const row = db.prepare(
    'SELECT total_used FROM quota_daily WHERE date = ?'
  ).get(today) as any;

  db.close();

  const used      = row?.total_used ?? 0;
  const remaining = Math.max(0, DAILY_QUOTA_LIMIT - used);
  const percent   = Math.round((used / DAILY_QUOTA_LIMIT) * 100);

  return {
    date:      today,
    used,
    remaining,
    limit:     DAILY_QUOTA_LIMIT,
    percent,
    warning:   percent >= 80,
    critical:  percent >= 95,
  };
}

// =============================================
// Перевірка перед операцією
// =============================================

export function canAfford(operation: QuotaOperation, multiplier = 1): boolean {
  const cost   = QUOTA_COSTS[operation] * multiplier;
  const status = getQuotaStatus();
  return status.remaining >= cost;
}

export function assertQuota(operation: QuotaOperation, multiplier = 1): void {
  if (!canAfford(operation, multiplier)) {
    const status = getQuotaStatus();
    throw new Error(
      `YouTube API quota exceeded for today (${status.used}/${status.limit} units used). ` +
      `Resets at midnight UTC. Operation "${operation}" requires ${QUOTA_COSTS[operation] * multiplier} units.`
    );
  }
}

// =============================================
// Статистика за період
// =============================================

export function getQuotaHistory(days = 7): Array<{
  date: string;
  total_used: number;
  percent: number;
}> {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT date, total_used
    FROM quota_daily
    WHERE date >= date('now', ?)
    ORDER BY date DESC
  `).all(`-${days} days`) as any[];
  db.close();

  return rows.map(r => ({
    date:       r.date,
    total_used: r.total_used,
    percent:    Math.round((r.total_used / DAILY_QUOTA_LIMIT) * 100),
  }));
}

export function getQuotaBreakdown(date?: string): Array<{
  operation: string;
  calls: number;
  total_units: number;
}> {
  const db  = getDb();
  const day = date || utcDate();

  const rows = db.prepare(`
    SELECT
      operation,
      COUNT(*)      AS calls,
      SUM(units)    AS total_units
    FROM quota_log
    WHERE date = ?
    GROUP BY operation
    ORDER BY total_units DESC
  `).all(day) as any[];

  db.close();
  return rows;
}

// =============================================
// Утиліти
// =============================================

function utcDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
