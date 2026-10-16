/**
 * doctor: статуси й підказки для кожної області. Процеси (yt-dlp, ffmpeg),
 * YouTube API і HTTP підмінено, БД справжня.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const m = vi.hoisted(() => ({
  ytdlpVersion: '2026.09.01' as string | null,
  ffmpeg: true,
  channelsList: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: (bin: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setImmediate(() => {
      if (bin.includes('ffmpeg')) {
        return m.ffmpeg ? done(null, { stdout: 'ffmpeg version 7.1 Copyright\nmore', stderr: '' })
          : done(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
      }
      if (args[0] === '--version') {
        return m.ytdlpVersion ? done(null, { stdout: m.ytdlpVersion + '\n', stderr: '' })
          : done(Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }));
      }
      done(new Error('unexpected call'));
    });
  },
}));
vi.mock('googleapis', () => ({ google: { youtube: () => ({ channels: { list: m.channelsList } }) } }));
vi.mock('axios', () => ({ default: { post: m.post, get: m.get, request: vi.fn() } }));

const { tmp } = useTempStorage('doctor');

let d: typeof import('../src/doctor/index');
let init: Awaited<ReturnType<typeof initTestDb>>;

const ENV = ['YOUTUBE_API_KEY', 'YTDLP_JS_RUNTIME', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'OLLAMA_ENABLED', 'LMSTUDIO_ENABLED', 'OPENROUTER_API_KEY', 'WHISPER_PROVIDER', 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
  'GOOGLE_DRIVE_FOLDER_ID', 'AUTO_SUMMARY'];

const byArea = (r: import('../src/doctor/index').DoctorReport, area: string) => r.checks.find(c => c.area === area)!;

beforeAll(async () => {
  init = await initTestDb();
  d = await import('../src/doctor/index');
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.OLLAMA_ENABLED = 'false';
  m.ytdlpVersion = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '.');
  m.ffmpeg = true;
  m.channelsList.mockReset();
  m.post.mockReset();
  m.get.mockReset();
});

describe('doctor', () => {
  it('fresh install: what works, what is missing, and how to fix it', async () => {
    const r = await d.runDoctor();
    expect(r.network).toBe(false);
    expect(byArea(r, 'node').status).toBe('ok');
    expect(byArea(r, 'yt-dlp')).toMatchObject({ status: 'ok' });
    expect(byArea(r, 'js-runtime').status).toBe('ok');
    expect(byArea(r, 'ffmpeg')).toMatchObject({ status: 'ok', message: 'ffmpeg version 7.1 Copyright' });
    expect(byArea(r, 'youtube-api')).toMatchObject({ status: 'error', fix: expect.stringMatching(/YOUTUBE_API_KEY/) });
    expect(byArea(r, 'quota').status).toBe('ok');
    expect(byArea(r, 'database')).toMatchObject({ status: 'ok', message: expect.stringMatching(/схема 7, 0 каналів, 0 відео/) });
    expect(byArea(r, 'storage').status).toBe('ok');
    expect(byArea(r, 'profiles').status).toBe('off');
    expect(byArea(r, 'proxy').status).toBe('off');
    expect(byArea(r, 'ai')).toMatchObject({ status: 'warn', fix: expect.stringMatching(/Ollama|GROQ/) });
    expect(byArea(r, 'whisper').status).toBe('off');
    expect(byArea(r, 'google').status).toBe('off');
    expect(r.summary.error).toBe(1);
    expect(r.summary.ok + r.summary.warn + r.summary.error + r.summary.off).toBe(r.checks.length);

    const text = d.formatReport(r);
    expect(text).toMatch(/❌ youtube-api/);
    expect(text).toMatch(/→ console\.cloud\.google\.com/);
    expect(text).toMatch(/мережеві перевірки: --network/);
  });

  it('yt-dlp missing, too old for JS runtimes, stale, or forced without a runtime', async () => {
    m.ytdlpVersion = null;
    let r = await d.runDoctor();
    expect(byArea(r, 'yt-dlp')).toMatchObject({ status: 'error', fix: expect.stringMatching(/pip install/) });
    expect(r.checks.find(c => c.area === 'js-runtime')).toBeUndefined();

    m.ytdlpVersion = '2025.06.30';
    r = await d.runDoctor();
    expect(byArea(r, 'yt-dlp')).toMatchObject({ status: 'warn', message: expect.stringMatching(/днів/) });
    expect(byArea(r, 'js-runtime')).toMatchObject({ status: 'warn', message: expect.stringMatching(/JS-середовища/) });

    m.ytdlpVersion = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    process.env.YTDLP_JS_RUNTIME = 'none';
    r = await d.runDoctor();
    expect(byArea(r, 'js-runtime').status).toBe('warn');
  });

  it('ffmpeg missing is a warning that names what stops working', async () => {
    m.ffmpeg = false;
    const r = await d.runDoctor();
    expect(byArea(r, 'ffmpeg')).toMatchObject({ status: 'warn', message: expect.stringMatching(/Whisper/) });
  });

  it('network: checks the API key (1 quota unit) and reports failures', async () => {
    process.env.YOUTUBE_API_KEY = 'key';
    m.channelsList.mockResolvedValueOnce({ data: { items: [] } });
    let r = await d.runDoctor({ network: true });
    expect(byArea(r, 'youtube-api')).toMatchObject({ status: 'ok', message: expect.stringMatching(/1 одиниця/) });
    expect(byArea(r, 'quota').message).toMatch(/1\/10000/);

    m.channelsList.mockRejectedValueOnce(new Error('API key not valid'));
    r = await d.runDoctor({ network: true });
    expect(byArea(r, 'youtube-api')).toMatchObject({ status: 'error', message: expect.stringMatching(/API key not valid/) });

    r = await d.runDoctor();
    expect(byArea(r, 'youtube-api').message).toMatch(/network: true/);
    expect(m.channelsList).toHaveBeenCalledTimes(2);
  });

  it('quota near the limit', async () => {
    const { trackQuota } = await import('../src/db/quota');
    trackQuota('search.list', undefined, 85);
    expect(byArea(await d.runDoctor(), 'quota').status).toBe('warn');
    trackQuota('search.list', undefined, 11);
    expect(byArea(await d.runDoctor(), 'quota').status).toBe('error');
    init.getDb().exec('DELETE FROM quota_log; DELETE FROM quota_daily;');
  });

  it('profiles: valid, expiring, expired and broken cookies', async () => {
    const { addProfile } = await import('../src/profiles/manager');
    const now = Math.floor(Date.now() / 1000);
    const write = (name: string, expires: number) => {
      const p = path.join(tmp, `${name}.txt`);
      fs.writeFileSync(p, `.youtube.com\tTRUE\t/\tTRUE\t${expires}\tSID\tx\n`);
      return p;
    };
    addProfile({ name: 'good', cookiePath: write('good', now + 90 * 86400) });
    addProfile({ name: 'soon', cookiePath: write('soon', now + 2 * 86400) });
    const expired = write('expired', now + 86400);
    addProfile({ name: 'expired', cookiePath: expired });
    fs.writeFileSync(expired, `.youtube.com\tTRUE\t/\tTRUE\t${now - 60}\tSID\tx\n`);
    const broken = write('broken', now + 86400);
    addProfile({ name: 'broken', cookiePath: broken });
    fs.rmSync(broken);

    const r = await d.runDoctor();
    expect(byArea(r, 'profile:good').status).toBe('ok');
    expect(byArea(r, 'profile:soon')).toMatchObject({ status: 'warn', message: expect.stringMatching(/спливає за 1|спливає за 2/) });
    expect(byArea(r, 'profile:expired')).toMatchObject({ status: 'warn', message: expect.stringMatching(/прострочені/) });
    expect(byArea(r, 'profile:broken')).toMatchObject({ status: 'error', fix: expect.stringMatching(/cookies\.txt/) });
  });

  it('proxies: configured mode without proxies, last known health, live check', async () => {
    const px = await import('../src/proxy/manager');
    px.setProxyMode('single');
    expect(byArea(await d.runDoctor(), 'proxy').status).toBe('error');
    px.setProxyMode('fallback');
    expect(byArea(await d.runDoctor(), 'proxy').status).toBe('warn');

    const p = px.addProxy({ url: 'http://u:pw@127.0.0.1:9' });
    expect(byArea(await d.runDoctor(), 'proxy')).toMatchObject({ status: 'ok', message: expect.stringMatching(/1\/1 здорових/) });
    m.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const live = byArea(await d.runDoctor({ network: true }), 'proxy');
    expect(live).toMatchObject({ status: 'error', message: expect.stringMatching(/відповідають 0\/1/) });
    expect(JSON.stringify(live)).not.toContain('pw');
    px.removeProxy(p.id);
    px.setProxyMode('disabled');
  });

  it('AI, auto summaries, Whisper and Google settings', async () => {
    process.env.GROQ_API_KEY = 'gsk';
    let r = await d.runDoctor();
    expect(byArea(r, 'ai')).toMatchObject({ status: 'ok', message: expect.stringMatching(/groq/) });
    expect(byArea(r, 'whisper')).toMatchObject({ status: 'ok', message: expect.stringMatching(/transcribe_audio \(groq\)/) });

    m.post.mockRejectedValueOnce(new Error('401 invalid key'));
    r = await d.runDoctor({ network: true });
    expect(byArea(r, 'ai')).toMatchObject({ status: 'error', fix: expect.stringMatching(/groq: 401 invalid key/) });

    process.env.WHISPER_PROVIDER = 'auto';
    expect(byArea(await d.runDoctor(), 'whisper').message).toMatch(/Автоматично.*groq/);
    process.env.WHISPER_PROVIDER = 'openai';
    expect(byArea(await d.runDoctor(), 'whisper').status).toBe('warn');

    init.getDb().prepare("INSERT INTO channels (youtube_id, name, auto_summary) VALUES ('UCa', 'A', 1)").run();
    expect(byArea(await d.runDoctor(), 'auto-summary').status).toBe('ok');
    process.env.AUTO_SUMMARY = 'false';
    expect(byArea(await d.runDoctor(), 'auto-summary').status).toBe('warn');

    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = path.join(tmp, 'missing.json');
    expect(byArea(await d.runDoctor(), 'google').status).toBe('error');
    fs.writeFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, '{}');
    expect(byArea(await d.runDoctor(), 'google')).toMatchObject({ status: 'ok', message: expect.stringMatching(/folder_id/) });
  });
});
