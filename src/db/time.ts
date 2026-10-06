/**
 * Час із SQLite: CURRENT_TIMESTAMP зберігає UTC як "YYYY-MM-DD HH:MM:SS" без зони,
 * а new Date() розбирає такий рядок як локальний час — зсув на часовий пояс.
 */
export function parseSqliteTime(value?: string | null): Date | null {
  if (!value) return null;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  const d = new Date(hasZone ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
