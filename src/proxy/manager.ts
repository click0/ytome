import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getDb } from '../db/init';

// =============================================
// Типи
// =============================================

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyConfig {
  id:        number;
  url:       string;        // повний URL: socks5://user:pass@host:port
  protocol:  ProxyProtocol;
  host:      string;
  port:      number;
  username?: string;
  password?: string;
  label?:    string;        // назва для зручності
  enabled:   boolean;
  healthy:   boolean;       // остання перевірка
  fail_count: number;       // підряд невдалих перевірок
  last_used_at?:  string;
  last_check_at?: string;
  last_error?:    string;
}

// Режими використання проксі
export type ProxyMode =
  | 'disabled'    // прямий доступ
  | 'single'      // завжди перший активний
  | 'rotation'    // round-robin між здоровими
  | 'fallback';   // пряме з'єднання якщо всі проксі недоступні

let _rotationIndex = 0;

// =============================================
// Схема БД (викликається з migrate-004)
// =============================================

export function createProxyTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT    NOT NULL UNIQUE,
      protocol      TEXT    NOT NULL DEFAULT 'http'
                            CHECK(protocol IN ('http','https','socks5')),
      host          TEXT    NOT NULL,
      port          INTEGER NOT NULL,
      username      TEXT,
      password      TEXT,
      label         TEXT,
      enabled       BOOLEAN NOT NULL DEFAULT 1,
      healthy       BOOLEAN NOT NULL DEFAULT 1,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      last_used_at  DATETIME,
      last_check_at DATETIME,
      last_error    TEXT,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Глобальний режим роботи проксі
    INSERT OR IGNORE INTO settings (key, value) VALUES ('proxy_mode', 'disabled');
  `);
  db.close();
}

// =============================================
// CRUD
// =============================================

export function addProxy(input: {
  url:       string;
  label?:    string;
  enabled?:  boolean;
}): ProxyConfig {
  const parsed = parseProxyUrl(input.url);
  const db = getDb();

  const row = db.prepare(`
    INSERT INTO proxies (url, protocol, host, port, username, password, label, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      label   = excluded.label,
      enabled = excluded.enabled
    RETURNING *
  `).get(
    input.url,
    parsed.protocol,
    parsed.host,
    parsed.port,
    parsed.username || null,
    parsed.password || null,
    input.label || null,
    input.enabled !== false ? 1 : 0,
  ) as any;

  db.close();
  return rowToProxy(row);
}

export function removeProxy(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
  db.close();
}

export function setProxyEnabled(id: number, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE proxies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  db.close();
}

export function listProxies(): ProxyConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM proxies ORDER BY id').all() as any[];
  db.close();
  return rows.map(rowToProxy);
}

export function getProxyMode(): ProxyMode {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'proxy_mode'").get() as any;
  db.close();
  return (row?.value as ProxyMode) || 'disabled';
}

export function setProxyMode(mode: ProxyMode): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('proxy_mode', ?)").run(mode);
  db.close();
}

// =============================================
// Вибір проксі (rotation / single / fallback)
// =============================================

export function getNextProxy(): ProxyConfig | null {
  const mode = getProxyMode();
  if (mode === 'disabled') return null;

  const db      = getDb();
  const healthy = db.prepare(
    'SELECT * FROM proxies WHERE enabled = 1 AND healthy = 1 ORDER BY id'
  ).all() as any[];
  db.close();

  if (healthy.length === 0) return null;

  if (mode === 'single' || mode === 'fallback') {
    return rowToProxy(healthy[0]);
  }

  // rotation — round-robin
  _rotationIndex = _rotationIndex % healthy.length;
  const chosen = rowToProxy(healthy[_rotationIndex]);
  _rotationIndex++;
  return chosen;
}

// =============================================
// Створення HTTP-агента для axios / googleapis
// =============================================

export function buildAgent(proxy: ProxyConfig | null): any {
  if (!proxy) return undefined;

  if (proxy.protocol === 'socks5') {
    return new SocksProxyAgent(proxy.url);
  }
  return new HttpsProxyAgent(proxy.url);
}

/**
 * Повертає конфіг для axios з проксі-агентом.
 * Використовувати як: axios.get(url, axiosProxyConfig())
 */
export function axiosProxyConfig(): object {
  const proxy = getNextProxy();
  if (!proxy) return {};

  const agent = buildAgent(proxy);
  markUsed(proxy.id);

  return {
    httpAgent:  agent,
    httpsAgent: agent,
    proxy:      false,   // вимикаємо вбудований axios-proxy, бо використовуємо agent
  };
}

/**
 * Конфіг для googleapis (передається як httpOptions).
 * googleapis використовує google-auth-library, який приймає fetchImplementation.
 */
export function googleApiProxyConfig(): { agent?: any } {
  const proxy = getNextProxy();
  if (!proxy) return {};
  markUsed(proxy.id);
  return { agent: buildAgent(proxy) };
}

// =============================================
// Health check
// =============================================

export async function checkProxyHealth(
  proxy: ProxyConfig,
  testUrl = 'https://www.youtube.com/robots.txt'
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const axios = (await import('axios')).default;
  const agent = buildAgent(proxy);
  const start = Date.now();

  try {
    await axios.get(testUrl, {
      httpAgent:  agent,
      httpsAgent: agent,
      proxy:      false,
      timeout:    8000,
    });
    const latencyMs = Date.now() - start;
    markHealthy(proxy.id, true);
    return { ok: true, latencyMs };
  } catch (e: any) {
    const msg = e.message || 'unknown error';
    markHealthy(proxy.id, false, msg);
    return { ok: false, error: msg };
  }
}

export async function checkAllProxies(): Promise<Array<{
  id: number; label?: string; url: string; ok: boolean; latencyMs?: number; error?: string;
}>> {
  const all = listProxies().filter(p => p.enabled);
  const results = await Promise.all(all.map(async p => {
    const r = await checkProxyHealth(p);
    return { id: p.id, label: p.label, url: p.url, ...r };
  }));
  return results;
}

// =============================================
// Утиліти
// =============================================

function markUsed(id: number) {
  const db = getDb();
  db.prepare('UPDATE proxies SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  db.close();
}

function markHealthy(id: number, ok: boolean, error?: string) {
  const db = getDb();
  db.prepare(`
    UPDATE proxies SET
      healthy       = ?,
      fail_count    = CASE WHEN ? THEN 0 ELSE fail_count + 1 END,
      last_check_at = CURRENT_TIMESTAMP,
      last_error    = ?
    WHERE id = ?
  `).run(ok ? 1 : 0, ok ? 1 : 0, error || null, id);
  db.close();
}

function parseProxyUrl(raw: string): {
  protocol: ProxyProtocol; host: string; port: number;
  username?: string; password?: string;
} {
  // Нормалізуємо socks5h → socks5
  const normalized = raw.replace(/^socks5h:\/\//, 'socks5://');
  const u = new URL(normalized);

  const protocol = (u.protocol.replace(':', '') as ProxyProtocol) || 'http';
  return {
    protocol: ['http','https','socks5'].includes(protocol) ? protocol : 'http',
    host:     u.hostname,
    port:     parseInt(u.port) || (protocol === 'https' ? 443 : 1080),
    username: u.username || undefined,
    password: u.password || undefined,
  };
}

function rowToProxy(r: any): ProxyConfig {
  return {
    id:           r.id,
    url:          r.url,
    protocol:     r.protocol,
    host:         r.host,
    port:         r.port,
    username:     r.username,
    password:     r.password,
    label:        r.label,
    enabled:      !!r.enabled,
    healthy:      !!r.healthy,
    fail_count:   r.fail_count,
    last_used_at: r.last_used_at,
    last_check_at:r.last_check_at,
    last_error:   r.last_error,
  };
}
