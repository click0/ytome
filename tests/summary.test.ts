/**
 * AI-підсумки: шматки з таймкодами, map-reduce, збереження й кеш, черга
 * з повторами, дайджест, .nfo. AI-балансувальник і отримання транскрипту
 * підмінено, БД справжня.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, seedChannel, seedVideo, cleanup } from './helpers/temp-db';

const m = vi.hoisted(() => ({
  ask: vi.fn(),
  fetchTranscriptOfflineFirst: vi.fn(),
  lookupVideoMeta: vi.fn(),
}));

vi.mock('../src/ai/balancer', () => ({ ask: m.ask }));
vi.mock('../src/youtube/api', async (orig) => ({
  ...(await orig<typeof import('../src/youtube/api')>()),
  fetchTranscriptOfflineFirst: m.fetchTranscriptOfflineFirst,
}));
vi.mock('../src/export/transcript', async (orig) => ({
  ...(await orig<typeof import('../src/export/transcript')>()),
  lookupVideoMeta: m.lookupVideoMeta,
}));

const { tmp, storage } = useTempStorage('summary');

let sz: typeof import('../src/summary/summarize');
let sm: typeof import('../src/summary/index');
let TranscriptUnavailableError: typeof import('../src/youtube/transcript-errors').TranscriptUnavailableError;
let init: Awaited<ReturnType<typeof initTestDb>>;

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const seg = (start: number, text: string) => ({ start, dur: 5, text });
/** Транскрипт на N хвилин: сегмент кожні 10 с */
const longTranscript = (minutes: number) => {
  const segments = Array.from({ length: minutes * 6 }, (_, i) => seg(i * 10, `sentence number ${i} about topic ${Math.floor(i / 60)}.`));
  return { text: segments.map(s => s.text).join(' '), segments, language: 'en', source: 'youtube-transcript-plus' };
};
const reply = (data: unknown, provider = 'groq:llama') => ({ text: JSON.stringify(data), provider });
const SUMMARY = {
  tldr: 'Коротко про відео.', key_points: ['Перша теза', 'Друга теза', 42],
  chapters: [{ time: '01:30', title: 'Друге' }, { time: '00:00', title: 'Вступ' }, { time: 'потім', title: 'Без часу' }],
};

beforeAll(async () => {
  init = await initTestDb();
  sz = await import('../src/summary/summarize');
  sm = await import('../src/summary/index');
  ({ TranscriptUnavailableError } = await import('../src/youtube/transcript-errors'));

  const db = init.getDb();
  const auto = seedChannel(db, { youtube_id: 'UCauto', name: 'Auto Chan', handle: '@auto' });
  const manual = seedChannel(db, { youtube_id: 'UCmanual', name: 'Manual Chan' });
  seedVideo(db, auto, { youtube_id: 'autoVideo01', title: 'Long talk', published_at: ago(1), duration_sec: 3600, description: 'About things' });
  seedVideo(db, auto, { youtube_id: 'autoVideo02', title: 'No captions', published_at: ago(2), duration_sec: 600 });
  seedVideo(db, auto, { youtube_id: 'autoVideo03', title: 'Blocked', published_at: ago(3), duration_sec: 600 });
  seedVideo(db, auto, { youtube_id: 'autoShort01', title: 'Short', published_at: ago(1), type: 'short', duration_sec: 40 });
  seedVideo(db, auto, { youtube_id: 'autoClip001', title: 'Clip', published_at: ago(1), duration_sec: 90 });
  seedVideo(db, manual, { youtube_id: 'manualVid01', title: 'Manual', published_at: ago(1), duration_sec: 900 });
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  delete process.env.SUMMARY_LANGUAGE;
  delete process.env.SUMMARY_DAILY_LIMIT;
  delete process.env.SUMMARY_CHUNK_CHARS;
});

describe('chunkTranscript', () => {
  it('groups segments into ~30 s lines with [mm:ss] marks and splits by size', () => {
    const t = longTranscript(10);
    const chunks = sz.chunkTranscript(t, 1000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].text.split('\n')[0]).toMatch(/^\[00:00\] sentence number 0 .* sentence number 2 /);
    expect(chunks[0].text.split('\n')[1]).toMatch(/^\[00:30\] sentence number 3/);
    expect(chunks.every(c => c.text.length <= 1000)).toBe(true);
    expect(chunks[1].start).toBeGreaterThan(0);
    // нічого не загубили
    expect(chunks.map(c => c.text).join('\n')).toContain('sentence number 59 ');
  });

  it('text without segments is cut at sentence boundaries, without timecodes', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Речення номер ${i}.`).join(' ');
    const chunks = sz.chunkTranscript({ text, segments: [] }, 120);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every(c => c.start === null && c.text.endsWith('.'))).toBe(true);
    expect(chunks.map(c => c.text).join(' ')).toBe(text);
  });
});

describe('reply parsing', () => {
  it('parseJsonReply strips fences and surrounding prose', () => {
    expect(sz.parseJsonReply('Sure!\n```json\n{"tldr": "x"}\n```')).toEqual({ tldr: 'x' });
    expect(() => sz.parseJsonReply('no json here')).toThrow(/no JSON/);
  });

  it('parseTimecode accepts mm:ss, h:mm:ss, [mm:ss] and seconds', () => {
    expect(sz.parseTimecode('01:30')).toBe(90);
    expect(sz.parseTimecode('[1:02:03]')).toBe(3723);
    expect(sz.parseTimecode(75.6)).toBe(75);
    expect(sz.parseTimecode('soon')).toBeNull();
    expect(sz.parseTimecode(-1)).toBeNull();
  });
});

describe('summarizeTranscript', () => {
  it('short transcript: one request in the target language with timecoded chapters', async () => {
    m.ask.mockResolvedValueOnce(reply(SUMMARY));
    const s = await sz.summarizeTranscript({
      videoId: 'v', title: 'T', channel: 'C', description: 'D',
      text: 'a b', segments: [seg(0, 'Hello'), seg(95, 'World')],
    });
    expect(m.ask).toHaveBeenCalledTimes(1);
    const req = m.ask.mock.calls[0][0];
    expect(req).toMatchObject({ json: true, complexity: 'medium', tag: 'summary' });
    expect(req.system).toMatch(/Write all text in Ukrainian/);
    expect(req.prompt).toMatch(/Title: T\nChannel: C\nDescription: D/);
    expect(req.prompt).toContain('[00:00] Hello\n[01:35] World');
    expect(s).toEqual({
      tldr: 'Коротко про відео.', key_points: ['Перша теза', 'Друга теза'],
      chapters: [{ start: 0, title: 'Вступ' }, { start: 90, title: 'Друге' }],
      language: 'uk', provider: 'groq:llama',
    });
  });

  it('long transcript: map per chunk, then reduce; chapters from every part', async () => {
    m.ask.mockImplementation(async (req: any) => req.tag === 'summary_chunk'
      ? reply({ summary: 'Part summary.', chapters: [{ time: req.prompt.match(/\[(\d\d:\d\d)\]/)[1], title: 'Part' }] })
      : reply({ tldr: 'Whole video.', key_points: ['k'] }, 'claude:haiku'));
    const t = longTranscript(30);
    const s = await sz.summarizeTranscript({ videoId: 'v', ...t }, { chunkChars: 4000, language: 'en' });

    const chunkCalls = m.ask.mock.calls.filter(([r]) => r.tag === 'summary_chunk');
    expect(chunkCalls.length).toBe(sz.chunkTranscript(t, 4000).length);
    expect(chunkCalls[1][0].prompt).toMatch(/Part 2 of \d+/);
    const reduce = m.ask.mock.calls.at(-1)![0];
    expect(reduce.prompt).toMatch(/1\. Part summary\.\n2\. Part summary\./);
    expect(reduce.system).toMatch(/in English/);
    expect(s.tldr).toBe('Whole video.');
    expect(s.provider).toBe('claude:haiku');
    expect(s.chapters.length).toBe(chunkCalls.length);
    expect(s.chapters.map(c => c.start)).toEqual([...s.chapters.map(c => c.start)].sort((a, b) => a! - b!));
  });

  it('untimed long transcript: chapter per part from its first sentence', async () => {
    m.ask.mockImplementation(async (req: any) => req.tag === 'summary_chunk'
      ? reply({ summary: 'First idea. More details.' })
      : reply({ tldr: 'All.', key_points: [] }));
    const text = Array.from({ length: 50 }, (_, i) => `Sentence ${i}.`).join(' ');
    const s = await sz.summarizeTranscript({ videoId: 'v', text, segments: [] }, { chunkChars: 200 });
    expect(s.chapters.length).toBeGreaterThan(1);
    expect(s.chapters[0]).toEqual({ start: null, title: 'First idea.' });
  });

  it('a reply without tldr is an error; empty transcript is an error', async () => {
    m.ask.mockResolvedValueOnce(reply({ key_points: ['x'] }));
    await expect(sz.summarizeTranscript({ videoId: 'v', text: 'x', segments: [] })).rejects.toThrow(/no tldr/);
    await expect(sz.summarizeTranscript({ videoId: 'v', text: '  ', segments: [] })).rejects.toThrow(/empty/);
  });
});

describe('summarizeVideo', () => {
  it('summarizes an archived video, stores it and the fetched transcript, then serves from the archive', async () => {
    m.fetchTranscriptOfflineFirst.mockResolvedValue({ text: 'Hello world', segments: [seg(0, 'Hello world')], language: 'en', source: 'youtube-transcript-plus' });
    m.ask.mockResolvedValue(reply(SUMMARY));

    const first = await sm.summarizeVideo('manualVid01');
    expect(first).toMatchObject({ cached: false, saved: true });
    expect(first.summary).toMatchObject({ tldr: 'Коротко про відео.', video_id: 'manualVid01', prompt_version: sz.PROMPT_VERSION });
    expect(m.ask.mock.calls[0][0].prompt).toMatch(/Title: Manual\nChannel: Manual Chan/);
    const { getTranscript } = await import('../src/db/queries');
    expect(getTranscript('manualVid01').text).toBe('Hello world');

    const again = await sm.summarizeVideo('manualVid01');
    expect(again.cached).toBe(true);
    expect(m.ask).toHaveBeenCalledTimes(1);

    await sm.summarizeVideo('manualVid01', { force: true });
    await sm.summarizeVideo('manualVid01', { language: 'en' }); // інша мова — перегенерувати
    expect(m.ask).toHaveBeenCalledTimes(3);
    expect(sm.getSummary('manualVid01')!.language).toBe('en');
  });

  it('video outside the archive: summary returned, not saved; metadata from oEmbed', async () => {
    m.fetchTranscriptOfflineFirst.mockResolvedValue({ text: 'x', segments: [], language: 'en', source: 'yt-dlp' });
    m.lookupVideoMeta.mockResolvedValue({ title: 'Outside', channel: 'Someone' });
    m.ask.mockResolvedValue(reply(SUMMARY));
    const r = await sm.summarizeVideo('outside0001');
    expect(r).toMatchObject({ saved: false, cached: false });
    expect(m.ask.mock.calls[0][0].prompt).toMatch(/Title: Outside\nChannel: Someone/);
    expect(sm.getSummary('outside0001')).toBeNull();
  });
});

describe('auto summary queue', () => {
  it('only channels with auto_summary; no shorts or clips below the minimum duration', () => {
    expect(sm.pendingSummaries(100)).toEqual([]);
    expect(sm.setChannelAutoSummary('UCauto', true)).toBe(true);
    expect(sm.setChannelAutoSummary('UCnone', true)).toBe(false);
    expect(sm.pendingSummaries(100).map(v => v.youtube_id)).toEqual(['autoVideo01', 'autoVideo02', 'autoVideo03']);
  });

  it('summarizes, skips permanent failures, retries temporary ones later', async () => {
    m.ask.mockResolvedValue(reply(SUMMARY));
    m.fetchTranscriptOfflineFirst.mockImplementation(async (id: string) => {
      if (id === 'autoVideo02') throw new TranscriptUnavailableError(id, 'no_captions', 'none');
      if (id === 'autoVideo03') throw new TranscriptUnavailableError(id, 'blocked', 'IP blocked');
      return longTranscript(1);
    });

    expect(await sm.processSummaryQueue()).toEqual({ processed: 3, summarized: 1, retry: 1, skipped: 1 });
    expect(sm.getSummary('autoVideo01')!.chapters.length).toBeGreaterThan(0);

    const rows = init.getDb().prepare(`
      SELECT v.youtube_id, s.status, s.reason, s.attempts, s.next_attempt_at > datetime('now') AS later
      FROM summaries s JOIN videos v ON v.id = s.video_id WHERE v.youtube_id IN ('autoVideo02', 'autoVideo03')
      ORDER BY v.youtube_id
    `).all();
    expect(rows).toEqual([
      { youtube_id: 'autoVideo02', status: 'skipped', reason: 'no_captions: none', attempts: 1, later: 1 },
      { youtube_id: 'autoVideo03', status: 'retry', reason: 'blocked: IP blocked', attempts: 1, later: 1 },
    ]);
    // повтор ще не настав — черга порожня
    expect(sm.pendingSummaries(100)).toEqual([]);

    init.getDb().prepare("UPDATE summaries SET next_attempt_at = datetime('now', '-1 minute') WHERE status = 'retry'").run();
    expect(sm.pendingSummaries(100).map(v => v.youtube_id)).toEqual(['autoVideo03']);
  });

  it('gives up after 5 attempts', async () => {
    m.fetchTranscriptOfflineFirst.mockRejectedValue(new TranscriptUnavailableError('autoVideo03', 'blocked', 'IP blocked'));
    for (let i = 0; i < 4; i++) {
      init.getDb().prepare("UPDATE summaries SET next_attempt_at = datetime('now', '-1 minute') WHERE status = 'retry'").run();
      await sm.processSummaryQueue();
    }
    expect(init.getDb().prepare(`
      SELECT status, attempts FROM summaries s JOIN videos v ON v.id = s.video_id WHERE v.youtube_id = 'autoVideo03'
    `).get()).toEqual({ status: 'skipped', attempts: 5 });
  });

  it('stops the run when no AI provider answers; respects the daily limit', async () => {
    const db = init.getDb();
    const ch = (db.prepare("SELECT id FROM channels WHERE youtube_id = 'UCauto'").get() as any).id;
    seedVideo(db, ch, { youtube_id: 'autoVideo04', title: 'Four', published_at: ago(0.5), duration_sec: 600 });
    seedVideo(db, ch, { youtube_id: 'autoVideo05', title: 'Five', published_at: ago(0.6), duration_sec: 600 });
    m.fetchTranscriptOfflineFirst.mockResolvedValue(longTranscript(1));
    m.ask.mockRejectedValue(new Error('No available AI providers [complexity=medium, mode=cost]'));

    const r = await sm.processSummaryQueue();
    expect(r).toMatchObject({ processed: 1, retry: 1, stopped: 'no AI provider available' });

    process.env.SUMMARY_DAILY_LIMIT = '2'; // сьогодні вже є 2 підсумки (manualVid01, autoVideo01)
    expect(await sm.processSummaryQueue()).toEqual({
      processed: 0, summarized: 0, retry: 0, skipped: 0, stopped: 'daily limit reached (2)',
    });
  });
});

describe('digest', () => {
  it('groups new videos by channel with summaries, chapter links and a file', () => {
    const d = sm.buildDigest({ since: ago(5) });
    expect(d.path).toBe(path.resolve(storage, 'exports', 'digests', `digest-${new Date().toISOString().slice(0, 10)}.md`));
    expect(fs.readFileSync(d.path, 'utf-8')).toBe(d.markdown);
    expect(d.channels).toBe(2);
    expect(d.videos).toBe(8);
    expect(d.without_summary).toBe(6);
    expect(d.markdown).toContain('## Auto Chan');
    expect(d.markdown).toContain('### [Long talk](https://youtube.com/watch?v=autoVideo01)');
    expect(d.markdown).toMatch(/- \[00:00\]\(https:\/\/youtube\.com\/watch\?v=autoVideo01&t=0s\) Вступ/);
    expect(d.markdown).toContain('_Підсумку ще немає_');

    const one = sm.buildDigest({ since: ago(5), channelYoutubeId: 'UCmanual' });
    expect(one.videos).toBe(1);
    expect(path.basename(one.path)).toMatch(/-UCmanual\.md$/);
  });
});

describe('formatting and .nfo', () => {
  it('summaryAsText and chapter links', () => {
    expect(sm.summaryAsText({ tldr: 'T', key_points: ['a'], chapters: [{ start: 65, title: 'C' }, { start: null, title: 'D' }] }))
      .toBe('T\n\n• a\n\n[01:05] C\nD');
    expect(sm.chapterLink('vid', null)).toBe('https://youtube.com/watch?v=vid');
    expect(sm.getSummaryText('autoVideo02')).toBeNull();
    expect(sm.getSummaryText('autoVideo01')).toMatch(/^Коротко про відео\./);
  });

  it('episode .nfo puts the summary above the original description', async () => {
    const { buildEpisodeNfo } = await import('../src/export/nfo');
    const nfo = buildEpisodeNfo({ youtube_id: 'UC', name: 'Ch' },
      { youtube_id: 'v', title: 'T', published_at: '2026-10-01T00:00:00Z', description: 'Orig', summary: 'Sum & more' }, 1);
    expect(nfo).toContain('<plot>Sum &amp; more\n\n———\n\nOrig</plot>');
    const plain = buildEpisodeNfo({ youtube_id: 'UC', name: 'Ch' },
      { youtube_id: 'v', title: 'T', published_at: '2026-10-01T00:00:00Z', summary: null }, 1);
    expect(plain).not.toContain('<plot>');
  });
});
