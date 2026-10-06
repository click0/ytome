/**
 * Експорт транскрипту в .txt для відео поза архівом (метадані з oEmbed)
 * і фолбек на субтитри yt-dlp — мережа підмінена, БД тимчасова.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const net = vi.hoisted(() => ({ request: vi.fn(), get: vi.fn(), subtitles: vi.fn() }));

vi.mock('axios', () => ({ default: { request: net.request, get: net.get } }));
vi.mock('../src/youtube/ytdlp', () => ({
  downloadSubtitles: net.subtitles,
  srtToText: (s: string) => s.replace(/\n/g, ' ').trim(),
}));

const { tmp, storage } = useTempStorage('trexport');

let ex: typeof import('../src/export/transcript');
let api: typeof import('../src/youtube/api');
let init: Awaited<ReturnType<typeof initTestDb>>;

/** YouTube, що не віддає субтитри (бот-перевірка) */
function blockedYoutube() {
  net.request.mockImplementation(async (cfg: any) => {
    if (cfg.url.includes('/watch?v=')) return { status: 200, data: '<script>ytcfg.set({"INNERTUBE_API_KEY":"K"})</script>' };
    return { status: 200, data: JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } }) };
  });
}

beforeAll(async () => {
  init = await initTestDb();
  ex = await import('../src/export/transcript');
  api = await import('../src/youtube/api');
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  net.request.mockReset();
  net.get.mockReset();
  net.subtitles.mockReset();
});

describe('lookupVideoMeta', () => {
  it('uses oEmbed for videos outside the archive', async () => {
    net.get.mockResolvedValueOnce({ data: { title: 'Budget 2027', author_name: 'Simple Numbers' } });
    expect(await ex.lookupVideoMeta('CQz4aAruYxE')).toEqual({ title: 'Budget 2027', channel: 'Simple Numbers' });
    expect(net.get.mock.calls[0][1].params).toEqual({ url: 'https://www.youtube.com/watch?v=CQz4aAruYxE', format: 'json' });
  });

  it('oEmbed failure → no header metadata', async () => {
    net.get.mockRejectedValueOnce(new Error('401'));
    expect(await ex.lookupVideoMeta('privateVid1')).toEqual({});
  });
});

describe('fetchTranscript yt-dlp fallback', () => {
  it('when YouTube blocks the player, subtitles from yt-dlp are used', async () => {
    blockedYoutube();
    net.subtitles.mockResolvedValueOnce('Привіт\nсвіт');
    const r = await api.fetchTranscript('dQw4w9WgXcQ', 'uk', { cookiePath: '/c.txt' });
    expect(r).toEqual({ text: 'Привіт світ', segments: [], language: 'uk', source: 'yt-dlp' });
    expect(net.subtitles).toHaveBeenCalledWith('dQw4w9WgXcQ', 'uk', '/c.txt');
  });

  it('yt-dlp crash still reports the original reason', async () => {
    blockedYoutube();
    net.subtitles.mockRejectedValueOnce(new Error('yt-dlp exploded'));
    await expect(api.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({ reason: 'blocked' });
  });
});

describe('exportTranscriptToFile', () => {
  it('video outside the archive: fetched, not cached, header from oEmbed, language in the name', async () => {
    blockedYoutube();
    net.subtitles.mockResolvedValueOnce('Текст');
    net.get.mockResolvedValueOnce({ data: { title: 'Title', author_name: 'Chan' } });

    const r = await ex.exportTranscriptToFile('dQw4w9WgXcQ', { language: 'ru', timestamps: true });
    expect(r).toEqual({
      path: path.resolve(storage, 'exports', 'transcripts', 'dQw4w9WgXcQ.ru.txt'),
      source: 'yt-dlp', language: 'ru', chars: expect.any(Number), timestamps: false, // сегментів немає
    });
    expect(fs.readFileSync(r.path, 'utf-8')).toBe('Title\nChan\nhttps://youtube.com/watch?v=dQw4w9WgXcQ\n\nТекст\n');
    expect(init.getDb().prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({ n: 0 });
  });
});
