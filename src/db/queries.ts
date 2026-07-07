import { getDb } from './init';
import type { ChannelInfo, VideoInfo } from '../youtube/api';

// =============================================
// КАНАЛЫ
// =============================================

export function addChannel(
  info: ChannelInfo,
  visibility: 'private' | 'public' = 'private',
  notes?: string
): number {
  const db = getDb();
  const row = db.prepare(`
    INSERT INTO channels (youtube_id, handle, name, description, thumbnail_url,
                          subscriber_count, video_count, visibility, notes)
    VALUES (@youtube_id, @handle, @name, @description, @thumbnail_url,
            @subscriber_count, @video_count, @visibility, @notes)
    ON CONFLICT(youtube_id) DO UPDATE SET
      name             = excluded.name,
      handle           = excluded.handle,
      description      = excluded.description,
      thumbnail_url    = excluded.thumbnail_url,
      subscriber_count = excluded.subscriber_count,
      video_count      = excluded.video_count
    RETURNING id
  `).get({ ...info, visibility, notes }) as { id: number };
  return row.id;
}

export function getChannels(visibility?: 'private' | 'public') {
  const db = getDb();
  return visibility
    ? db.prepare('SELECT * FROM channels WHERE visibility = ? ORDER BY name').all(visibility) as any[]
    : db.prepare('SELECT * FROM channels ORDER BY visibility, name').all() as any[];
}

export function getChannel(youtubeId: string) {
  return getDb().prepare('SELECT * FROM channels WHERE youtube_id = ?').get(youtubeId) as any;
}

export function updateChannelChecked(channelId: number) {
  getDb().prepare('UPDATE channels SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(channelId);
}

// =============================================
// ВИДЕО
// =============================================

export function upsertVideo(video: VideoInfo, channelDbId: number): number {
  const row = getDb().prepare(`
    INSERT INTO videos (youtube_id, channel_id, title, description, published_at,
                        duration_sec, type, view_count, like_count, thumbnail_url,
                        tags, language)
    VALUES (@youtube_id, @channel_id, @title, @description, @published_at,
            @duration_sec, @type, @view_count, @like_count, @thumbnail_url,
            @tags, @language)
    ON CONFLICT(youtube_id) DO UPDATE SET
      title       = excluded.title,
      view_count  = excluded.view_count,
      like_count  = excluded.like_count,
      updated_at  = CURRENT_TIMESTAMP
    RETURNING id
  `).get({
    ...video,
    channel_id: channelDbId,
    tags: video.tags ? JSON.stringify(video.tags) : null,
  }) as { id: number };
  return row.id;
}

export function getNewVideos(since: string, type?: 'video' | 'short') {
  const db = getDb();
  if (type) {
    return db.prepare(`
      SELECT v.*, c.name as channel_name, c.visibility as channel_visibility
      FROM videos v JOIN channels c ON c.id = v.channel_id
      WHERE v.published_at > ? AND v.type = ?
      ORDER BY v.published_at DESC
    `).all(since, type) as any[];
  }
  return db.prepare(`
    SELECT v.*, c.name as channel_name, c.visibility as channel_visibility
    FROM videos v JOIN channels c ON c.id = v.channel_id
    WHERE v.published_at > ?
    ORDER BY v.published_at DESC
  `).all(since) as any[];
}

export function getUnseenVideos(channelId?: number) {
  const db = getDb();
  if (channelId) {
    return db.prepare(`
      SELECT v.*, c.name as channel_name
      FROM videos v JOIN channels c ON c.id = v.channel_id
      WHERE v.is_seen = 0 AND v.channel_id = ?
      ORDER BY v.published_at DESC LIMIT 100
    `).all(channelId) as any[];
  }
  return db.prepare(`
    SELECT v.*, c.name as channel_name
    FROM videos v JOIN channels c ON c.id = v.channel_id
    WHERE v.is_seen = 0
    ORDER BY v.published_at DESC LIMIT 100
  `).all() as any[];
}

export function markAsSeen(videoYoutubeId: string) {
  getDb().prepare('UPDATE videos SET is_seen = 1 WHERE youtube_id = ?').run(videoYoutubeId);
}

export function updateThumbnailPath(videoId: number, filePath: string) {
  getDb().prepare('UPDATE videos SET thumbnail_path = ? WHERE id = ?').run(filePath, videoId);
}

// =============================================
// ТРАНСКРИПЦИИ
// =============================================

export function saveTranscript(
  videoDbId: number,
  text: string,
  segments: any[],
  language = 'auto',
  source: 'youtube' | 'whisper' | 'manual' = 'youtube'
) {
  getDb().prepare(`
    INSERT INTO transcripts (video_id, language, text, segments, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      text      = excluded.text,
      segments  = excluded.segments,
      language  = excluded.language,
      fetched_at = CURRENT_TIMESTAMP
  `).run(videoDbId, language, text, JSON.stringify(segments), source);
}

export function getTranscript(videoYoutubeId: string) {
  return getDb().prepare(`
    SELECT t.* FROM transcripts t
    JOIN videos v ON v.id = t.video_id
    WHERE v.youtube_id = ?
  `).get(videoYoutubeId) as any;
}

export function hasTranscript(videoYoutubeId: string): boolean {
  return !!getDb().prepare(`
    SELECT 1 FROM transcripts t
    JOIN videos v ON v.id = t.video_id
    WHERE v.youtube_id = ?
  `).get(videoYoutubeId);
}

// =============================================
// ГРУППЫ КАНАЛОВ
// =============================================

export function createGroup(name: string, visibility: 'private' | 'public' = 'private') {
  const row = getDb().prepare(
    'INSERT INTO channel_groups (name, visibility) VALUES (?, ?) RETURNING id'
  ).get(name, visibility) as { id: number };
  return row.id;
}

export function addChannelToGroup(groupId: number, channelId: number) {
  getDb().prepare('INSERT OR IGNORE INTO channel_group_members (group_id, channel_id) VALUES (?, ?)').run(groupId, channelId);
}

export function getGroups() {
  return getDb().prepare('SELECT * FROM channel_groups ORDER BY name').all() as any[];
}

// =============================================
// ЛОГИРОВАНИЕ ПРОВЕРОК
// =============================================

export function logCheck(
  channelId: number | null,
  newVideos: number,
  status: 'ok' | 'error' | 'quota_exceeded',
  errorMessage?: string
) {
  getDb().prepare(`
    INSERT INTO check_log (channel_id, new_videos, status, error_message)
    VALUES (?, ?, ?, ?)
  `).run(channelId, newVideos, status, errorMessage || null);
}
