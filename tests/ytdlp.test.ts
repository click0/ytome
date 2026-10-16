/**
 * yt-dlp: аргументи (надійність, формати, cookies, проксі), завантаження
 * й субтитри — child_process підмінено, справжній процес не запускається.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

  it('a failed download does not leak proxy credentials from the command line', async () => {
    px.addProxy({ url: 'socks5://user:s3cret@10.0.0.9:1080' });
    px.setProxyMode('single');
    proc.handler = (args) => new Error(`Command failed: yt-dlp ${args.join(' ')}\nERROR: 403`);
    const e = await y.downloadVideo('vid00000001').catch(err => err);
    expect(e.message).toContain('--proxy socks5://***@10.0.0.9:1080');
    expect(e.message).not.toContain('s3cret');
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

describe('JS runtime for YouTube', () => {
  let savedPath: string | undefined;
  const binDir = () => path.join(tmp, 'bin');
  beforeEach(() => {
    savedPath = process.env.PATH;
    delete process.env.YTDLP_JS_RUNTIME;
    fs.rmSync(binDir(), { recursive: true, force: true });
    fs.mkdirSync(binDir(), { recursive: true });
    process.env.PATH = binDir();          // ані deno, ані інших програм
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.YTDLP_JS_RUNTIME;
  });

  it('parses stable, patch and nightly versions', () => {
    expect(y.parseYtDlpVersion('2025.11.12')).toEqual([2025, 11, 12]);
    expect(y.parseYtDlpVersion('2026.01.05.1\n')).toEqual([2026, 1, 5]);
    expect(y.parseYtDlpVersion('2025.12.31.232920')).toEqual([2025, 12, 31]);
    expect(y.parseYtDlpVersion('unknown')).toBeNull();
  });

  it('without deno: enables the Node ytome runs on', () => {
    expect(y.jsRuntimeArgs('2025.11.12')).toEqual(['--js-runtimes', `node:${process.execPath}`]);
  });

  it('with deno on PATH: nothing to add (yt-dlp enables deno itself)', () => {
    const deno = path.join(binDir(), process.platform === 'win32' ? 'deno.exe' : 'deno');
    fs.writeFileSync(deno, '');
    // Windows: регістр не важливий, розширення приходить з PATHEXT (.EXE)
    const norm = (p: string | null) => (process.platform === 'win32' ? p?.toLowerCase() : p);
    expect(norm(y.findExecutable('deno'))).toBe(norm(deno));
    expect(y.jsRuntimeArgs('2026.09.01')).toEqual([]);
  });

  it('old yt-dlp or unknown version: the option would be rejected, so it is not sent', () => {
    expect(y.jsRuntimeArgs('2025.10.22')).toEqual([]);
    expect(y.jsRuntimeArgs(undefined)).toEqual([]);
  });

  it('YTDLP_JS_RUNTIME: explicit runtime or none', () => {
    process.env.YTDLP_JS_RUNTIME = 'bun:/opt/bun/bin/bun';
    expect(y.jsRuntimeArgs('2026.09.01')).toEqual(['--js-runtimes', 'bun:/opt/bun/bin/bun']);
    process.env.YTDLP_JS_RUNTIME = 'none';
    expect(y.jsRuntimeArgs('2026.09.01')).toEqual([]);
  });

  it('downloads and subtitle fetches pass the runtime to yt-dlp', async () => {
    const file = path.join(storage, 'media', 'audio', 'vid00000001.mp3');
    proc.handler = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return { stdout: file }; };
    await y.downloadVideo('vid00000001');
    expect(downloadCall().args.join(' ')).toContain(`--js-runtimes node:${process.execPath}`);

    proc.calls = [];
    proc.handler = () => ({});
    await y.downloadSubtitles('vid00000001');
    expect(downloadCall().args.join(' ')).toContain(`--js-runtimes node:${process.execPath}`);
  });
});

describe('searchVideos', () => {
  const json = JSON.stringify({ entries: [
    { id: 'vid00000001', title: 'First', channel: 'Chan', channel_id: 'UCc', duration: 61.7, view_count: 1000, ie_key: 'Youtube' },
    { id: 'PLlist', title: 'A playlist', ie_key: 'YoutubeTab' },
    { id: 'vid00000002', uploader: 'Up' },
    null,
  ] });

  it('flat search, no quota: maps entries and skips playlists/channels', async () => {
    proc.handler = () => ({ stdout: json });
    const r = await y.searchVideos('rust tutorial', { limit: 5 });
    expect(r).toEqual([
      { youtube_id: 'vid00000001', title: 'First', channel: 'Chan', channel_id: 'UCc', duration_sec: 62, view_count: 1000, url: 'https://youtube.com/watch?v=vid00000001' },
      { youtube_id: 'vid00000002', title: 'Untitled', channel: 'Up', channel_id: undefined, duration_sec: undefined, view_count: undefined, url: 'https://youtube.com/watch?v=vid00000002' },
    ]);
    const { args } = downloadCall();
    expect(args[0]).toBe('ytsearch5:rust tutorial');
    expect(args).toEqual(expect.arrayContaining(['--flat-playlist', '--dump-single-json']));
  });

  it('limit clamped to 1..50, a query cannot become an option', async () => {
    proc.handler = () => ({ stdout: '{"entries": []}' });
    await y.searchVideos('--exec rm', { limit: 500 });
    expect(downloadCall().args[0]).toBe('ytsearch50:--exec rm');
    proc.calls = [];
    await y.searchVideos('x', { limit: 0 });
    expect(downloadCall().args[0]).toBe('ytsearch1:x');
  });

  it('broken output and failures are errors without credentials', async () => {
    proc.handler = () => ({ stdout: 'not json' });
    await expect(y.searchVideos('x')).rejects.toThrow(/unreadable/);
    proc.handler = () => new Error('Command failed: yt-dlp --proxy http://u:pw@h:1');
    await expect(y.searchVideos('x')).rejects.toThrow('http://***@h:1');
  });
});

describe('srtToText', () => {
  it('drops counters, timecodes and tags, joins lines', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nworld  again\n';
    expect(y.srtToText(srt)).toBe('Hello world again');
  });
});
