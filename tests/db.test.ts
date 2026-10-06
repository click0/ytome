/**
 * Запити до БД (queries, queries-v2, quota, queries-music) і offline-кеш
 * на справжній SQLite-схемі (init + міграції) у тимчасовому каталозі.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const { tmp, storage } = useTempStorage('db');

let q: typeof import('../src/db/queries');
let v2: typeof import('../src/db/queries-v2');
let quota: typeof import('../src/db/quota');
let music: typeof import('../src/db/queries-music');
let cache: typeof import('../src/cache/resolver');
let closeDb: () => void;
let db: () => import('better-sqlite3').Database;
let chId: number;

const channel = (id: string, name: string) => ({
  youtube_id: id, name, handle: `@${name.toLowerCase()}`, description: 'd',
  thumbnail_url: 'https://img/x.jpg', subscriber_count: 10, video_count: 2,
});
const video = (id: string, published_at: string, extra: Record<string, unknown> = {}) => ({
  youtube_id: id, title: `Title ${id}`, description: 'desc', published_at,
  duration_sec: 300, type: 'video' as const, view_count: 100, like_count: 5,
  thumbnail_url: 'https://img/v.jpg', tags: ['a', 'b'], language: 'uk', ...extra,
});

beforeAll(async () => {
  const init = await initTestDb();
  closeDb = init.closeDb;
  db = init.getDb;
  q = await import('../src/db/queries');
  v2 = await import('../src/db/queries-v2');
  quota = await import('../src/db/quota');
  music = await import('../src/db/queries-music');
  cache = await import('../src/cache/resolver');

  chId = q.addChannel(channel('UCaaa', 'Alpha') as any, 'public', 'note');
  q.addChannel(channel('UCbbb', 'Beta') as any);
  q.upsertVideo(video('vid00000001', '2026-01-10T10:00:00Z') as any, chId);
  q.upsertVideo(video('vid00000002', '2026-02-10T10:00:00Z', { type: 'short', tags: undefined }) as any, chId);
});

afterAll(() => cleanup(tmp, closeDb));

describe('channels', () => {
  it('addChannel is an upsert that keeps the id and updates fields', () => {
    const again = q.addChannel({ ...channel('UCaaa', 'Alpha'), name: 'Alpha 2' } as any, 'public');
    expect(again).toBe(chId);
    expect(q.getChannel('UCaaa').name).toBe('Alpha 2');
    expect(q.getChannel('UCaaa').notes).toBe('note');
  });

  it('getChannels filters by visibility', () => {
    expect(q.getChannels().map(c => c.youtube_id).sort()).toEqual(['UCaaa', 'UCbbb']);
    expect(q.getChannels('public').map(c => c.youtube_id)).toEqual(['UCaaa']);
    expect(q.getChannels('private').map(c => c.youtube_id)).toEqual(['UCbbb']);
  });

  it('updateChannelChecked sets last_checked_at', () => {
    q.updateChannelChecked(chId);
    expect(q.getChannel('UCaaa').last_checked_at).toBeTruthy();
  });
});

describe('videos', () => {
  it('upsertVideo stores tags as JSON and updates counters on conflict', () => {
    const id = q.upsertVideo(video('vid00000001', '2026-01-10T10:00:00Z', { view_count: 999 }) as any, chId);
    const row: any = db().prepare('SELECT * FROM videos WHERE id = ?').get(id);
    expect(row.view_count).toBe(999);
    expect(JSON.parse(row.tags)).toEqual(['a', 'b']);
  });

  it('getNewVideos filters by date and type, newest first', () => {
    expect(q.getNewVideos('2026-01-01T00:00:00Z').map(v => v.youtube_id)).toEqual(['vid00000002', 'vid00000001']);
    expect(q.getNewVideos('2026-01-01T00:00:00Z', 'short').map(v => v.youtube_id)).toEqual(['vid00000002']);
    expect(q.getNewVideos('2026-03-01T00:00:00Z')).toEqual([]);
    expect(q.getNewVideos('2026-01-01T00:00:00Z')[0].channel_visibility).toBe('public');
  });

  it('markAsSeen removes a video from the unseen list', () => {
    expect(q.getUnseenVideos(chId)).toHaveLength(2);
    q.markAsSeen('vid00000002');
    expect(q.getUnseenVideos().map(v => v.youtube_id)).toEqual(['vid00000001']);
  });

  it('getKnownVideoIds returns only archived ids', () => {
    expect(q.getKnownVideoIds([])).toEqual(new Set());
    expect(q.getKnownVideoIds(['vid00000001', 'nope'])).toEqual(new Set(['vid00000001']));
  });

  it('updateThumbnailPath stores the path', () => {
    const { id } = db().prepare("SELECT id FROM videos WHERE youtube_id = 'vid00000001'").get() as any;
    q.updateThumbnailPath(id, '/tmp/t.jpg');
    expect((db().prepare('SELECT thumbnail_path FROM videos WHERE id = ?').get(id) as any).thumbnail_path).toBe('/tmp/t.jpg');
  });
});

describe('transcripts', () => {
  it('saveTranscriptForVideo caches only archived videos', () => {
    expect(q.saveTranscriptForVideo('unknown0000', { text: 't', segments: [], language: 'en' })).toBe(false);
    expect(q.hasTranscript('vid00000001')).toBe(false);
    expect(q.saveTranscriptForVideo('vid00000001', {
      text: 'hello', segments: [{ start: 0, dur: 1, text: 'hello' }], language: 'en',
    })).toBe(true);
    expect(q.hasTranscript('vid00000001')).toBe(true);
    expect(q.getTranscript('vid00000001').text).toBe('hello');
  });

  it('saving again replaces the cached transcript', () => {
    q.saveTranscriptForVideo('vid00000001', { text: 'v2', segments: [], language: 'uk' });
    const t = q.getTranscript('vid00000001');
    expect(t.text).toBe('v2');
    expect(t.language).toBe('uk');
  });

  it('getTranscriptCached prefers the requested language and falls back to any', () => {
    expect(cache.getTranscriptCached('vid00000001', 'uk').data?.text).toBe('v2');
    expect(cache.getTranscriptCached('vid00000001', 'de').data?.text).toBe('v2');
    expect(cache.getTranscriptCached('vid00000002').source).toBe('not_found');
    expect(cache.getTranscriptCached('unknown0000').source).toBe('not_found');
  });
});

describe('groups and check log', () => {
  it('createGroup / addChannelToGroup / getGroups', () => {
    const g = q.createGroup('Tech', 'public');
    q.addChannelToGroup(g, chId);
    q.addChannelToGroup(g, chId); // ідемпотентно
    expect(q.getGroups().map(x => x.name)).toEqual(['Tech']);
    expect((db().prepare('SELECT COUNT(*) AS n FROM channel_group_members').get() as any).n).toBe(1);
  });

  it('logCheck writes a row', () => {
    q.logCheck(chId, 3, 'ok');
    q.logCheck(null, 0, 'error', 'boom');
    const rows = db().prepare('SELECT * FROM check_log ORDER BY id').all();
    expect(rows.map((r: any) => [r.new_videos, r.status, r.error_message])).toEqual([[3, 'ok', null], [0, 'error', 'boom']]);
  });
});

describe('watch later', () => {
  it('add is idempotent for pending items and unknown videos return null', () => {
    expect(v2.addToWatchLater('unknown0000')).toBeNull();
    const a = v2.addToWatchLater('vid00000001', { priority: 'high', note: 'n', tags: ['ai'] })!;
    expect(v2.addToWatchLater('vid00000001')).toEqual({ id: a.id });
  });

  it('lists with filters, parses tags and builds the URL', () => {
    v2.addToWatchLater('vid00000002', { priority: 'low', remindAt: '2000-01-01 00:00:00' });
    const all = v2.getWatchLater();
    expect(all.map(i => i.youtube_id)).toEqual(['vid00000001', 'vid00000002']); // high → low
    expect(all[0].tags).toEqual(['ai']);
    expect(all[0].url).toBe('https://youtube.com/watch?v=vid00000001');
    expect(v2.getWatchLater({ priority: 'low' }).map(i => i.youtube_id)).toEqual(['vid00000002']);
    expect(v2.getWatchLater({ tag: 'ai' }).map(i => i.youtube_id)).toEqual(['vid00000001']);
  });

  it('overdue filter returns items past remind_at', () => {
    expect(v2.getWatchLater({ overdue: true }).map(i => i.youtube_id)).toEqual(['vid00000002']);
  });

  it('status / priority / note updates and stats', () => {
    const [first, second] = v2.getWatchLater();
    v2.updateWatchLaterStatus(second.id, 'done');
    v2.updateWatchLaterPriority(first.id, 'medium');
    v2.updateWatchLaterNote(first.id, 'later');
    expect(v2.getWatchLater({ status: 'done' })[0].done_at).toBeTruthy();
    expect(v2.getWatchLater()[0]).toMatchObject({ priority: 'medium', note: 'later' });
    expect(v2.getWatchLaterStats()).toMatchObject({ total: 2, pending: 1, done: 1, skipped: 0, overdue: 0 });
    v2.updateWatchLaterStatus(second.id, 'pending');
    expect(v2.getWatchLater({ status: 'pending' })).toHaveLength(2);
    expect(v2.getWatchLater({ status: 'all' })).toHaveLength(2);
  });
});

describe('comments', () => {
  const comments = [
    { youtube_comment_id: 'c1', author_name: 'A', text: 'top', like_count: 10, reply_count: 1 },
    { youtube_comment_id: 'c2', author_name: 'Owner', text: 'pinned', like_count: 1, is_channel_owner: true },
    { youtube_comment_id: 'r1', author_name: 'B', text: 'reply', like_count: 2, parent_id: 'c1' },
  ];

  it('saveComments ignores unknown videos', () => {
    v2.saveComments('unknown0000', comments);
    expect(v2.hasComments('unknown0000')).toBe(false);
  });

  it('getCachedComments: owner first, replies attached', () => {
    v2.saveComments('vid00000001', comments);
    v2.saveComments('vid00000001', [{ ...comments[0], like_count: 20 }]); // оновлення лайків
    expect(v2.hasComments('vid00000001')).toBe(true);

    const top = v2.getCachedComments('vid00000001', { withReplies: true });
    expect(top.map(c => c.youtube_comment_id)).toEqual(['c2', 'c1']);
    expect(top[0].is_channel_owner).toBe(true);
    expect(top[1].like_count).toBe(20);
    expect(top[1].replies!.map(r => r.youtube_comment_id)).toEqual(['r1']);
    expect(v2.getCachedComments('vid00000001', { ownerOnly: true }).map(c => c.author_name)).toEqual(['Owner']);
  });

  it('getCommentsCached returns all cached comments with freshness info', () => {
    const r = cache.getCommentsCached('vid00000001');
    expect(r.source).toBe('local_db');
    expect(r.data!.count).toBe(3);
    expect(r.data!.cached_at).toBeTruthy();
    expect(r.stale).toBe(false);
    expect(cache.getCommentsCached('vid00000001', { ownerOnly: true, limit: 5 }).data!.count).toBe(1);
    expect(cache.getCommentsCached('vid00000002').source).toBe('not_found');
    expect(cache.getCommentsCached('unknown0000').source).toBe('not_found');
  });
});

describe('cache resolver', () => {
  it('getVideoMeta: fresh right after sync, not_found for unknown', () => {
    const m = cache.getVideoMeta('vid00000001');
    expect(m.source).toBe('local_db');
    expect(m.data!.title).toBe('Title vid00000001');
    expect(m.stale).toBe(false);
    expect(cache.getVideoMeta('unknown0000').source).toBe('not_found');
  });

  it('thumbnail and media: stored path, standard path, missing', () => {
    expect(cache.getThumbnailCached('vid00000001').source).toBe('not_found'); // /tmp/t.jpg не існує
    const thumbs = path.join(storage, 'thumbnails');
    fs.mkdirSync(thumbs, { recursive: true });
    fs.writeFileSync(path.join(thumbs, 'vid00000002.jpg'), 'x');
    expect(cache.getThumbnailCached('vid00000002')).toEqual({
      data: path.join(thumbs, 'vid00000002.jpg'), source: 'local_file',
    });

    const audioDir = path.join(storage, 'media', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'vid00000001.m4a'), 'x');
    expect(cache.getMediaCached('vid00000001', 'audio').data).toBe(path.join(audioDir, 'vid00000001.m4a'));
    expect(cache.getMediaCached('vid00000001', 'video').source).toBe('not_found');

    const stored = path.join(tmp, 'stored.mp4');
    fs.writeFileSync(stored, 'x');
    db().prepare("UPDATE videos SET video_path = ? WHERE youtube_id = 'vid00000002'").run(stored);
    expect(cache.getMediaCached('vid00000002', 'video')).toEqual({ data: stored, source: 'local_file' });
  });

  it('getVideoCacheStatus / getBatchCacheStatus summarise what is offline', () => {
    const s = cache.getVideoCacheStatus('vid00000001');
    expect(s).toMatchObject({
      in_db: true, has_transcript: true, has_comments: true, comments_count: 3,
      has_audio: true, has_video: false, fully_offline: true, stale_fields: [],
    });
    const batch = cache.getBatchCacheStatus(['vid00000001', 'vid00000002', 'unknown0000']);
    expect(batch.summary).toEqual({ total: 3, fully_offline: 1, need_sync: 2 });
  });
});

describe('quota', () => {
  it('tracks units per operation, with batch multiplier', () => {
    expect(quota.getQuotaStatus()).toMatchObject({ used: 0, remaining: 10_000, percent: 0, warning: false });
    expect(quota.trackQuota('search.list', 'UCaaa')).toBe(100);
    expect(quota.trackQuota('videos.list', undefined, 3)).toBe(3);
    expect(quota.getQuotaStatus()).toMatchObject({ used: 103, remaining: 9_897, percent: 1 });
    expect(quota.getQuotaBreakdown()).toEqual([
      { operation: 'search.list', calls: 1, total_units: 100 },
      { operation: 'videos.list', calls: 1, total_units: 3 },
    ]);
    expect(quota.getQuotaHistory(7)).toEqual([
      { date: new Date().toISOString().slice(0, 10), total_used: 103, percent: 1 },
    ]);
  });

  it('warning / critical thresholds and assertQuota', () => {
    quota.trackQuota('search.list', undefined, 80); // +8000 → 8103
    expect(quota.getQuotaStatus()).toMatchObject({ warning: true, critical: false });
    expect(quota.canAfford('search.list', 18)).toBe(true);
    expect(quota.canAfford('search.list', 19)).toBe(false);
    quota.trackQuota('search.list', undefined, 18); // 9903
    expect(quota.getQuotaStatus()).toMatchObject({ remaining: 97, critical: true });
    expect(() => quota.assertQuota('videos.list')).not.toThrow();
    expect(() => quota.assertQuota('search.list')).toThrow(/quota exceeded.*requires 100 units/);
  });
});

describe('music playlists', () => {
  const tracks = (ids: string[]) => ids.map((id, i) => ({
    video_youtube_id: id, position: i + 1, title: `Song ${id}`, artist: i ? 'Band' : 'Solo',
  }));

  it('add / list / tracks / sync marks vanished tracks unavailable / remove', () => {
    const id = music.addMusicPlaylist({ playlist_id: 'PL1', title: 'Mix' } as any, 'public');
    expect(music.addMusicPlaylist({ playlist_id: 'PL1', title: 'Mix 2' } as any)).toBe(id);
    expect(music.getMusicPlaylists('public').map(p => p.title)).toEqual(['Mix 2']);
    expect(music.getMusicPlaylists('private')).toEqual([]);

    expect(music.saveMusicTracks(id, tracks(['t1', 't2', 't3']) as any)).toEqual({ saved: 3, removed: 0 });
    expect(music.saveMusicTracks(id, tracks(['t1', 't3']) as any)).toEqual({ saved: 2, removed: 1 });
    expect(music.getMusicTracks(id).map(t => t.video_youtube_id)).toEqual(['t1', 't3']);
    expect(music.getMusicTracks(id, { includeUnavailable: true })).toHaveLength(3);
    expect(music.getMusicTracks(id, { artist: 'band' }).map(t => t.video_youtube_id)).toEqual(['t3']);
    expect(music.getMusicPlaylist('PL1').track_count).toBe(2);

    expect(music.removeMusicPlaylist('PL1')).toBe(true);
    expect(music.removeMusicPlaylist('PL1')).toBe(false);
    expect(music.getMusicPlaylists()).toEqual([]);
  });
});
