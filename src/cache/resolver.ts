/**
 * Offline-first резолвер
 *
 * Перед кожним мережевим викликом перевіряє локальний кеш.
 * Принцип: якщо є локально — повертаємо одразу, в мережу не лізем.
 *
 * Ієрархія для кожного типу даних:
 *
 *   metadata    → videos таблиця → YouTube API
 *   transcript  → transcripts таблиця → youtube-transcript → yt-dlp subtitles
 *   comments    → comments таблиця → YouTube API
 *   thumbnail   → файл на диску → завантаження з YouTube
 *   audio/video → файл на диску → yt-dlp download
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../db/init';

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';

// =============================================
// Типи
// =============================================

export type CacheSource = 'local_db' | 'local_file' | 'network' | 'not_found';

export interface CacheResult<T> {
  data:    T | null;
  source:  CacheSource;
  stale?:  boolean;       // є локально, але може бути застарілим
}

// =============================================
// Метадані відео
// =============================================

export interface VideoMeta {
  youtube_id:    string;
  title:         string;
  description?:  string;
  published_at:  string;
  duration_sec?: number;
  view_count?:   number;
  like_count?:   number;
  comment_count?: number;
  type:          'video' | 'short';
  channel_id:    number;
  is_archived:   boolean;
  thumbnail_path?: string;
  audio_path?:   string;
  video_path?:   string;
  cached_at?:    string;
}

export function getVideoMeta(youtubeId: string): CacheResult<VideoMeta> {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM videos WHERE youtube_id = ?').get(youtubeId) as any;
  db.close();

  if (!row) return { data: null, source: 'not_found' };

  // Перевіряємо чи метадані свіжі (< 24 год)
  const cachedAt  = row.cached_at ? new Date(row.cached_at).getTime() : 0;
  const ageHours  = (Date.now() - cachedAt) / 3_600_000;
  const stale     = ageHours > 24;

  return {
    data:   row as VideoMeta,
    source: 'local_db',
    stale,
  };
}

// =============================================
// Транскрипція
// =============================================

export interface TranscriptData {
  video_id:  number;
  language:  string;
  text:      string;
  segments:  any[];
  source:    string;
  cached_at: string;
}

export function getTranscriptCached(youtubeId: string, lang?: string): CacheResult<TranscriptData> {
  const db = getDb();

  // Спочатку шукаємо відео
  const video = db.prepare('SELECT id FROM videos WHERE youtube_id = ?').get(youtubeId) as any;
  if (!video) { db.close(); return { data: null, source: 'not_found' }; }

  // Шукаємо транскрипцію — спочатку ручну, потім auto, потім будь-яку мовою
  let row: any = null;

  if (lang) {
    row = db.prepare(
      "SELECT * FROM transcripts WHERE video_id = ? AND language = ? ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'whisper' THEN 1 ELSE 2 END LIMIT 1"
    ).get(video.id, lang);
  }

  if (!row) {
    row = db.prepare(
      "SELECT * FROM transcripts WHERE video_id = ? ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'whisper' THEN 1 ELSE 2 END LIMIT 1"
    ).get(video.id);
  }

  db.close();

  if (!row) return { data: null, source: 'not_found' };
  return { data: row as TranscriptData, source: 'local_db' };
}

// =============================================
// Коментарі
// =============================================

export interface CommentsCache {
  count:      number;
  cached_at?: string;   // дата останнього завантаження
  comments:   any[];
}

export function getCommentsCached(
  youtubeId: string,
  opts: { limit?: number; ownerOnly?: boolean } = {}
): CacheResult<CommentsCache> {
  const db = getDb();

  const video = db.prepare('SELECT id FROM videos WHERE youtube_id = ?').get(youtubeId) as any;
  if (!video) { db.close(); return { data: null, source: 'not_found' }; }

  let sql    = 'SELECT * FROM comments WHERE video_id = ?';
  const args: any[] = [video.id];

  if (opts.ownerOnly) { sql += ' AND is_channel_owner = 1'; }
  sql += ' ORDER BY like_count DESC';
  if (opts.limit)     { sql += ' LIMIT ?'; args.push(opts.limit); }

  const comments = db.prepare(sql).all(...args) as any[];

  // Дата останнього оновлення коментарів
  const lastFetch = db.prepare(
    "SELECT MAX(created_at) as last FROM comments WHERE video_id = ?"
  ).get(video.id) as any;

  db.close();

  if (comments.length === 0) return { data: null, source: 'not_found' };

  // Коментарі вважаємо застарілими після 7 днів
  const lastFetchMs = lastFetch?.last ? new Date(lastFetch.last).getTime() : 0;
  const staleDays   = (Date.now() - lastFetchMs) / 86_400_000;

  return {
    data:   { count: comments.length, cached_at: lastFetch?.last, comments },
    source: 'local_db',
    stale:  staleDays > 7,
  };
}

// =============================================
// Thumbnail
// =============================================

export function getThumbnailCached(youtubeId: string): CacheResult<string> {
  // Перевіряємо шлях з БД
  const db    = getDb();
  const video = db.prepare(
    'SELECT thumbnail_path FROM videos WHERE youtube_id = ?'
  ).get(youtubeId) as any;
  db.close();

  if (video?.thumbnail_path && fs.existsSync(video.thumbnail_path)) {
    return { data: video.thumbnail_path, source: 'local_file' };
  }

  // Fallback: стандартний шлях
  const stdPath = path.join(STORAGE_PATH, 'thumbnails', `${youtubeId}.jpg`);
  if (fs.existsSync(stdPath)) {
    return { data: stdPath, source: 'local_file' };
  }

  return { data: null, source: 'not_found' };
}

// =============================================
// Аудіо / відео файли
// =============================================

export type MediaType = 'audio' | 'video';

export function getMediaCached(youtubeId: string, type: MediaType): CacheResult<string> {
  const db    = getDb();
  const col   = type === 'audio' ? 'audio_path' : 'video_path';
  const video = db.prepare(`SELECT ${col} FROM videos WHERE youtube_id = ?`).get(youtubeId) as any;
  db.close();

  const storedPath = video?.[col];
  if (storedPath && fs.existsSync(storedPath)) {
    return { data: storedPath, source: 'local_file' };
  }

  // Fallback: шукаємо в стандартних папках
  const exts  = type === 'audio' ? ['mp3', 'm4a', 'opus'] : ['mp4', 'mkv', 'webm'];
  const dir   = path.join(STORAGE_PATH, 'media', type);

  for (const ext of exts) {
    const p = path.join(dir, `${youtubeId}.${ext}`);
    if (fs.existsSync(p)) return { data: p, source: 'local_file' };
  }

  return { data: null, source: 'not_found' };
}

// =============================================
// Зведений статус кешу для відео
// =============================================

export interface VideoCacheStatus {
  youtube_id:   string;
  in_db:        boolean;
  has_transcript: boolean;
  transcript_source?: string;
  has_comments: boolean;
  comments_count: number;
  has_thumbnail: boolean;
  has_audio:    boolean;
  has_video:    boolean;
  fully_offline: boolean;   // все є локально
  stale_fields:  string[];  // що потребує оновлення
}

export function getVideoCacheStatus(youtubeId: string): VideoCacheStatus {
  const meta       = getVideoMeta(youtubeId);
  const transcript = getTranscriptCached(youtubeId);
  const comments   = getCommentsCached(youtubeId);
  const thumbnail  = getThumbnailCached(youtubeId);
  const audio      = getMediaCached(youtubeId, 'audio');
  const video      = getMediaCached(youtubeId, 'video');

  const staleFields: string[] = [];
  if (meta.stale)       staleFields.push('metadata');
  if (comments.stale)   staleFields.push('comments');

  const hasTranscript = transcript.source !== 'not_found';
  const hasComments   = comments.source   !== 'not_found';
  const hasThumbnail  = thumbnail.source  !== 'not_found';
  const hasAudio      = audio.source      !== 'not_found';
  const hasVideo      = video.source      !== 'not_found';

  return {
    youtube_id:          youtubeId,
    in_db:               meta.source !== 'not_found',
    has_transcript:      hasTranscript,
    transcript_source:   transcript.data?.source,
    has_comments:        hasComments,
    comments_count:      comments.data?.count ?? 0,
    has_thumbnail:       hasThumbnail,
    has_audio:           hasAudio,
    has_video:           hasVideo,
    fully_offline:       meta.source !== 'not_found' && hasTranscript,
    stale_fields:        staleFields,
  };
}

// =============================================
// Batch статус для списку відео
// =============================================

export function getBatchCacheStatus(youtubeIds: string[]): {
  summary: { total: number; fully_offline: number; need_sync: number };
  videos:  VideoCacheStatus[];
} {
  const videos      = youtubeIds.map(getVideoCacheStatus);
  const fullyOffline = videos.filter(v => v.fully_offline).length;
  const needSync     = videos.filter(v => v.stale_fields.length > 0 || !v.fully_offline).length;

  return {
    summary: { total: videos.length, fully_offline: fullyOffline, need_sync: needSync },
    videos,
  };
}
