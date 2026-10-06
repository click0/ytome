/**
 * MCP-обробник handleTool() на тимчасовій БД: валідація, відповіді інструментів
 * і їхні побічні ефекти. Мережеві частини (YouTube API, коментарі, yt-dlp,
 * планувальник, YouTube Music, AI) підмінено.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, seedChannel, seedVideo, cleanup } from './helpers/temp-db';

const m = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  fetchTranscript: vi.fn(),
  fetchTopComments: vi.fn(),
  fetchChannelOwnerComments: vi.fn(),
  checkChannel: vi.fn(),
  checkAllChannels: vi.fn(),
  downloadVideo: vi.fn(),
  fetchPlaylistInfo: vi.fn(),
  fetchPlaylistTracks: vi.fn(),
  checkAllProviders: vi.fn(),
}));

vi.mock('../src/youtube/api', async (orig) => ({
  ...(await orig<typeof import('../src/youtube/api')>()),
  getChannelInfo: m.getChannelInfo,
  fetchTranscript: m.fetchTranscript,
}));
vi.mock('../src/youtube/comments', () => ({
  fetchTopComments: m.fetchTopComments,
  fetchChannelOwnerComments: m.fetchChannelOwnerComments,
}));
vi.mock('../src/scheduler/index', () => ({
  checkChannel: m.checkChannel,
  checkAllChannels: m.checkAllChannels,
}));
vi.mock('../src/youtube/ytdlp', async (orig) => ({
  ...(await orig<typeof import('../src/youtube/ytdlp')>()),
  downloadVideo: m.downloadVideo,
}));
vi.mock('../src/youtube/music', async (orig) => ({
  ...(await orig<typeof import('../src/youtube/music')>()),
  fetchPlaylistInfo: m.fetchPlaylistInfo,
  fetchPlaylistTracks: m.fetchPlaylistTracks,
}));
vi.mock('../src/ai/balancer', () => ({
  ask: async () => ({ text: 'summary' }),
  askJSON: async () => null,
  getMode: () => process.env.BALANCER_MODE || 'priority',
  getRoutingInfo: () => ({ mode: 'priority', proxy: { status: 'off' }, routes: {} }),
  getAIUsageStats: () => [{ provider: 'groq', total_cost_usd: 0.0012344 }, { provider: 'claude', total_cost_usd: 0.002 }],
}));
vi.mock('../src/ai/providers', () => ({ checkAllProviders: m.checkAllProviders }));

const { tmp, storage } = useTempStorage('handlers');
delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

let h: typeof import('../src/mcp/handlers');
let TranscriptUnavailableError: typeof import('../src/youtube/transcript-errors').TranscriptUnavailableError;
let init: Awaited<ReturnType<typeof initTestDb>>;
let chId: number;

const day = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();

/** Виклик інструмента: { error, data } — data розпарсено з JSON */
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await h.handleTool(name, args);
  const text: string = res.content[0].text;
  return res.isError ? { error: text, data: undefined as any } : { error: undefined, data: JSON.parse(text) };
}

beforeAll(async () => {
  init = await initTestDb();
  h = await import('../src/mcp/handlers');
  ({ TranscriptUnavailableError } = await import('../src/youtube/transcript-errors'));

  const db = init.getDb();
  chId = seedChannel(db, { youtube_id: 'UCalpha', name: 'Alpha', handle: '@alpha', visibility: 'public' });
  const priv = seedChannel(db, { youtube_id: 'UCbeta', name: 'Beta' });
  seedVideo(db, chId, { youtube_id: 'vidAlpha001', title: 'Alpha one', published_at: ago(2), description: 'React tutorial' });
  seedVideo(db, chId, { youtube_id: 'vidAlpha002', title: 'Alpha short', published_at: ago(3), type: 'short' });
  seedVideo(db, priv, { youtube_id: 'vidBeta0001', title: 'Beta old', published_at: ago(20) });
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
});

describe('dispatch', () => {
  it('every tool has a unique name', () => {
    const names = h.TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('rejects invalid input before running the tool', async () => {
    const r = await call('proxy_add', { url: 'not a url' });
    expect(r.error).toMatch(/Invalid proxy URL/);
  });

  it('unknown tool → error', async () => {
    expect((await call('no_such_tool')).error).toMatch(/Unknown tool|no_such_tool/);
  });
});

describe('subscriptions and feed', () => {
  it('subscribe stores the channel returned by the API', async () => {
    m.getChannelInfo.mockResolvedValueOnce({ youtube_id: 'UCnew', name: 'New', handle: '@new' });
    const r = await call('subscribe', { channel: '@new', visibility: 'public', notes: 'n' });
    expect(r.data).toMatchObject({ success: true, channel: 'New', visibility: 'public' });
    m.getChannelInfo.mockResolvedValueOnce(null);
    expect((await call('subscribe', { channel: '@ghost' })).error).toMatch(/Channel not found: @ghost/);
  });

  it('list_subscriptions filters by visibility', async () => {
    expect((await call('list_subscriptions', { visibility: 'all' })).data.total).toBe(3);
    const pub = await call('list_subscriptions', { visibility: 'public' });
    expect(pub.data.channels.map((c: any) => c.id).sort()).toEqual(['UCalpha', 'UCnew']);
  });

  it('get_feed: since, type, visibility, unseen_only, has_transcript', async () => {
    const week = await call('get_feed', { since: '1w' });
    expect(week.data.videos.map((v: any) => v.id)).toEqual(['vidAlpha001', 'vidAlpha002']);
    expect(week.data.videos[0]).toMatchObject({ channel: 'Alpha', seen: false, has_transcript: false,
      url: 'https://youtube.com/watch?v=vidAlpha001' });

    expect((await call('get_feed', { since: '1m', type: 'short' })).data.total).toBe(1);
    expect((await call('get_feed', { since: '1m', visibility: 'private' })).data.videos.map((v: any) => v.id))
      .toEqual(['vidBeta0001']);
    expect((await call('get_feed', { since: '1d' })).data.total).toBe(0);
    expect((await call('get_feed')).data.total).toBe(2); // 7 днів за замовчуванням

    await call('mark_seen', { video_id: 'vidAlpha001' });
    expect((await call('get_feed', { since: '1w', unseen_only: true })).data.videos.map((v: any) => v.id))
      .toEqual(['vidAlpha002']);
  });
});

describe('transcripts', () => {
  it('get_transcript fetches, caches, then serves from the local cache', async () => {
    m.fetchTranscript.mockResolvedValueOnce({
      text: 'Hello world', segments: [{ start: 0, dur: 1, text: 'Hello world' }],
      language: 'en', source: 'youtube-transcript-plus',
    });
    const first = await call('get_transcript', { video_id: 'https://youtu.be/vidAlpha001' });
    expect(first.data).toMatchObject({ video_id: 'vidAlpha001', source: 'youtube', text: 'Hello world' });
    expect(m.fetchTranscript).toHaveBeenCalledWith('vidAlpha001', undefined, {});

    const second = await call('get_transcript', { video_id: 'vidAlpha001' });
    expect(second.data).toMatchObject({ source: '📦 local_cache', language: 'en', text: 'Hello world' });
    expect(second.data.segments).toEqual([{ start: 0, dur: 1, text: 'Hello world' }]);
    expect(m.fetchTranscript).toHaveBeenCalledTimes(1);
  });

  it('a transcript failure is reported with its reason; other errors propagate', async () => {
    m.fetchTranscript.mockRejectedValueOnce(new TranscriptUnavailableError('vidAlpha002', 'blocked', 'IP blocked'));
    expect((await call('get_transcript', { video_id: 'vidAlpha002' })).error).toMatch(/\[blocked\] IP blocked/);

    m.fetchTranscript.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.handleTool('get_transcript', { video_id: 'vidAlpha002' })).rejects.toThrow('disk full');
  });

  it('export_transcript writes a .txt with title and channel from the archive', async () => {
    const r = await call('export_transcript', { video_id: 'vidAlpha001', timestamps: true });
    expect(r.data).toMatchObject({ success: true, video_id: 'vidAlpha001', timestamps: true });
    expect(r.data.path).toBe(path.resolve(storage, 'exports', 'transcripts', 'vidAlpha001.timed.txt'));
    expect(fs.readFileSync(r.data.path, 'utf-8'))
      .toBe('Alpha one\nAlpha\nhttps://youtube.com/watch?v=vidAlpha001\n\n[00:00] Hello world\n');
  });

  it('export_transcript keeps the file inside the exports folder', async () => {
    const r = await call('export_transcript', { video_id: 'vidAlpha001', language: '../../evil' });
    expect(path.dirname(r.data.path)).toBe(path.resolve(storage, 'exports', 'transcripts'));
  });

  it('analyze_transcript returns the cached text with an instruction', async () => {
    const r = await call('analyze_transcript', { video_id: 'vidAlpha001', task: 'key_points' });
    expect(r.data).toMatchObject({ task: 'key_points', transcript: 'Hello world', transcript_length: 11 });

    m.fetchTranscript.mockRejectedValueOnce(new TranscriptUnavailableError('vidBeta0001', 'no_captions', 'none'));
    expect((await call('analyze_transcript', { video_id: 'vidBeta0001' })).error).toMatch(/\[no_captions\]/);
  });
});

describe('watch later', () => {
  it('add / list / update / stats', async () => {
    expect((await call('watch_later_add', { video_id: 'nope0000000' })).error).toMatch(/not found in archive/);
    const add = await call('watch_later_add', { video_id: 'vidAlpha002', priority: 'high', tags: ['x'], remind_at: '2000-01-01' });
    expect(add.data.success).toBe(true);

    const list = await call('watch_later_list', {});
    expect(list.data.items).toEqual([expect.objectContaining({ video_id: 'vidAlpha002', priority: 'high', tags: ['x'] })]);
    expect((await call('watch_later_list', { overdue: true })).data.total).toBe(1);

    await call('watch_later_update', { id: add.data.watch_later_id, status: 'done', priority: 'low', note: 'seen' });
    expect((await call('watch_later_list', { status: 'done' })).data.items[0]).toMatchObject({ priority: 'low', note: 'seen' });
    expect((await call('watch_later_stats')).data).toMatchObject({ total: 1, done: 1, pending: 0 });
  });
});

describe('comments', () => {
  it('fetches from YouTube, saves, then serves from cache', async () => {
    m.fetchTopComments.mockResolvedValueOnce([{
      youtube_comment_id: 'c1', author_name: 'A', text: 'Nice', like_count: 3, reply_count: 1,
      replies: [{ youtube_comment_id: 'r1', author_name: 'B', text: 'Yes', like_count: 1, parent_id: 'c1' }],
    }]);
    const net = await call('get_comments', { video_id: 'vidAlpha001' });
    expect(net.data).toMatchObject({ source: 'youtube', total: 1 });
    expect(net.data.comments[0].replies).toEqual([{ author: 'B', owner: undefined, text: 'Yes', likes: 1 }]);

    const cached = await call('get_comments', { video_id: 'vidAlpha001' });
    expect(cached.data).toMatchObject({ source: '📦 local_cache', total: 2, stale: false });
    expect(m.fetchTopComments).toHaveBeenCalledTimes(1);
  });

  it('owner-only and empty results', async () => {
    m.fetchChannelOwnerComments.mockResolvedValueOnce([]);
    const r = await call('get_comments', { video_id: 'vidBeta0001', owner_only: true });
    expect(r.error).toMatch(/No comments available/);
    expect(m.fetchChannelOwnerComments).toHaveBeenCalledWith('vidBeta0001', '');
  });
});

describe('cache_status', () => {
  it('single video with a summary, and batch', async () => {
    const one = await call('cache_status', { video_id: 'vidAlpha001' });
    expect(one.data).toMatchObject({ in_db: true, has_transcript: true, has_comments: true, fully_offline: true });
    expect(one.data.summary).toMatch(/офлайн/);

    const other = await call('cache_status', { video_id: 'vidBeta0001' });
    expect(other.data.summary).toMatch(/transcript, comments/);

    const batch = await call('cache_status', { video_ids: ['vidAlpha001', 'https://youtu.be/vidBeta0001'] });
    expect(batch.data.summary).toEqual({ total: 2, fully_offline: 1, need_sync: 1 });
  });
});

describe('export / import', () => {
  it('export_opml and export_json write files', async () => {
    const opml = await call('export_opml', { visibility: 'all' });
    expect(opml.data.channels_exported).toBe(3);
    expect(fs.readFileSync(opml.data.path, 'utf-8')).toContain('youtubeId="UCalpha"');
    const json = await call('export_json', {});
    expect(JSON.parse(fs.readFileSync(json.data.path, 'utf-8')).total_channels).toBe(3);
  });

  it('import_opml: extension check, missing file, imports via the API', async () => {
    expect((await call('import_opml', { file_path: path.join(tmp, 'x.txt') })).error).toMatch(/Only \.opml/);
    expect((await call('import_opml', { file_path: path.join(tmp, 'none.opml') })).error).toMatch(/File not found/);

    const file = path.join(tmp, 'subs.opml');
    fs.writeFileSync(file, '<opml><body><outline text="Gamma" youtubeId="UCgamma" visibility="public"/>' +
      '<outline text="Broken" youtubeId="UCbroken"/></body></opml>');
    m.getChannelInfo.mockImplementation(async (id: string) => {
      if (id === 'UCbroken') throw new Error('api down');
      return { youtube_id: id, name: 'Gamma' };
    });
    expect((await call('import_opml', { file_path: file })).data).toEqual({ success: true, found: 2, imported: 1 });
  });
});

describe('AI and evaluation', () => {
  it('ai_usage sums cost, ai_set_mode sets the env, ai_status optionally checks health', async () => {
    expect((await call('ai_usage', { days: 3 })).data.total_cost_usd).toBe(0.003234);
    await call('ai_set_mode', { mode: 'cost' });
    expect(process.env.BALANCER_MODE).toBe('cost');
    expect((await call('ai_status')).data).toMatchObject({ mode: 'cost' });
    m.checkAllProviders.mockResolvedValueOnce({ groq: true });
    expect((await call('ai_status', { check_health: true })).data.health).toEqual({ groq: true });
  });

  it('evaluate_video / evaluate_batch use archived metadata', async () => {
    expect((await call('evaluate_video', { video_id: 'nope0000000' })).error).toMatch(/not found in archive/);
    const r = await call('evaluate_video', { video_id: 'vidAlpha001' });
    expect(r.data).toMatchObject({ video_id: 'vidAlpha001', volatility: 'high' });

    expect((await call('evaluate_batch', { video_ids: ['nope0000000'] })).error).toMatch(/No matching videos/);
    const b = await call('evaluate_batch', { video_ids: ['vidAlpha001', 'vidBeta0001', 'nope0000000'] });
    expect(b.data.total).toBe(2);
  });
});

describe('download', () => {
  it('stores audio / video paths for archived videos', async () => {
    m.downloadVideo.mockResolvedValueOnce({ filePath: '/m/a.mp3', format: 'audio', fileSize: 3 * 1024 * 1024 });
    const a = await call('download', { video_id: 'vidAlpha001' });
    expect(a.data).toMatchObject({ file_path: '/m/a.mp3', file_size: '3.0 MB' });
    expect(m.downloadVideo.mock.calls[0][1]).toMatchObject({ format: 'audio', subtitles: false, lang: 'en' });

    m.downloadVideo.mockResolvedValueOnce({ filePath: '/m/v.mp4', format: 'video', fileSize: 1 });
    await call('download', { video_id: 'vidAlpha001', format: 'video' });
    const row: any = init.getDb().prepare("SELECT audio_path, video_path, is_archived FROM videos WHERE youtube_id = 'vidAlpha001'").get();
    expect(row).toEqual({ audio_path: '/m/a.mp3', video_path: '/m/v.mp4', is_archived: 1 });

    m.downloadVideo.mockResolvedValueOnce({ filePath: '/m/x.mp3', format: 'audio', fileSize: 1 });
    expect((await call('download', { video_id: 'notArchived' })).data.success).toBe(true);
  });
});

describe('proxies, filters, quota, groups', () => {
  it('proxy tools', async () => {
    const add = await call('proxy_add', { url: 'http://1.2.3.4:8080', label: 'p' });
    expect(add.data.proxy).toMatchObject({ protocol: 'http', label: 'p' });
    await call('proxy_set_mode', { mode: 'single' });
    const list = await call('proxy_list');
    expect(list.data).toMatchObject({ mode: 'single', total: 1 });
    expect(list.data.proxies[0]).toMatchObject({ host: '1.2.3.4', port: 8080, healthy: true });
    await call('proxy_remove', { id: add.data.proxy.id });
    await call('proxy_set_mode', { mode: 'disabled' });
    expect((await call('proxy_test')).data).toEqual({ total: 0, healthy: 0, results: [] });
  });

  it('filter tools', async () => {
    const w = await call('filter_add', { type: 'whitelist', scope: 'channel', value: 'UCalpha' });
    await call('filter_add', { type: 'blacklist', scope: 'description', value: 'spam' });
    expect((await call('filter_list')).data).toMatchObject({ total: 2, whitelist: 1, blacklist: 1 });
    await call('filter_remove', { id: w.data.rule.id });
    expect((await call('filter_list', { type: 'whitelist' })).data.total).toBe(0);
    expect((await call('filter_clear', {})).data.cleared).toBe('all');
    expect((await call('filter_list')).data.total).toBe(0);
  });

  it('quota_status shows usage, bar and optional breakdown', async () => {
    const { trackQuota } = await import('../src/db/quota');
    trackQuota('search.list', undefined, 85);
    const r = await call('quota_status', { breakdown: true, history_days: 3 });
    expect(r.data.today).toMatchObject({ used: 8500, percent: '85%', status: '🟡 увага' });
    expect(r.data.today.bar).toMatch(/^🟡 \[█{17}░{3}\] 85%$/);
    expect(r.data.breakdown_today).toEqual([{ operation: 'search.list', calls: 1, total_units: 8500 }]);
    expect(r.data.costs_reference['search.list']).toBe(100);
    expect((await call('quota_status')).data.breakdown_today).toBeUndefined();
  });

  it('create_group / list_groups', async () => {
    const g = await call('create_group', { name: 'News', visibility: 'public' });
    expect(g.data).toMatchObject({ success: true, name: 'News' });
    expect((await call('list_groups')).data.groups.map((x: any) => x.name)).toContain('News');
  });

  it('sync: one channel by id or handle, unknown channel, all channels', async () => {
    m.checkChannel.mockResolvedValue(4);
    expect((await call('sync', { channel: '@alpha' })).data).toEqual({ success: true, channel: 'Alpha', new_videos: 4 });
    expect((await call('sync', { channel: 'UCbeta' })).data.channel).toBe('Beta');
    expect((await call('sync', { channel: '@nobody' })).error).toMatch(/Channel not found/);
    expect((await call('sync')).data.message).toMatch(/All channels/);
    expect(m.checkAllChannels).toHaveBeenCalledOnce();
  });
});

describe('profiles', () => {
  it('add / list / default / assign / remove; cookies reach the transcript fetcher', async () => {
    const cookies = path.join(tmp, 'cookies.txt');
    const future = Math.floor(Date.now() / 1000) + 86400;
    fs.writeFileSync(cookies, `.youtube.com\tTRUE\t/\tTRUE\t${future}\tSID\tsecret\n`);

    const p = await call('profile_add', { name: 'home', cookie_path: cookies, youtube_api_key: 'K' });
    expect(p.data.profile).toMatchObject({ name: 'home' });
    const list = await call('profile_list');
    expect(list.data.profiles[0]).toMatchObject({ name: 'home', has_api_key: true, has_cookies: true, is_default: false });
    expect(JSON.stringify(list.data)).not.toContain('"K"'); // ключ не показуємо

    await call('profile_set_default', { id: p.data.profile.id });
    expect((await call('profile_list')).data.profiles[0].is_default).toBe(true);

    expect((await call('profile_assign_channel', { channel: '@nobody', profile_id: 1 })).error).toMatch(/Channel not found/);
    expect((await call('profile_assign_channel', { channel: '@alpha', profile_id: p.data.profile.id })).data.channel).toBe('Alpha');

    m.fetchTranscript.mockResolvedValueOnce({ text: 't', segments: [], language: 'en', source: 'x' });
    await call('get_transcript', { video_id: 'vidAlpha002', force_refresh: true });
    expect(m.fetchTranscript.mock.calls[0][2]).toEqual({ cookieHeader: 'SID=secret', cookiePath: cookies });

    await call('profile_remove', { id: p.data.profile.id });
    expect((await call('profile_list')).data.total).toBe(0);
  });
});

describe('Google services without credentials', () => {
  it.each([
    ['drive_backup', {}], ['drive_export_transcript', { video_id: 'vidAlpha001' }], ['drive_list', {}],
    ['export_subscriptions_sheets', {}], ['export_watch_later_sheets', {}], ['export_stats_sheets', {}],
  ])('%s explains how to configure the service account', async (tool, args) => {
    expect((await call(tool, args)).error).toMatch(/Google Service Account not configured/);
  });

  it('sheets_list works offline', async () => {
    expect((await call('sheets_list')).data).toEqual({ exports: [] });
  });
});

describe('YouTube Music', () => {
  it('add / list / tracks / sync / remove', async () => {
    m.fetchPlaylistInfo.mockResolvedValueOnce(null);
    expect((await call('music_playlist_add', { playlist: 'PLnone' })).error).toMatch(/not found or not public/);

    m.fetchPlaylistInfo.mockResolvedValueOnce({ playlist_id: 'PLmix', title: 'Mix' });
    m.fetchPlaylistTracks.mockResolvedValueOnce([
      { video_youtube_id: 't1', position: 1, title: 'One', artist: 'Band' },
      { video_youtube_id: 't2', position: 2, title: 'Two', artist: 'Solo' },
    ]);
    const add = await call('music_playlist_add', { playlist: 'https://music.youtube.com/playlist?list=PLmix' });
    expect(add.data).toEqual({ success: true, playlist: 'Mix', playlist_id: 'PLmix', tracks_archived: 2 });

    expect((await call('music_playlist_list', { visibility: 'all' })).data.playlists[0])
      .toMatchObject({ playlist_id: 'PLmix', url: 'https://music.youtube.com/playlist?list=PLmix' });
    expect((await call('music_playlist_tracks', { playlist: 'PLmix', artist: 'band' })).data.tracks.map((t: any) => t.title))
      .toEqual(['One']);
    expect((await call('music_playlist_tracks', { playlist: 'PLother' })).error).toMatch(/not archived/);

    m.fetchPlaylistTracks.mockResolvedValueOnce([{ video_youtube_id: 't2', position: 1, title: 'Two' }]);
    expect((await call('music_playlist_sync', { playlist: 'PLmix' })).data)
      .toMatchObject({ tracks_synced: 1, tracks_removed: 1 });
    expect((await call('music_playlist_sync', { playlist: 'PLother' })).error).toMatch(/not archived/);

    expect((await call('music_playlist_remove', { playlist: 'PLmix' })).data.success).toBe(true);
    expect((await call('music_playlist_remove', { playlist: 'PLmix' })).error).toMatch(/not found/);
  });
});

describe('media library', () => {
  it('unknown channel → error; rebuild requires confirm', async () => {
    expect((await call('library_export', { channel: '@nobody' })).error).toMatch(/Channel not found/);
    expect((await call('library_rebuild', {})).error).toMatch(/confirm/);
  });
});
