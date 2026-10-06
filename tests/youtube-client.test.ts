/**
 * Клієнт YouTube Data API (канали, відео, квота), коментарі, YouTube Music,
 * RSS і мініатюри — googleapis та axios підмінено, БД справжня (квота, проксі).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const yt = vi.hoisted(() => {
  const client = {
    channels: { list: vi.fn() },
    search: { list: vi.fn() },
    videos: { list: vi.fn() },
    commentThreads: { list: vi.fn() },
    playlists: { list: vi.fn() },
    playlistItems: { list: vi.fn() },
  };
  return { client, youtube: vi.fn(() => client), axiosGet: vi.fn() };
});

vi.mock('googleapis', () => ({ google: { youtube: yt.youtube } }));
vi.mock('axios', () => ({ default: { get: yt.axiosGet, request: vi.fn() } }));

const { tmp, storage } = useTempStorage('ytclient');

let api: typeof import('../src/youtube/api');
let comments: typeof import('../src/youtube/comments');
let music: typeof import('../src/youtube/music');
let rss: typeof import('../src/youtube/rss');
let quota: typeof import('../src/db/quota');
let px: typeof import('../src/proxy/manager');
let init: Awaited<ReturnType<typeof initTestDb>>;

beforeAll(async () => {
  init = await initTestDb();
  api = await import('../src/youtube/api');
  comments = await import('../src/youtube/comments');
  music = await import('../src/youtube/music');
  rss = await import('../src/youtube/rss');
  quota = await import('../src/db/quota');
  px = await import('../src/proxy/manager');
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const group of Object.values(yt.client)) group.list.mockReset();
  yt.youtube.mockClear();
  yt.axiosGet.mockReset();
  init.getDb().exec('DELETE FROM quota_log; DELETE FROM quota_daily;');
});

const used = () => quota.getQuotaBreakdown().reduce((acc, r) => ({ ...acc, [r.operation]: r.total_units }), {});

const apiVideo = (id: string, extra: Record<string, any> = {}) => ({
  id,
  snippet: {
    title: `T ${id}`, description: 'd', publishedAt: '2026-10-01T00:00:00Z',
    thumbnails: { high: { url: `https://i/${id}.jpg` } }, tags: ['x'], defaultAudioLanguage: 'uk',
    liveBroadcastContent: 'none', ...extra.snippet,
  },
  contentDetails: { duration: 'PT1H2M3S', ...extra.contentDetails },
  statistics: { viewCount: '10', likeCount: '2', ...extra.statistics },
});

describe('getYoutube', () => {
  it('reuses the shared client; a profile key or proxy gets its own client', async () => {
    const base = yt.youtube.mock.calls.length;
    await api.getYoutube();
    expect(yt.youtube.mock.calls.length).toBe(base);

    await api.getYoutube('PROFILE_KEY');
    expect(yt.youtube.mock.calls.at(-1)![0]).toMatchObject({ version: 'v3', auth: 'PROFILE_KEY' });

    const p = px.addProxy({ url: 'http://10.0.0.1:3128' });
    px.setProxyMode('single');
    await api.getYoutube();
    expect((yt.youtube.mock.calls.at(-1)![0] as any).fetchOptions.agent).toBeDefined();
    px.setProxyMode('disabled');
    px.removeProxy(p.id);
  });
});

describe('getChannelInfo', () => {
  it('maps the API channel; @handle, UC id and bare handle use the right parameter', async () => {
    yt.client.channels.list.mockResolvedValue({ data: { items: [{
      id: 'UCxyz', snippet: { title: 'Chan', customUrl: '@chan', description: 'about',
        thumbnails: { default: { url: 'https://i/c.jpg' } } },
      statistics: { subscriberCount: '1500', videoCount: '42' },
    }] } });
    expect(await api.getChannelInfo('@chan')).toEqual({
      youtube_id: 'UCxyz', handle: '@chan', name: 'Chan', description: 'about',
      thumbnail_url: 'https://i/c.jpg', subscriber_count: 1500, video_count: 42,
    });
    await api.getChannelInfo('UCxyz');
    await api.getChannelInfo('chan');
    const params = yt.client.channels.list.mock.calls.map(([p]) => [p.forHandle, p.id]);
    expect(params).toEqual([['chan', undefined], [undefined, ['UCxyz']], ['chan', undefined]]);
  });

  it('not found or API error → null', async () => {
    yt.client.channels.list.mockResolvedValueOnce({ data: { items: [] } });
    expect(await api.getChannelInfo('@none')).toBeNull();
    yt.client.channels.list.mockRejectedValueOnce(new Error('403 forbidden'));
    expect(await api.getChannelInfo('@err')).toBeNull();
  });
});

describe('getChannelVideos / getVideosByIds', () => {
  it('search.list → videos.list, maps details and tracks quota', async () => {
    yt.client.search.list.mockResolvedValue({ data: {
      items: [{ id: { videoId: 'v1' } }, { id: {} }, { id: { videoId: 'v2' } }], nextPageToken: 'NEXT',
    } });
    yt.client.videos.list.mockResolvedValue({ data: { items: [
      apiVideo('v2', { contentDetails: { duration: 'PT45S' }, snippet: { liveBroadcastContent: 'upcoming' } }),
      apiVideo('v1'),
    ] } });

    const r = await api.getChannelVideos('UCxyz', { publishedAfter: '2026-01-01T00:00:00Z', maxResults: 500 });
    expect(r.nextPageToken).toBe('NEXT');
    expect(yt.client.search.list.mock.calls[0][0]).toMatchObject({
      channelId: 'UCxyz', maxResults: 50, order: 'date', publishedAfter: '2026-01-01T00:00:00Z',
    });
    // порядок як у пошуку, не як у videos.list
    expect(r.videos.map(v => v.youtube_id)).toEqual(['v1', 'v2']);
    expect(r.videos[0]).toEqual({
      youtube_id: 'v1', channel_youtube_id: 'UCxyz', title: 'T v1', description: 'd',
      published_at: '2026-10-01T00:00:00Z', duration_sec: 3723, type: 'video', view_count: 10, like_count: 2,
      thumbnail_url: 'https://i/v1.jpg', tags: ['x'], language: 'uk', live_status: 'none',
    });
    expect(r.videos[1]).toMatchObject({ duration_sec: 45, type: 'short', live_status: 'upcoming' });
    expect(used()).toEqual({ 'search.list': 100, 'videos.list': 1 });
  });

  it('batches by 50 ids, drops videos the API did not return', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    yt.client.videos.list.mockImplementation(async ({ id }: { id: string[] }) => ({
      data: { items: id.filter(x => x !== 'id7').map(x => apiVideo(x, { contentDetails: { duration: undefined } })) },
    }));
    const vids = await api.getVideosByIds(ids, 'UCxyz');
    expect(yt.client.videos.list.mock.calls.map(([p]) => p.id.length)).toEqual([50, 50, 20]);
    expect(vids).toHaveLength(119);
    expect(vids[0]).toMatchObject({ duration_sec: undefined, type: 'video' });
    expect(used()).toEqual({ 'videos.list': 3 });
    expect(await api.getVideosByIds([], 'UCxyz')).toEqual([]);
  });

  it('refuses search.list when the daily quota cannot cover it', async () => {
    quota.trackQuota('search.list', undefined, 100);
    await expect(api.getChannelVideos('UCxyz')).rejects.toThrow(/quota exceeded/);
    expect(yt.client.search.list).not.toHaveBeenCalled();
  });
});

describe('downloadThumbnail', () => {
  it('streams the image to storage/thumbnails once', async () => {
    yt.axiosGet.mockResolvedValueOnce({ data: Readable.from([Buffer.from('jpeg-bytes')]) });
    const p = await api.downloadThumbnail('vid00000001', 'https://i/x.jpg');
    expect(p).toBe(path.join(storage, 'thumbnails', 'vid00000001.jpg'));
    expect(fs.readFileSync(p!, 'utf-8')).toBe('jpeg-bytes');
    expect(await api.downloadThumbnail('vid00000001', 'https://i/x.jpg')).toBe(p); // вже є
    expect(yt.axiosGet).toHaveBeenCalledTimes(1);
  });

  it('network error → null', async () => {
    yt.axiosGet.mockRejectedValueOnce(new Error('timeout'));
    expect(await api.downloadThumbnail('vid00000002', 'https://i/y.jpg')).toBeNull();
  });
});

describe('comments', () => {
  const thread = (id: string, author: string, extra: any = {}) => ({
    snippet: {
      channelId: 'UCowner', totalReplyCount: extra.replies?.length ?? 0,
      topLevelComment: { id, snippet: {
        authorDisplayName: author, authorChannelId: { value: extra.authorId }, textDisplay: `text ${id}`,
        likeCount: extra.likes ?? 0, publishedAt: '2026-10-01T00:00:00Z',
      } },
    },
    replies: extra.replies ? { comments: extra.replies } : undefined,
  });
  const reply = (id: string, authorId?: string) => ({
    id, snippet: { authorDisplayName: 'R', authorChannelId: authorId ? { value: authorId } : undefined, textDisplay: 'r', likeCount: 1 },
  });

  it('maps threads and replies; the video owner is recognised by channel id', async () => {
    yt.client.commentThreads.list.mockResolvedValue({ data: { items: [
      thread('c1', 'Viewer', { authorId: 'UCviewer', likes: 5, replies: [reply('r1', 'UCowner'), reply('r2')] }),
      thread('c2', 'Owner', { authorId: 'UCowner' }),
      thread('c3', 'Anonymous'),
      { snippet: {} },
    ] } });

    const all = await comments.fetchTopComments('vid00000001', 500);
    expect(yt.client.commentThreads.list.mock.calls[0][0]).toMatchObject({ videoId: 'vid00000001', maxResults: 100 });
    expect(all.map(c => [c.youtube_comment_id, c.is_channel_owner])).toEqual([['c1', false], ['c2', true], ['c3', false]]);
    expect(all[0]).toMatchObject({ author_channel_id: 'UCviewer', like_count: 5, reply_count: 2 });
    expect(all[0].replies!.map(r => [r.youtube_comment_id, r.is_channel_owner, r.parent_id]))
      .toEqual([['r1', true, 'c1'], ['r2', false, 'c1']]);
    expect(used()).toEqual({ 'commentThreads.list': 1 });

    const noReplies = await comments.fetchTopComments('vid00000001', 20, false);
    expect(noReplies[0].replies).toEqual([]);

    const owner = await comments.fetchChannelOwnerComments('vid00000001', 'UCowner');
    expect(owner.map(c => c.youtube_comment_id)).toEqual(['c1', 'c2']); // c1 — є відповідь автора
  });
});

describe('YouTube Music', () => {
  it('extractPlaylistId from music / youtube URLs', () => {
    expect(music.extractPlaylistId('https://music.youtube.com/playlist?list=PLabc_1-2')).toBe('PLabc_1-2');
    expect(music.extractPlaylistId('https://www.youtube.com/watch?v=x&list=OLAK5uy')).toBe('OLAK5uy');
    expect(music.extractPlaylistId('PLplain')).toBe('PLplain');
  });

  it('fetchPlaylistInfo maps metadata; missing playlist → null', async () => {
    yt.client.playlists.list.mockResolvedValueOnce({ data: { items: [{
      snippet: { title: 'Mix', description: 'd', thumbnails: { high: { url: 'https://i/p.jpg' } } },
      contentDetails: { itemCount: 3 },
    }] } });
    expect(await music.fetchPlaylistInfo('PL1')).toEqual({
      playlist_id: 'PL1', title: 'Mix', description: 'd', thumbnail_url: 'https://i/p.jpg', track_count: 3,
    });
    yt.client.playlists.list.mockResolvedValueOnce({ data: { items: [] } });
    expect(await music.fetchPlaylistInfo('PL2')).toBeNull();
  });

  it('fetchPlaylistTracks pages through items, skips deleted/private, adds durations', async () => {
    const item = (vid: string | undefined, title: string, position: number, owner?: string) => ({
      contentDetails: { videoId: vid }, snippet: { title, position, videoOwnerChannelTitle: owner },
    });
    yt.client.playlistItems.list
      .mockResolvedValueOnce({ data: { items: [
        item('t1', 'Song', 0, 'Artist - Topic'), item('t2', 'Deleted video', 1), item(undefined, 'x', 2),
      ], nextPageToken: 'P2' } })
      .mockResolvedValueOnce({ data: { items: [item('t3', 'Other', 3, 'Band'), item('t4', 'Private video', 4)] } });
    yt.client.videos.list.mockResolvedValueOnce({ data: { items: [
      { id: 't1', contentDetails: { duration: 'PT3M30S' } }, { id: 't3', contentDetails: {} },
    ] } });

    const tracks = await music.fetchPlaylistTracks('PL1');
    expect(yt.client.playlistItems.list.mock.calls.map(([p]) => p.pageToken)).toEqual([undefined, 'P2']);
    expect(tracks).toEqual([
      { video_youtube_id: 't1', position: 0, title: 'Song', artist: 'Artist', thumbnail_url: undefined, duration_sec: 210 },
      { video_youtube_id: 't3', position: 3, title: 'Other', artist: 'Band', thumbnail_url: undefined },
    ]);
    expect(used()).toEqual({ 'videos.list': 3 });
  });
});

describe('RSS feed', () => {
  it('fetchChannelFeed requests the channel feed and parses entries', async () => {
    yt.axiosGet.mockResolvedValueOnce({ data: `<feed><entry><yt:videoId>v1</yt:videoId>
      <yt:channelId>UCxyz</yt:channelId><title>A &amp; B</title><published>2026-10-01T00:00:00+00:00</published></entry></feed>` });
    expect(await rss.fetchChannelFeed('UCxyz')).toEqual([
      { video_id: 'v1', channel_id: 'UCxyz', title: 'A & B', published_at: '2026-10-01T00:00:00+00:00' },
    ]);
    expect(yt.axiosGet.mock.calls[0][0]).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=UCxyz');
  });
});
