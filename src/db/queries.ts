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
  try {
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
  } finally {
    db.close();
  }
}

export function getChannels(visibility?: 'private' | 'public') {
  const db = getDb();
  try {
    const rows = visibility
      ? db.prepare('SELECT * FROM channels WHERE visibility = ? ORDER BY name').all(visibility)
      : db.prepare('SELECT * FROM channels ORDER BY visibility, name').all();
    return rows as any[];
  } finally {
    db.close();
  }
}

export function getChannel(youtubeId: string) {
  const db = getDb();
  try {
    return db.prepare('SELECT * FROM channels WHERE youtube_id = ?').get(youtubeId) as any;
  } finally {
    db.close();
  }
}

export function updateChannelChecked(channelId: number) {
  const db = getDb();
  try {
    db.prepare('UPDATE channels SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(channelId);
  } finally {
    db.close();
  }
}

// =============================================
// ВИДЕО
// =============================================

export function upsertVideo(video: VideoInfo, channelDbId: number): number {
  const db = getDb();
  try {
    const row = db.prepare(`
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
  } finally {
    db.close();
  }
}

export function getNewVideos(since: string, type?: 'video' | 'short') {
  const db = getDb();
  try {
    if (type) {
      const rows = db.prepare(`
        SELECT v.*, c.name as channel_name, c.visibility as channel_visibility
        FROM videos v
        JOIN channels c ON c.id = v.channel_id
        WHERE v.published_at > ? AND v.type = ?
        ORDER BY v.published_at DESC
      `).all(since, type);
      return rows as any[];
    }
    const rows = db.prepare(`
      SELECT v.*, c.name as channel_name, c.visibility as channel_visibility
      FROM videos v
      JOIN channels c ON c.id = v.channel_id
      WHERE v.published_at > ?
      ORDER BY v.published_at DESC
    `).all(since);
    return rows as any[];
  } finally {
    db.close();
  }
}

export function getUnseenVideos(channelId?: number) {
  const db = getDb();
  try {
    if (channelId) {
      const rows = db.prepare(`
        SELECT v.*, c.name as channel_name
        FROM videos v
        JOIN channels c ON c.id = v.channel_id
        WHERE v.is_seen = 0 AND v.channel_id = ?
        ORDER BY v.published_at DESC
        LIMIT 100
      `).all(channelId);
      return rows as any[];
    }
    const rows = db.prepare(`
      SELECT v.*, c.name as channel_name
      FROM videos v
      JOIN channels c ON c.id = v.channel_id
      WHERE v.is_seen = 0
      ORDER BY v.published_at DESC
      LIMIT 100
    `).all();
    return rows as any[];
  } finally {
    db.close();
  }
}

export function markAsSeen(videoYoutubeId: string) {
  const db = getDb();
  try {
    db.prepare('UPDATE videos SET is_seen = 1 WHERE youtube_id = ?').run(videoYoutubeId);
  } finally {
    db.close();
  }
}

export function updateThumbnailPath(videoId: number, filePath: string) {
  const db = getDb();
  try {
    db.prepare('UPDATE videos SET thumbnail_path = ? WHERE id = ?').run(filePath, videoId);
  } finally {
    db.close();
  }
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
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO transcripts (video_id, language, text, segments, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        text      = excluded.text,
        segments  = excluded.segments,
        language  = excluded.language,
        fetched_at = CURRENT_TIMESTAMP
    `).run(videoDbId, language, text, JSON.stringify(segments), source);
  } finally {
    db.close();
  }
}

export function getTranscript(videoYoutubeId: string) {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT t.* FROM transcripts t
      JOIN videos v ON v.id = t.video_id
      WHERE v.youtube_id = ?
    `).get(videoYoutubeId) as any;
  } finally {
    db.close();
  }
}

export function hasTranscript(videoYoutubeId: string): boolean {
  const db = getDb();
  try {
    return !!db.prepare(`
      SELECT 1 FROM transcripts t
      JOIN videos v ON v.id = t.video_id
      WHERE v.youtube_id = ?
    `).get(videoYoutubeId);
  } finally {
    db.close();
  }
}

// =============================================
// ГРУППЫ КАНАЛОВ
// =============================================

export function createGroup(name: string, visibility: 'private' | 'public' = 'private') {
  const db = getDb();
  try {
    const row = db.prepare(
      'INSERT INTO channel_groups (name, visibility) VALUES (?, ?) RETURNING id'
    ).get(name, visibility) as { id: number };
    return row.id;
  } finally {
    db.close();
  }
}

export function addChannelToGroup(groupId: number, channelId: number) {
  const db = getDb();
  try {
    db.prepare('INSERT OR IGNORE INTO channel_group_members (group_id, channel_id) VALUES (?, ?)').run(groupId, channelId);
  } finally {
    db.close();
  }
}

export function getGroups() {
  const db = getDb();
  try {
    return db.prepare('SELECT * FROM channel_groups ORDER BY name').all() as any[];
  } finally {
    db.close();
  }
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
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO check_log (channel_id, new_videos, status, error_message)
      VALUES (?, ?, ?, ?)
    `).run(channelId, newVideos, status, errorMessage || null);
  } finally {
    db.close();
  }
}
