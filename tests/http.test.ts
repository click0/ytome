/**
 * HTTP/SSE-сервер: повний обмін через SSE, ключ, Host (DNS rebinding),
 * rate limit, ліміт сесій і розміру тіла, небезпечна конфігурація.
 * Справжній express на випадковому порту, БД тимчасова.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const { tmp } = useTempStorage('http');

let srv: typeof import('../src/mcp/server-http');
let init: Awaited<ReturnType<typeof initTestDb>>;
const servers: http.Server[] = [];

beforeAll(async () => {
  init = await initTestDb();
  srv = await import('../src/mcp/server-http');
});

afterAll(() => {
  for (const s of servers) s.close();
  cleanup(tmp, init.closeDb);
});

type Cfg = import('../src/mcp/server-http').HttpConfig;
const baseCfg: Cfg = {
  host: 'localhost', port: 0, apiKey: '', rateWindowMs: 60_000, rateMax: 100,
  maxSessions: 5, allowedHosts: [], corsOrigins: [],
};

async function start(over: Partial<Cfg> = {}) {
  const { app, sessions } = srv.createApp({ ...baseCfg, ...over });
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, sessions };
}

/** Звичайний запит з довільними заголовками (fetch не дає задати Host) */
function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path,
      headers: { host: `localhost:${port}`, ...opts.headers } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Відкрита SSE-сесія: endpoint і очікування подій */
function openSse(port: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; endpoint?: string; next: (id: number) => Promise<any>; close: () => void }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/sse', headers: { host: `localhost:${port}`, ...headers } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode!, next: async () => null, close: () => req.destroy() });
      }
      let buf = '';
      const events: Array<{ event: string; data: string }> = [];
      const waiters: Array<() => void> = [];
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { event: 'message', data: '' };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            if (line.startsWith('data: ')) ev.data += line.slice(6);
          }
          events.push(ev);
          waiters.splice(0).forEach(w => w());
        }
      });
      const take = async (pred: (e: { event: string; data: string }) => boolean) => {
        for (;;) {
          const i = events.findIndex(pred);
          if (i >= 0) return events.splice(i, 1)[0];
          await new Promise<void>(r => waiters.push(r));
        }
      };
      take(e => e.event === 'endpoint').then(e => resolve({
        status: 200,
        endpoint: e.data,
        next: async (id: number) => JSON.parse((await take(x => x.event === 'message' && JSON.parse(x.data).id === id)).data),
        close: () => req.destroy(),
      }));
    });
    req.on('error', reject);
  });
}

const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

describe('configuration', () => {
  it('refuses to listen on the network without an API key', () => {
    expect(srv.unsafeConfigReason({ ...baseCfg, host: '0.0.0.0' })).toMatch(/MCP_API_KEY/);
    expect(srv.unsafeConfigReason({ ...baseCfg, host: '192.168.1.5', apiKey: 'k' })).toBeNull();
    expect(srv.unsafeConfigReason({ ...baseCfg, host: '127.0.0.1' })).toBeNull();
    expect(srv.isLoopback('::1')).toBe(true);
    expect(srv.isLoopback('127.0.0.2')).toBe(true);
    expect(srv.isLoopback('0.0.0.0')).toBe(false);
  });

  it('reads the environment', () => {
    const cfg = srv.configFromEnv({ MCP_HOST: '0.0.0.0', MCP_API_KEY: 'k', MCP_MAX_SESSIONS: '3', MCP_ALLOWED_HOSTS: 'NAS.local, x' });
    expect(cfg).toMatchObject({ host: '0.0.0.0', apiKey: 'k', maxSessions: 3, allowedHosts: ['nas.local', 'x'], port: 3000 });
  });
});

describe('SSE session', () => {
  it('initialize → tools/list → tools/call over the session endpoint', async () => {
    const { port, sessions } = await start();
    const s = await openSse(port);
    expect(s.endpoint).toMatch(/^\/messages\?sessionId=[0-9a-f-]{36}$/);
    expect(sessions.size).toBe(1);

    const post = (body: string) => request(port, { method: 'POST', path: s.endpoint!, body,
      headers: { 'content-type': 'application/json' } });
    expect((await post(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))).status).toBe(202);
    expect((await s.next(1)).result.serverInfo.name).toBe('ytome');
    await post(rpc(2, 'tools/list'));
    expect((await s.next(2)).result.tools.length).toBeGreaterThan(50);
    await post(rpc(3, 'tools/call', { name: 'quota_status', arguments: {} }));
    expect((await s.next(3)).result.content[0].text).toContain('"limit"');

    s.close();
    await new Promise(r => setTimeout(r, 50));
    expect(sessions.size).toBe(0);
  });

  it('unknown session, oversized body', async () => {
    const { port } = await start();
    expect((await request(port, { method: 'POST', path: '/messages?sessionId=nope', body: '{}',
      headers: { 'content-type': 'application/json' } })).status).toBe(404);
    const s = await openSse(port);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(2 * 1024 * 1024) } });
    expect((await request(port, { method: 'POST', path: s.endpoint!, body: big,
      headers: { 'content-type': 'application/json' } })).status).toBe(413);
    s.close();
  });
});

describe('access control', () => {
  it('without a key only local Host names are accepted (DNS rebinding)', async () => {
    const { port } = await start();
    expect((await request(port, { path: '/health' })).status).toBe(200);
    expect((await request(port, { path: '/health', headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
    expect((await request(port, { path: '/sse', headers: { host: 'evil.example:80' } })).status).toBe(403);
    const { port: p2 } = await start({ allowedHosts: ['nas.local'] });
    expect((await request(p2, { path: '/health', headers: { host: 'nas.local:3000' } })).status).toBe(200);
  });

  it('with a key: Bearer or x-api-key, any Host; wrong or missing key → 401', async () => {
    const { port } = await start({ apiKey: 's3cret', host: '0.0.0.0' });
    expect((await openSse(port)).status).toBe(401);
    expect((await openSse(port, { authorization: 'Bearer wrong' })).status).toBe(401);
    const a = await openSse(port, { authorization: 'Bearer s3cret', host: 'nas.lan:3000' });
    expect(a.status).toBe(200);
    // Basic від reverse proxy не заважає правильному x-api-key
    const b = await openSse(port, { authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': 's3cret' });
    expect(b.status).toBe(200);
    a.close(); b.close();
    // /health і /tools — без ключа (лише метадані)
    expect((await request(port, { path: '/health' })).status).toBe(200);
  });

  it('rate limit is per IP, applied before the key check (rotating keys do not help)', async () => {
    const { port } = await start({ apiKey: 'k', rateMax: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await openSse(port, { 'x-api-key': `guess-${i}` })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('caps the number of open sessions', async () => {
    const { port, sessions } = await start({ maxSessions: 2 });
    const a = await openSse(port);
    const b = await openSse(port);
    expect((await openSse(port)).status).toBe(503);
    a.close();
    await new Promise(r => setTimeout(r, 50));
    expect(sessions.size).toBe(1);
    const c = await openSse(port);
    expect(c.status).toBe(200);
    b.close(); c.close();
  });
});
