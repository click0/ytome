/**
 * Проксі (режими, ротація, агенти, health check) і профілі (cookies, default,
 * прив'язка до каналу) — справжні модулі на тимчасовій БД.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, seedChannel, cleanup } from './helpers/temp-db';

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet } }));

const { tmp } = useTempStorage('proxy');

let px: typeof import('../src/proxy/manager');
let pf: typeof import('../src/profiles/manager');
let init: Awaited<ReturnType<typeof initTestDb>>;

beforeAll(async () => {
  init = await initTestDb();
  px = await import('../src/proxy/manager');
  pf = await import('../src/profiles/manager');
});

afterAll(() => cleanup(tmp, init.closeDb));

describe('proxy CRUD', () => {
  beforeEach(() => {
    for (const p of px.listProxies()) px.removeProxy(p.id);
    px.setProxyMode('disabled');
  });

  it('parses protocol, host, port and credentials from the URL', () => {
    const p = px.addProxy({ url: 'socks5h://user:pw@10.0.0.1:9050', label: 'tor' });
    expect(p).toMatchObject({
      protocol: 'socks5', host: '10.0.0.1', port: 9050, username: 'user', password: 'pw',
      label: 'tor', enabled: true, healthy: true, fail_count: 0,
    });
    expect(px.addProxy({ url: 'https://proxy.example' })).toMatchObject({ protocol: 'https', port: 443 });
    expect(px.addProxy({ url: 'ftp://weird.example' })).toMatchObject({ protocol: 'http', port: 1080 });
  });

  it('re-adding the same URL updates label/enabled instead of duplicating', () => {
    const a = px.addProxy({ url: 'http://1.1.1.1:8080', label: 'a' });
    const b = px.addProxy({ url: 'http://1.1.1.1:8080', label: 'b', enabled: false });
    expect(b.id).toBe(a.id);
    expect(px.listProxies()).toEqual([expect.objectContaining({ label: 'b', enabled: false })]);
    px.setProxyEnabled(a.id, true);
    expect(px.listProxies()[0].enabled).toBe(true);
  });

  it('mode defaults to disabled and is persisted', () => {
    expect(px.getProxyMode()).toBe('disabled');
    px.setProxyMode('rotation');
    expect(px.getProxyMode()).toBe('rotation');
  });
});

describe('proxy selection', () => {
  let a: number, b: number;

  beforeAll(() => {
    for (const p of px.listProxies()) px.removeProxy(p.id);
    a = px.addProxy({ url: 'http://10.0.0.1:3128' }).id;
    b = px.addProxy({ url: 'socks5://10.0.0.2:1080' }).id;
    px.addProxy({ url: 'http://10.0.0.3:3128', enabled: false });
  });

  it('disabled mode never returns a proxy', async () => {
    px.setProxyMode('disabled');
    expect(px.getNextProxy()).toBeNull();
    expect(await px.axiosProxyConfig()).toEqual({});
    expect(await px.googleApiProxyConfig()).toEqual({});
  });

  it('single / fallback use the first healthy proxy', () => {
    px.setProxyMode('single');
    expect(px.getNextProxy()!.id).toBe(a);
    expect(px.getNextProxy()!.id).toBe(a);
    px.setProxyMode('fallback');
    expect(px.getNextProxy()!.id).toBe(a);
  });

  it('rotation cycles through enabled healthy proxies only', () => {
    px.setProxyMode('rotation');
    const ids = [px.getNextProxy(), px.getNextProxy(), px.getNextProxy()].map(p => p!.id);
    expect(new Set(ids)).toEqual(new Set([a, b]));
    expect(ids[0]).toBe(ids[2]);
  });

  it('builds HTTP and SOCKS agents and marks the proxy as used', async () => {
    px.setProxyMode('single');
    const cfg: any = await px.axiosProxyConfig();
    expect(cfg.proxy).toBe(false);
    expect(cfg.httpsAgent.constructor.name).toBe('HttpsProxyAgent');
    expect(cfg.httpAgent).toBe(cfg.httpsAgent);
    expect(px.listProxies().find(p => p.id === a)!.last_used_at).toBeTruthy();

    const socks = await px.buildAgent(px.listProxies().find(p => p.id === b)!);
    expect(socks.constructor.name).toBe('SocksProxyAgent');
    expect(await px.buildAgent(null)).toBeUndefined();
    expect((await px.googleApiProxyConfig()).agent).toBeDefined();
  });

  it('health check marks failures and recovery; unhealthy proxies are skipped', async () => {
    px.setProxyMode('single');
    axiosGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const proxyA = px.listProxies().find(p => p.id === a)!;
    expect(await px.checkProxyHealth(proxyA)).toEqual({ ok: false, error: 'ECONNREFUSED' });
    expect(px.listProxies().find(p => p.id === a)).toMatchObject({ healthy: false, fail_count: 1, last_error: 'ECONNREFUSED' });
    expect(px.getNextProxy()!.id).toBe(b);

    axiosGet.mockResolvedValue({ status: 200 });
    const all = await px.checkAllProxies();
    expect(all.map(r => r.id).sort()).toEqual([a, b].sort()); // вимкнений не перевіряється
    expect(all.every(r => r.ok && typeof r.latencyMs === 'number')).toBe(true);
    expect(px.listProxies().find(p => p.id === a)).toMatchObject({ healthy: true, fail_count: 0, last_error: null });
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ proxy: false, timeout: 8000 });
  });
});

describe('profiles', () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
  let cookiePath: string;

  beforeAll(() => {
    cookiePath = path.join(tmp, 'cookies.txt');
    fs.writeFileSync(cookiePath, `.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tSID\tabc\n`);
    seedChannel(init.getDb(), { youtube_id: 'UCchan', name: 'Chan' });
  });

  it('rejects an invalid cookies file', () => {
    const bad = path.join(tmp, 'bad.txt');
    fs.writeFileSync(bad, '# nothing\n');
    expect(() => pf.addProfile({ name: 'bad', cookiePath: bad })).toThrow(/Invalid cookies file/);
  });

  it('add / upsert by name / get by id or name / list', () => {
    const p = pf.addProfile({ name: 'main', cookiePath, notes: 'n' });
    expect(p).toMatchObject({ name: 'main', cookie_path: cookiePath, is_default: false, enabled: true });
    const again = pf.addProfile({ name: 'main', youtubeApiKey: 'KEY', cookiePath });
    expect(again.id).toBe(p.id);
    expect(again.youtube_api_key).toBe('KEY');
    expect(pf.getProfile(p.id)!.name).toBe('main');
    expect(pf.getProfile('main')!.id).toBe(p.id);
    expect(pf.getProfile('nope')).toBeNull();
    pf.addProfile({ name: 'alt' });
    expect(pf.listProfiles().map(x => x.name)).toEqual(['alt', 'main']);
  });

  it('only one default profile; it is listed first', () => {
    const main = pf.getProfile('main')!;
    const alt = pf.getProfile('alt')!;
    expect(pf.getDefaultProfile()).toBeNull();
    pf.setDefaultProfile(main.id);
    pf.setDefaultProfile(alt.id);
    expect(pf.getDefaultProfile()!.name).toBe('alt');
    expect(pf.listProfiles().filter(p => p.is_default).map(p => p.name)).toEqual(['alt']);
    expect(pf.listProfiles()[0].name).toBe('alt');
  });

  it('channel profile wins over default; cookie header comes from the file', () => {
    const main = pf.getProfile('main')!;
    expect(pf.resolveProfileForChannel('UCchan')!.name).toBe('alt'); // default
    expect(pf.assignChannelProfile('UCchan', main.id)).toBe(true);
    expect(pf.assignChannelProfile('UCmissing', main.id)).toBe(false);
    const resolved = pf.resolveProfileForChannel('UCchan')!;
    expect(resolved.name).toBe('main');
    expect(pf.getProfileCookieHeader(resolved)).toBe('SID=abc');
    expect(pf.getProfileCookieHeader(pf.getProfile('alt'))).toBe('');
    expect(pf.getProfileCookieHeader(null)).toBe('');
    expect(pf.getProfileCookieHeader({ ...resolved, cookie_path: path.join(tmp, 'gone.txt') })).toBe('');
  });

  it('markProfileUsed sets last_used_at; removing a profile unassigns channels', () => {
    const main = pf.getProfile('main')!;
    pf.markProfileUsed(main.id);
    expect(pf.getProfile(main.id)!.last_used_at).toBeTruthy();
    pf.removeProfile(main.id);
    expect(pf.getProfile('main')).toBeNull();
    expect((init.getDb().prepare("SELECT profile_id FROM channels WHERE youtube_id = 'UCchan'").get() as any).profile_id).toBeNull();
    expect(pf.resolveProfileForChannel('UCchan')!.name).toBe('alt');
  });
});
