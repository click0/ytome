/**
 * Експорт архіву в структуру, яку розуміють Jellyfin / Emby / Plex.
 *
 * storage/library/
 * └── <Channel>/
 *     ├── tvshow.nfo, poster.jpg
 *     └── Season 2026/
 *         ├── <Channel> - S2026E031501 - <Title>.mp4   ← хардлінк на storage/media/...
 *         ├── <Channel> - S2026E031501 - <Title>.nfo
 *         └── <Channel> - S2026E031501 - <Title>-thumb.jpg
 *
 * Медіафайли не копіюються: хардлінк (0 байт додатково), symlink якщо інший диск.
 * Оригінальні шляхи в БД лишаються валідними.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/init';
import { downloadThumbnail } from '../youtube/api';
import { createLogger } from '../logger';
import {
  buildShowNfo, buildEpisodeNfo, episodeBaseName, sanitizeFilename, seasonOf,
  type NfoChannel, type NfoVideo,
} from './nfo';

const log = createLogger('library');

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';

export function getLibraryPath(): string {
  return path.resolve(process.env.MEDIA_LIBRARY_PATH || path.join(STORAGE_PATH, 'library'));
}

export interface LibraryExportResult {
  library_path: string;
  channels: number;
  exported: number;
  link_mode: LinkMode;
  hardlinked: number;
  cloned: number;
  copied: number;
  copied_bytes: number;     // верхня межа витрат місця в copy-режимі (якщо копія не склонувалась)
  symlinked: number;
  unchanged: number;
  missing_source: number;
  skipped_audio_only: number;
  errors: string[];
}

export type LinkMethod = 'hardlink' | 'clone' | 'copy' | 'symlink' | 'exists';

/**
 * Що робити, коли хардлінк неможливий (інша ФС, інший датасет ZFS):
 *   auto — гарантований клон блоків (reflink), інакше symlink.
 *          Додаткове місце не витрачається ніколи.
 *   copy — гарантований клон, інакше звичайна копія через copy_file_range.
 *          На OpenZFS 2.2+ з block cloning це клон навіть між датасетами
 *          одного пулу, але якщо клонування вимкнене — повна копія.
 *          Для Jellyfin у Docker, де symlink на теку поза контейнером битий.
 */
export type LinkMode = 'auto' | 'copy';

export function getLinkMode(): LinkMode {
  const mode = (process.env.LIBRARY_LINK_MODE || 'auto').toLowerCase();
  if (mode === 'auto' || mode === 'copy') return mode;
  log.warn({ mode }, 'unknown LIBRARY_LINK_MODE, using auto');
  return 'auto';
}

/** Коди, за яких хардлінк неможливий у принципі — пробуємо наступний спосіб */
const HARDLINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK']);

/**
 * Клон блоків (FICLONE на Linux, clonefile на macOS).
 * FICLONE_FORCE: або справжній клон, або помилка — тихої повної копії не буде.
 */
function tryClone(src: string, dst: string): boolean {
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch (e: any) {
    // dst до виклику не існував — прибираємо порожній залишок невдалої спроби
    fs.rmSync(dst, { force: true });
    log.debug({ src, code: e.code }, 'block clone unavailable');
    return false;
  }
}

/** Хардлінк → клон блоків → (copy-режим: копія) → symlink */
export function linkFile(src: string, dst: string, mode: LinkMode = 'auto'): LinkMethod {
  if (fs.existsSync(dst)) return 'exists';
  try {
    fs.linkSync(src, dst);
    return 'hardlink';
  } catch (e: any) {
    if (!HARDLINK_FALLBACK_CODES.has(e.code)) throw e;
  }

  if (tryClone(src, dst)) return 'clone';

  if (mode === 'copy') {
    fs.copyFileSync(src, dst);
    return 'copy';
  }

  fs.symlinkSync(path.resolve(src), dst);
  return 'symlink';
}

/**
 * Захист від rebuild, що зніс би оригінали: бібліотека не може
 * містити теку медіа/БД і не може бути всередині неї.
 */
export function assertSafeLibraryRoot(libraryPath: string): void {
  const within = (child: string, parent: string) =>
    child === parent || child.startsWith(parent + path.sep);

  const mediaDir = path.resolve(STORAGE_PATH, 'media');
  const protectedPaths = [
    path.resolve(STORAGE_PATH),
    mediaDir,
    path.dirname(path.resolve(process.env.DB_PATH || './storage/archive.db')),
  ];

  // rm -rf бібліотеки не повинен зачепити жодну захищену теку
  const swallowed = protectedPaths.find(p => within(p, libraryPath));
  // і бібліотека не може жити всередині теки оригіналів
  if (swallowed || within(libraryPath, mediaDir)) {
    throw new Error(
      `Refusing to rebuild: MEDIA_LIBRARY_PATH (${libraryPath}) overlaps ${swallowed || mediaDir}. ` +
      'Point it to a dedicated folder, e.g. storage/library'
    );
  }
}

/** Денні індекси для всіх відео каналу (не лише архівованих) — стабільна нумерація */
function computeDayIndexes(channelDbId: number): Map<string, number> {
  const rows = getDb().prepare(
    'SELECT youtube_id, published_at FROM videos WHERE channel_id = ? ORDER BY published_at, youtube_id'
  ).all(channelDbId) as { youtube_id: string; published_at: string }[];

  const indexes = new Map<string, number>();
  const perDay = new Map<string, number>();
  for (const r of rows) {
    const day = new Date(r.published_at).toISOString().slice(0, 10);
    const idx = (perDay.get(day) || 0) + 1;
    perDay.set(day, idx);
    indexes.set(r.youtube_id, idx);
  }
  return indexes;
}

async function ensureChannelPoster(channel: any, showDir: string, mode: LinkMode): Promise<void> {
  const poster = path.join(showDir, 'poster.jpg');
  if (fs.existsSync(poster)) return;

  let src: string | null = channel.thumbnail_path && fs.existsSync(channel.thumbnail_path)
    ? channel.thumbnail_path
    : null;

  if (!src && channel.thumbnail_url) {
    src = await downloadThumbnail(channel.youtube_id, channel.thumbnail_url);
    if (src) getDb().prepare('UPDATE channels SET thumbnail_path = ? WHERE id = ?').run(src, channel.id);
  }
  if (src) linkFile(src, poster, mode);
}

export async function exportLibrary(opts: {
  channelYoutubeId?: string;
  includeAudio?: boolean;
  rebuild?: boolean;
} = {}): Promise<LibraryExportResult> {
  const libraryPath = getLibraryPath();
  const db = getDb();

  const channels = (opts.channelYoutubeId
    ? db.prepare('SELECT * FROM channels WHERE youtube_id = ?').all(opts.channelYoutubeId)
    : db.prepare('SELECT * FROM channels ORDER BY name').all()) as any[];

  if (opts.rebuild) {
    assertSafeLibraryRoot(libraryPath);
    const targets = opts.channelYoutubeId
      ? channels.map(c => path.join(libraryPath, sanitizeFilename(c.name)))
      : [libraryPath];
    for (const t of targets) fs.rmSync(t, { recursive: true, force: true });
  }

  const mode = getLinkMode();
  const result: LibraryExportResult = {
    library_path: libraryPath,
    link_mode: mode,
    channels: 0, exported: 0, hardlinked: 0, cloned: 0, copied: 0, copied_bytes: 0,
    symlinked: 0, unchanged: 0, missing_source: 0, skipped_audio_only: 0, errors: [],
  };

  const videosStmt = db.prepare(`
    SELECT youtube_id, title, description, published_at, duration_sec, tags,
           video_path, audio_path, thumbnail_path
    FROM videos
    WHERE channel_id = ? AND (video_path IS NOT NULL OR audio_path IS NOT NULL)
    ORDER BY published_at
  `);

  for (const channel of channels) {
    const videos = videosStmt.all(channel.id) as any[];
    if (videos.length === 0) continue;

    const nfoChannel: NfoChannel = channel;
    const showDir = path.join(libraryPath, sanitizeFilename(channel.name));
    const dayIndexes = computeDayIndexes(channel.id);
    let channelExported = 0;

    for (const v of videos) {
      // Jellyfin TV-бібліотеки ігнорують аудіо — тому mp3 лише на запит
      const src: string | null = v.video_path || (opts.includeAudio ? v.audio_path : null);
      if (!src) { result.skipped_audio_only++; continue; }
      if (!fs.existsSync(src)) { result.missing_source++; continue; }

      try {
        const seasonDir = path.join(showDir, `Season ${seasonOf(v.published_at)}`);
        fs.mkdirSync(seasonDir, { recursive: true });

        const video: NfoVideo = v;
        const dayIndex = dayIndexes.get(v.youtube_id) || 1;
        const base = episodeBaseName(channel.name, video, dayIndex);

        const method = linkFile(src, path.join(seasonDir, base + path.extname(src)), mode);
        switch (method) {
          case 'hardlink': result.hardlinked++; break;
          case 'clone':    result.cloned++;     break;
          case 'copy':
            result.copied++;
            result.copied_bytes += fs.statSync(src).size;
            break;
          case 'symlink':  result.symlinked++;  break;
          case 'exists':   result.unchanged++;  break;
        }

        // NFO перезаписуємо завжди — метадані могли оновитись
        fs.writeFileSync(path.join(seasonDir, `${base}.nfo`), buildEpisodeNfo(nfoChannel, video, dayIndex));

        if (v.thumbnail_path && fs.existsSync(v.thumbnail_path)) {
          linkFile(v.thumbnail_path, path.join(seasonDir, `${base}-thumb.jpg`), mode);
        }

        result.exported++;
        channelExported++;
      } catch (e: any) {
        result.errors.push(`${v.youtube_id}: ${e.message}`);
      }
    }

    if (channelExported > 0) {
      fs.writeFileSync(path.join(showDir, 'tvshow.nfo'), buildShowNfo(nfoChannel));
      await ensureChannelPoster(channel, showDir, mode).catch(e =>
        result.errors.push(`${channel.youtube_id} poster: ${e.message}`)
      );
      result.channels++;
    }
  }

  log.info({ ...result, errors: result.errors.length }, 'library export complete');
  return result;
}
