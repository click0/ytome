/**
 * Транскрипти: причини недоступності, формат .txt і контракт fetch-хуків
 * youtube-transcript-plus (хук мусить повертати Response-подібний об'єкт).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyTranscriptFailure, TranscriptUnavailableError,
} from '../src/youtube/transcript-errors';
import { formatTimestamp, formatTranscript } from '../src/export/transcript';

// --- мережа, проксі та yt-dlp для тестів fetchTranscript ---------------
const axiosRequest = vi.fn();
vi.mock('axios', () => ({ default: { request: (...a: any[]) => axiosRequest(...a), get: vi.fn() } }));
vi.mock('../src/proxy/manager', () => ({
  getNextProxy: () => null,
  buildAgent: async () => undefined,
  axiosProxyConfig: async () => ({}),
  googleApiProxyConfig: async () => ({}),
}));
vi.mock('../src/youtube/ytdlp', () => ({
  downloadSubtitles: async () => null,
  srtToText: (s: string) => s,
}));

const libErr = (name: string, message = name) => Object.assign(new Error(message), { name });

describe('classifyTranscriptFailure', () => {
  it('bot check → blocked, with a hint about cookies/proxy', () => {
    const e = classifyTranscriptFailure('vid', libErr('YoutubeTranscriptNotAvailableError'), {
      playability: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" },
    });
    expect(e).toBeInstanceOf(TranscriptUnavailableError);
    expect(e.reason).toBe('blocked');
    expect(e.message).toMatch(/profile_add/);
    expect(e.message).toMatch(/proxy_add/);
  });

  it('HTTP 403 / 429 / recaptcha → blocked', () => {
    expect(classifyTranscriptFailure('v', libErr('X'), { videoPageStatus: 403 }).reason).toBe('blocked');
    expect(classifyTranscriptFailure('v', libErr('X'), { transcriptStatus: 429 }).reason).toBe('blocked');
    expect(classifyTranscriptFailure('v', libErr('X'), { recaptcha: true }).reason).toBe('blocked');
    expect(classifyTranscriptFailure('v', libErr('YoutubeTranscriptTooManyRequestError'), {}).reason).toBe('blocked');
  });

  it('login required for other reasons (age, private) → login_required', () => {
    const e = classifyTranscriptFailure('v', libErr('X'), {
      playability: { status: 'LOGIN_REQUIRED', reason: 'This video may be inappropriate for some users.' },
    });
    expect(e.reason).toBe('login_required');
  });

  it('unplayable / error → unavailable, keeps YouTube reason', () => {
    const e = classifyTranscriptFailure('v', libErr('X'), {
      playability: { status: 'ERROR', reason: 'This video has been removed by the uploader' },
    });
    expect(e.reason).toBe('unavailable');
    expect(e.message).toMatch(/removed by the uploader/);
  });

  it('playable without captions → no_captions', () => {
    expect(classifyTranscriptFailure('v', libErr('YoutubeTranscriptDisabledError'), {}).reason).toBe('no_captions');
    expect(classifyTranscriptFailure('v', libErr('YoutubeTranscriptNotAvailableError'), {
      playability: { status: 'OK' },
    }).reason).toBe('no_captions');
  });

  it('missing language → language, keeps the list of available ones', () => {
    const e = classifyTranscriptFailure('v',
      libErr('YoutubeTranscriptNotAvailableLanguageError', 'No transcripts in uk. Available: ru, en'), {});
    expect(e.reason).toBe('language');
    expect(e.message).toMatch(/ru, en/);
  });

  it('anything else → error with the original message', () => {
    const e = classifyTranscriptFailure('v', new Error('socket hang up'), {});
    expect(e.reason).toBe('error');
    expect(e.message).toMatch(/socket hang up/);
  });
});

describe('formatTimestamp', () => {
  it('formats mm:ss and h:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(75.9)).toBe('01:15');
    expect(formatTimestamp(3725)).toBe('1:02:05');
  });
});

describe('formatTranscript', () => {
  const t = { text: 'Hello world. Bye.', segments: [{ start: 0, dur: 1, text: 'Hello world.' }, { start: 65, dur: 1, text: 'Bye.' }] };

  it('writes title, channel and link before the text', () => {
    expect(formatTranscript('abc', t, { title: 'Title', channel: 'Chan' }))
      .toBe('Title\nChan\nhttps://youtube.com/watch?v=abc\n\nHello world. Bye.\n');
  });

  it('falls back to the video id when there is no title', () => {
    expect(formatTranscript('abc', t, {})).toBe('abc\nhttps://youtube.com/watch?v=abc\n\nHello world. Bye.\n');
  });

  it('writes one timestamped line per segment', () => {
    expect(formatTranscript('abc', t, { title: 'T' }, { timestamps: true }))
      .toBe('T\nhttps://youtube.com/watch?v=abc\n\n[00:00] Hello world.\n[01:05] Bye.\n');
  });

  it('timestamps without segments fall back to plain text', () => {
    expect(formatTranscript('abc', { text: 'Plain', segments: [] }, {}, { timestamps: true }))
      .toMatch(/\n\nPlain\n$/);
  });
});

// --- fetchTranscript через справжню youtube-transcript-plus ------------
const WATCH_PAGE = '<html><script>ytcfg.set({"INNERTUBE_API_KEY":"KEY123"})</script></html>';
const reply = (status: number, data: unknown) =>
  ({ status, data: typeof data === 'string' ? data : JSON.stringify(data) });

/** Імітація YouTube: сторінка відео → плеєр InnerTube → XML субтитрів */
function youtube(player: unknown, transcriptXml = '') {
  axiosRequest.mockImplementation(async (cfg: any) => {
    if (cfg.url.includes('/watch?v=')) return reply(200, WATCH_PAGE);
    if (cfg.url.includes('/youtubei/v1/player')) return reply(200, player);
    if (cfg.url.includes('/api/timedtext')) return reply(200, transcriptXml);
    return reply(404, '');
  });
}

describe('fetchTranscript (hook contract)', () => {
  beforeEach(() => { axiosRequest.mockReset(); });

  it('returns segments — hooks give the library a Response-like object', async () => {
    youtube(
      { playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: 'ru', baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=ru' }],
      } } },
      '<transcript><text start="0.5" dur="2">Привет &amp; пока</text><text start="3" dur="1">Конец</text></transcript>',
    );
    const { fetchTranscript } = await import('../src/youtube/api');
    const r = await fetchTranscript('dQw4w9WgXcQ');
    expect(r.source).toBe('youtube-transcript-plus');
    expect(r.language).toBe('ru');
    expect(r.segments).toEqual([
      { start: 0.5, dur: 2, text: 'Привет & пока' },
      { start: 3, dur: 1, text: 'Конец' },
    ]);
  });

  it('sends the profile Cookie header on every request', async () => {
    youtube({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: {
      captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ' }],
    } } }, '<text start="0" dur="1">Hi</text>');
    const { fetchTranscript } = await import('../src/youtube/api');
    await fetchTranscript('dQw4w9WgXcQ', undefined, { cookieHeader: 'SID=abc' });
    expect(axiosRequest).toHaveBeenCalledTimes(3);
    for (const [cfg] of axiosRequest.mock.calls) expect(cfg.headers.Cookie).toBe('SID=abc');
  });

  it('bot check → TranscriptUnavailableError(blocked), not "no captions"', async () => {
    youtube({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } });
    const { fetchTranscript } = await import('../src/youtube/api');
    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      name: 'TranscriptUnavailableError', reason: 'blocked',
    });
  });

  it('playable video without captions → no_captions', async () => {
    youtube({ playabilityStatus: { status: 'OK' } });
    const { fetchTranscript } = await import('../src/youtube/api');
    await expect(fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({ reason: 'no_captions' });
  });
});
