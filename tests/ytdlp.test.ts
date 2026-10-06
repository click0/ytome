/**
 * yt-dlp: аргументи (надійність, формати, cookies, проксі), завантаження
 * й субтитри — child_process підмінено, справжній процес не запускається.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

type Reply = { stdout?: string; stderr?: string } | Error;
const proc = vi.hoisted(() => ({
  calls: [] as Array<{ bin: string; args: string[]; opts: any }>,
  handler: (_args: string[]): Reply => ({ stdout: '' }),
}));

vi.mock('child_process', () => ({
  execFile: (bin: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    proc.calls.push({ bin, args, opts: typeof opts === 'function' ? undefined : opts });
    const r = args[0] === '--version' ? { stdout: '2026.09.01\n', stderr: '' } : proc.handler(args);
    setImmediate(() => (r instanceof Error ? done(r) : done(null, { stdout: '', stderr: '', ...r })));
  },
}));

const { tmp, storage } = useTempStorage('ytdlp');

let y: typeof import('../src/youtube/ytdlp');
let px: typeof import('../src/proxy/manager');
let closeDb: () => void;

beforeAll(async () => {
  closeDb = (await initTestDb()).closeDb;
  y = await import('../src/youtube/ytdlp');
  px = await import('../src/proxy/manager');
});

afterAll(() => cleanup(tmp, closeDb));

beforeEach(() => {
  proc.calls = [];
  proc.handler = () => ({ stdout: '' });
  px.setProxyMode('disabled');
  for (const p of px.listProxies()) px.removeProxy(p.id);
});

const downloadCall = () => proc.calls.find(c => c.args[0] !== '--version')!;

describe('checkYtDlp', () => {
  it('reports the version', async () => {
    expect(await y.checkYtDlp()).toEqual({ available: true, version: '2026.09.01' });
  });
});

describe('downloadVideo', () => {
  function produce(file: string) {
    proc.handler = () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(2048));
      return { stdout: `[download] stuff\n${file}\n` };
    };
  }

  it('audio: mp3 extraction, resilience flags, file size from the printed path', async () => {
    const file = path.join(storage, 'media', 'audio', 'vid00000001.mp3');
    produce(file);
    const r = await y.downloadVideo('vid00000001');
    expect(r).toEqual({ filePath: file, format: 'audio', fileSize: 2048 });

    const { args, opts } = downloadCall();
    expect(args[0]).toBe('https://www.youtube.com/watch?v=vid00000001');
    expect(args).toEqual(expect.arrayContaining(['--no-playlist', '-x', '--audio-format', 'mp3', '--continue']));
    expect(args.join(' ')).toContain('--retries 10 --fragment-retries 10 --retry-sleep exp=1:120');
    expect(args.join(' ')).toContain(`--output ${path.join(storage, 'media', 'audio', '%(id)s.%(ext)s')}`);
    expect(opts.timeout).toBe(30 * 60 * 1000);
    expect(args).not.toContain('--proxy');
    expect(args).not.toContain('--cookies');
  });

  it('video / video_hd formats, subtitles and cookies', async () => {
    const out = path.join(tmp, 'out');
    const file = path.join(out, 'vid00000001.mp4');
    produce(file);
    const cookies = path.join(tmp, 'cookies.txt');
    fs.writeFileSync(cookies, 'x');

    await y.downloadVideo('vid00000001', { format: 'video', outDir: out, subtitles: true, lang: 'uk', cookiePath: cookies });
    let args = downloadCall().args.join(' ');
    expect(args).toContain('-f bestvideo[height<=720]+bestaudio/best[height<=720] --merge-output-format mp4');
    expect(args).toContain('--write-auto-sub --sub-lang uk,uk-* --sub-format vtt --convert-subs srt');
    expect(args).toContain(`--cookies ${cookies}`);

    proc.calls = [];
    await y.downloadVideo('vid00000001', { format: 'video_hd', outDir: out, subtitles: true, cookiePath: path.join(tmp, 'missing.txt') });
    args = downloadCall().args.join(' ');
    expect(args).toContain('-f bestvideo+bestaudio/best');
    expect(args).toContain('--sub-lang en,en-*');
    expect(args).not.toContain('--cookies'); // файлу немає
  });

  it('passes the proxy URL; fails without a healthy proxy unless mode is fallback', async () => {
    const file = path.join(storage, 'media', 'audio', 'vid00000001.mp3');
    produce(file);
    px.addProxy({ url: 'socks5://10.0.0.9:1080' });
    px.setProxyMode('single');
    await y.downloadVideo('vid00000001');
    expect(downloadCall().args.join(' ')).toContain('--proxy socks5://10.0.0.9:1080');

    for (const p of px.listProxies()) px.setProxyEnabled(p.id, false);
    await expect(y.downloadVideo('vid00000001')).rejects.toThrow(/no healthy proxy/);

    px.setProxyMode('fallback');
    proc.calls = [];
    await y.downloadVideo('vid00000001');
    expect(downloadCall().args).not.toContain('--proxy');
  });

  it('errors when yt-dlp prints nothing or the file is missing', async () => {
    proc.handler = () => ({ stdout: '', stderr: 'ERROR: boom' });
    await expect(y.downloadVideo('vid00000001')).rejects.toThrow(/produced no output[\s\S]*boom/);
    proc.handler = () => ({ stdout: '/nope/file.mp3\n' });
    await expect(y.downloadVideo('vid00000001')).rejects.toThrow(/output file not found/);
  });
});

describe('downloadSubtitles', () => {
  const srtDir = () => path.join(storage, 'transcripts', 'srt');

  it('returns the requested language file, with cookies passed through', async () => {
    const cookies = path.join(tmp, 'c.txt');
    fs.writeFileSync(cookies, 'x');
    proc.handler = () => {
      fs.writeFileSync(path.join(srtDir(), 'vid00000001.ru.srt'), '1\n00:00:00,000 --> 00:00:01,000\nПривет\n');
      return {};
    };
    expect(await y.downloadSubtitles('vid00000001', 'ru', cookies)).toMatch(/Привет/);
    const args = downloadCall().args.join(' ');
    expect(args).toContain('--skip-download');
    expect(args).toContain('--sub-lang ru,ru-*,en');
    expect(args).toContain(`--cookies ${cookies}`);
    expect(downloadCall().opts.timeout).toBe(60_000);
  });

  it('falls back to English, null when nothing was written or yt-dlp failed', async () => {
    fs.rmSync(srtDir(), { recursive: true, force: true });
    proc.handler = () => { fs.writeFileSync(path.join(srtDir(), 'vid00000002.en.srt'), 'Hello'); return {}; };
    expect(await y.downloadSubtitles('vid00000002', 'de')).toBe('Hello');

    proc.handler = () => ({});
    expect(await y.downloadSubtitles('vid00000003', 'de')).toBeNull();

    proc.handler = () => new Error('HTTP Error 429');
    expect(await y.downloadSubtitles('vid00000004')).toBeNull();
  });
});

describe('srtToText', () => {
  it('drops counters, timecodes and tags, joins lines', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nworld  again\n';
    expect(y.srtToText(srt)).toBe('Hello world again');
  });
});
