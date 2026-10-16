/**
 * Whisper: вибір провайдера (згода), аудіо через yt-dlp → шматки ffmpeg →
 * Groq/OpenAI, зсуви таймкодів між шматками, помилки, прибирання тимчасових файлів.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const m = vi.hoisted(() => ({
  calls: [] as Array<{ bin: string; args: string[] }>,
  ffmpeg: (_args: string[]): Error | null => null,
  chunks: 2,
  post: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: (bin: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    m.calls.push({ bin, args });
    setImmediate(() => {
      if (args[0] === '--version') return done(null, { stdout: '2026.09.01\n', stderr: '' });
      if (bin === 'yt-dlp') {
        const out = args[args.indexOf('--output') + 1].replace('%(id)s.%(ext)s', 'vid.webm');
        fs.writeFileSync(out, 'audio');
        return done(null, { stdout: out + '\n', stderr: '' });
      }
      // ffmpeg: N шматків у теку з останнього аргументу
      const err = m.ffmpeg(args);
      if (err) return done(err);
      const dir = path.dirname(args[args.length - 1]);
      for (let i = 0; i < m.chunks; i++) fs.writeFileSync(path.join(dir, `chunk${String(i).padStart(3, '0')}.mp3`), `c${i}`);
      done(null, { stdout: '', stderr: '' });
    });
  },
}));
vi.mock('axios', () => ({ default: { post: m.post, get: vi.fn(), request: vi.fn() } }));

const { tmp } = useTempStorage('whisper');

let w: typeof import('../src/youtube/whisper');
let closeDb: () => void;

beforeAll(async () => {
  closeDb = (await initTestDb()).closeDb;
  w = await import('../src/youtube/whisper');
});

afterAll(() => cleanup(tmp, closeDb));

beforeEach(() => {
  m.calls = [];
  m.chunks = 2;
  m.ffmpeg = () => null;
  m.post.mockReset();
  for (const k of ['WHISPER_PROVIDER', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'WHISPER_MAX_MINUTES']) delete process.env[k];
});

const reply = (duration: number, segments: Array<[number, number, string]>, language = 'english') => ({
  data: { language, duration, text: segments.map(s => s[2]).join(' '), segments: segments.map(([start, end, text]) => ({ start, end, text })) },
});

describe('whisperProvider (consent)', () => {
  it('off by default: nothing is sent automatically, even with a key', () => {
    process.env.GROQ_API_KEY = 'gsk';
    expect(w.whisperProvider()).toBeNull();
    expect(w.whisperProvider({ explicit: true })).toBe('groq');   // явний виклик — згода
  });

  it('auto: first configured key, Groq before OpenAI', () => {
    process.env.WHISPER_PROVIDER = 'auto';
    expect(w.whisperProvider()).toBeNull();
    process.env.OPENAI_API_KEY = 'sk';
    expect(w.whisperProvider()).toBe('openai');
    process.env.GROQ_API_KEY = 'gsk';
    expect(w.whisperProvider()).toBe('groq');
  });

  it('a named provider is used only when its key exists — no switching to another', () => {
    process.env.WHISPER_PROVIDER = 'openai';
    process.env.GROQ_API_KEY = 'gsk';
    expect(w.whisperProvider()).toBeNull();
    expect(w.whisperProvider({ explicit: true, preferred: 'groq' })).toBe('groq');
    process.env.OPENAI_API_KEY = 'sk';
    expect(w.whisperProvider()).toBe('openai');
  });

  it('normalizeLanguage maps names to ISO codes', () => {
    expect(w.normalizeLanguage('English')).toBe('en');
    expect(w.normalizeLanguage('uk')).toBe('uk');
    expect(w.normalizeLanguage(undefined)).toBe('auto');
  });
});

describe('transcribeWithWhisper', () => {
  it('audio → 2 chunks → timecodes shifted by each chunk duration', async () => {
    process.env.GROQ_API_KEY = 'gsk';
    m.post
      .mockResolvedValueOnce(reply(600.5, [[0, 4, ' Hello '], [4, 9, 'world']]))
      .mockResolvedValueOnce(reply(120, [[1, 3, 'again'], [3, 3.5, '  ']]));

    const r = await w.transcribeWithWhisper('vid00000001', { provider: 'groq', cookiePath: '/no/cookies.txt' });
    expect(r).toEqual({
      text: 'Hello world again',
      segments: [
        { start: 0, dur: 4, text: 'Hello' },
        { start: 4, dur: 5, text: 'world' },
        { start: 601.5, dur: 2, text: 'again' },
      ],
      language: 'en',
      source: 'whisper:groq',
    });

    const ytdlp = m.calls.find(c => c.bin === 'yt-dlp' && c.args[0] !== '--version')!;
    expect(ytdlp.args).toEqual(expect.arrayContaining(['-f', 'bestaudio/best', '--match-filter', 'duration <=? 10800']));
    expect(ytdlp.args).not.toContain('--cookies'); // файлу немає
    const ffmpeg = m.calls.find(c => c.bin === 'ffmpeg')!;
    expect(ffmpeg.args.join(' ')).toContain('-ac 1 -ar 16000 -c:a libmp3lame -b:a 32k -f segment -segment_time 600');

    const [url, form, opts] = m.post.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBeNull();
    expect(opts.headers.Authorization).toBe('Bearer gsk');

    // тимчасова тека прибрана
    expect(fs.existsSync(path.dirname(ytdlp.args[ytdlp.args.indexOf('--output') + 1]))).toBe(false);
  });

  it('OpenAI with a language hint; plain text reply without segments still counts', async () => {
    process.env.OPENAI_API_KEY = 'sk';
    process.env.WHISPER_MAX_MINUTES = '30';
    m.chunks = 1;
    m.post.mockResolvedValueOnce({ data: { text: 'Привіт усім', duration: 12 } });
    const r = await w.transcribeWithWhisper('vid00000002', { provider: 'openai', lang: 'uk' });
    expect(r).toMatchObject({ text: 'Привіт усім', language: 'uk', source: 'whisper:openai', segments: [{ start: 0, dur: 12, text: 'Привіт усім' }] });
    expect(m.post.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(m.post.mock.calls[0][1].get('model')).toBe('whisper-1');
    expect(m.post.mock.calls[0][1].get('language')).toBe('uk');
    expect(m.calls.find(c => c.bin === 'yt-dlp' && c.args[0] !== '--version')!.args).toContain('duration <=? 1800');
  });

  it('missing ffmpeg, API errors and silence are explained', async () => {
    m.ffmpeg = () => Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    await expect(w.transcribeWithWhisper('v', { provider: 'groq' })).rejects.toThrow(/ffmpeg не знайдено/);

    m.ffmpeg = () => null;
    m.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
      response: { status: 401, data: { error: { message: 'Invalid API Key' } } },
    }));
    await expect(w.transcribeWithWhisper('v', { provider: 'groq' })).rejects.toThrow(/groq Whisper HTTP 401: Invalid API Key/);

    m.post.mockResolvedValue({ data: { text: '', segments: [], duration: 600 } });
    await expect(w.transcribeWithWhisper('v', { provider: 'groq' })).rejects.toThrow(/не розпізнав мовлення/);
  });
});
