/**
 * Планувальник: перша синхронізація через search.list, далі RSS, відкладені
 * стріми, фільтри, мініатюри, профілі, квота, журнал перевірок.
 * YouTube API та RSS підмінено, БД справжня.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, onTestFinished } from 'vitest';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const net = vi.hoisted(() => ({
  getChannelVideos: vi.fn(),
  getVideosByIds: vi.fn(),
  downloadThumbnail: vi.fn(),
  fetchChannelFeed: vi.fn(),
}));

vi.mock('../src/youtube/api', () => ({
  getChannelVideos: net.getChannelVideos,
  getVideosByIds: net.getVideosByIds,
  downloadThumbnail: net.downloadThumbnail,
}));
vi.mock('../src/youtube/rss', () => ({ fetchChannelFeed: net.fetchChannelFeed }));

const { tmp } = useTempStorage('scheduler');

let s: typeof import('../src/scheduler/index');
let q: typeof import('../src/db/queries');
let quota: typeof import('../src/db/quota');
let init: Awaited<ReturnType<typeof initTestDb>>;

const video = (id: string, extra: Record<string, unknown> = {}) => ({
  youtube_id: id, channel_youtube_id: 'UCs', title: `T ${id}`, description: 'ok',
  published_at: '2026-10-01T00:00:00Z', type: 'video', thumbnail_url: `https://i/${id}.jpg`,
  live_status: 'none', ...extra,
});
const channel = (id: string) => q.getChannel(id);
const lastLog = () => init.getDb().prepare('SELECT * FROM check_log ORDER BY id DESC LIMIT 1').get() as any;

beforeAll(async () => {
  init = await initTestDb();
  s = await import('../src/scheduler/index');
  q = await import('../src/db/queries');
  quota = await import('../src/db/quota');
  q.addChannel({ youtube_id: 'UCs', name: 'Sched' } as any);
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const fn of Object.values(net)) fn.mockReset();
  net.downloadThumbnail.mockImplementation(async (id: string) => `/thumbs/${id}.jpg`);
});

describe('checkChannel', () => {
  it('first sync uses search.list, saves videos with thumbnails, defers live streams, applies filters', async () => {
    const { addFilterRule } = await import('../src/filters/index');
    const rule = addFilterRule({ type: 'blacklist', scope: 'description', value: 'casino' });
    net.getChannelVideos.mockResolvedValueOnce({ videos: [
      video('v1'), video('live1', { live_status: 'live' }), video('spam1', { description: 'Casino promo' }),
      video('nothumb', { thumbnail_url: undefined }),
    ] });

    expect(await s.checkChannel(channel('UCs'))).toBe(2);
    expect(net.getChannelVideos).toHaveBeenCalledWith('UCs', { publishedAfter: undefined, maxResults: 50, apiKey: undefined });
    expect(net.fetchChannelFeed).not.toHaveBeenCalled();
    expect(q.getKnownVideoIds(['v1', 'live1', 'spam1', 'nothumb'])).toEqual(new Set(['v1', 'nothumb']));
    expect(net.downloadThumbnail).toHaveBeenCalledTimes(1);
    expect((init.getDb().prepare("SELECT thumbnail_path FROM videos WHERE youtube_id = 'v1'").get() as any).thumbnail_path)
      .toBe('/thumbs/v1.jpg');
    expect(channel('UCs').last_checked_at).toBeTruthy();
    expect(lastLog()).toMatchObject({ new_videos: 2, status: 'ok' });

    const { removeFilterRule } = await import('../src/filters/index');
    removeFilterRule(rule.id);
  });

  it('later syncs read the RSS feed and fetch details only for unknown ids', async () => {
    net.fetchChannelFeed.mockResolvedValueOnce([
      { video_id: 'v2' }, { video_id: 'v1' }, { video_id: 'live1' },
    ]);
    net.getVideosByIds.mockResolvedValueOnce([video('v2'), video('live1')]);

    expect(await s.checkChannel(channel('UCs'))).toBe(2);
    expect(net.getVideosByIds).toHaveBeenCalledWith(['v2', 'live1'], 'UCs', undefined);
    expect(net.getChannelVideos).not.toHaveBeenCalled();
  });

  it('falls back to search.list with publishedAfter = last check (UTC) when RSS fails', async () => {
    // Зсув часового поясу проявляється лише поза UTC — CI працює в UTC
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    onTestFinished(() => { process.env.TZ = tz; if (tz === undefined) delete process.env.TZ; });
    init.getDb().prepare("UPDATE channels SET last_checked_at = '2026-10-05 10:00:00' WHERE youtube_id = 'UCs'").run();
    net.fetchChannelFeed.mockRejectedValueOnce(new Error('404'));
    net.getChannelVideos.mockResolvedValueOnce({ videos: [] });

    expect(await s.checkChannel(channel('UCs'))).toBe(0);
    expect(net.getChannelVideos.mock.calls[0][1].publishedAfter).toBe('2026-10-05T10:00:00.000Z');
  });

  it('uses the channel profile API key', async () => {
    const { addProfile, assignChannelProfile, getProfile } = await import('../src/profiles/manager');
    const p = addProfile({ name: 'quota2', youtubeApiKey: 'KEY2' });
    assignChannelProfile('UCs', p.id);
    net.fetchChannelFeed.mockResolvedValueOnce([]);
    net.getVideosByIds.mockResolvedValueOnce([]);

    await s.checkChannel(channel('UCs'));
    expect(net.getVideosByIds).toHaveBeenCalledWith([], 'UCs', 'KEY2');
    expect(getProfile(p.id)!.last_used_at).toBeTruthy();
    assignChannelProfile('UCs', null);
  });

  it('logs quota and other errors instead of throwing', async () => {
    net.fetchChannelFeed.mockResolvedValueOnce([{ video_id: 'v9' }]);
    net.getVideosByIds.mockRejectedValueOnce(new Error('YouTube API quota exceeded for today'));
    expect(await s.checkChannel(channel('UCs'))).toBe(0);
    expect(lastLog()).toMatchObject({ status: 'quota_exceeded' });
    expect(net.getChannelVideos).not.toHaveBeenCalled(); // без дорогого фолбеку на search.list

    net.fetchChannelFeed.mockResolvedValueOnce([{ video_id: 'v9' }]);
    net.getVideosByIds.mockRejectedValueOnce(new Error('socket hang up'));
    await s.checkChannel(channel('UCs'));
    expect(lastLog()).toMatchObject({ status: 'error', error_message: 'socket hang up' });
  });
});

describe('checkAllChannels', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    init.getDb().exec('DELETE FROM quota_log; DELETE FROM quota_daily;');
  });
  afterEach(() => vi.useRealTimers());

  async function runAll() {
    const p = s.checkAllChannels();
    await vi.runAllTimersAsync();
    await p;
  }

  it('checks every channel', async () => {
    q.addChannel({ youtube_id: 'UCnew', name: 'Fresh' } as any);
    net.fetchChannelFeed.mockResolvedValue([]);
    net.getVideosByIds.mockResolvedValue([]);
    net.getChannelVideos.mockResolvedValue({ videos: [] });
    await runAll();
    expect(net.fetchChannelFeed).toHaveBeenCalledWith('UCs');   // вже синхронізований → RSS
    expect(net.getChannelVideos.mock.calls.map(c => c[0])).toEqual(['UCnew']); // новий → search
  });

  it('skips the run at critical quota', async () => {
    quota.trackQuota('search.list', undefined, 96);
    await runAll();
    expect(net.fetchChannelFeed).not.toHaveBeenCalled();
    expect(net.getChannelVideos).not.toHaveBeenCalled();
  });

  it('stops when the remaining quota cannot pay for the next channel', async () => {
    quota.trackQuota('search.list', undefined, 94);
    quota.trackQuota('videos.list', undefined, 550); // 9950 — RSS-канал ще можна, search.list (100) — ні
    net.fetchChannelFeed.mockResolvedValue([]);
    net.getVideosByIds.mockResolvedValue([]);
    await runAll();
    expect(net.getChannelVideos).not.toHaveBeenCalled();
  });
});
