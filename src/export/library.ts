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
import { getSummaryText } from '../summary/index';
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
  removed_folders: number;  // rebuild: видалені теки шоу ytome
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

/** Маркер теки шоу, яку створив ytome: rebuild видаляє лише такі теки */
export const SHOW_MARKER = '.ytome-show';

/** Справжній шлях: symlink-и розкриті навіть для ще не створеної частини шляху */
function realPath(p: string): string {
  const abs = path.resolve(p);
  let existing = abs;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...rest);
  } catch {
    return abs;
  }
}

/**
 * Захист від rebuild, що зніс би оригінали: бібліотека не може
 * містити теку медіа/БД і не може бути всередині неї, не може бути коренем ФС.
 * Шляхи порівнюються після розкриття symlink-ів, без урахування регістру там,
 * де ФС його зазвичай не враховує (Windows, macOS).
 */
export function assertSafeLibraryRoot(libraryPath: string): void {
  const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const norm = (p: string) => fold(realPath(p));
  const within = (child: string, parent: string) => {
    const base = parent.endsWith(path.sep) ? parent : parent + path.sep;   // корінь "/" або "D:\"
    return child === parent || child.startsWith(base);
  };

  const lib = norm(libraryPath);
  if (path.parse(lib).root === lib) {
    throw new Error(`Refusing to rebuild: MEDIA_LIBRARY_PATH (${libraryPath}) is a filesystem root`);
  }

  const mediaDir = norm(path.join(STORAGE_PATH, 'media'));
  const protectedPaths = [
    norm(STORAGE_PATH),
    mediaDir,
    norm(path.dirname(path.resolve(process.env.DB_PATH || './storage/archive.db'))),
  ];
  libraryPath = lib;

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

/** Тека, якій можна довіряти: підкладений symlink замість неї прибирається */
function ensureDir(dir: string): void {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) fs.unlinkSync(dir);
  } catch { /* ще не існує */ }
  fs.mkdirSync(dir, { recursive: true });
}

const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

/**
 * Запис файлу без переходу за symlink: інакше підкладений у бібліотеку
 * "<Шоу> - S… - <Назва>.nfo" → ~/.bashrc перезаписав би чужий файл.
 */
function writeFileNoFollow(file: string, data: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
  } catch { /* ще не існує */ }
  const fd = fs.openSync(file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW, 0o644);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/** Тека шоу ytome: є маркер-файл (не symlink) з ID каналу */
function ownedBy(dir: string): string | null {
  try {
    const marker = path.join(dir, SHOW_MARKER);
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(marker).isFile()) return null;
    return fs.readFileSync(marker, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Ім'я теки шоу. Однакові назви каналів (чи однакові після очищення / без
 * урахування регістру) не зливаються в одну теку — до них додається ID каналу.
 */
function showFolderNames(all: Array<{ youtube_id: string; name: string }>): Map<string, string> {
  const count = new Map<string, number>();
  for (const c of all) {
    const k = sanitizeFilename(c.name).toLowerCase();
    count.set(k, (count.get(k) || 0) + 1);
  }
  return new Map(all.map(c => {
    const base = sanitizeFilename(c.name);
    return [c.youtube_id, (count.get(base.toLowerCase()) || 0) > 1
      ? sanitizeFilename(`${sanitizeFilename(c.name, 90)} [${c.youtube_id}]`) : base];
  }));
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

  const folderNames = showFolderNames(db.prepare('SELECT youtube_id, name FROM channels').all() as any[]);
  const mode = getLinkMode();
  const result: LibraryExportResult = {
    library_path: libraryPath,
    link_mode: mode,
    channels: 0, exported: 0, hardlinked: 0, cloned: 0, copied: 0, copied_bytes: 0,
    symlinked: 0, unchanged: 0, missing_source: 0, skipped_audio_only: 0, removed_folders: 0, errors: [],
  };

  if (opts.rebuild) {
    // Лише теки шоу, які створив ytome (маркер) — чужі шоу в тій самій бібліотеці
    // Jellyfin і будь-які інші файли лишаються недоторканими
    assertSafeLibraryRoot(libraryPath);
    const targets = opts.channelYoutubeId
      ? channels.map(c => ({ dir: path.join(libraryPath, folderNames.get(c.youtube_id)!), id: c.youtube_id as string }))
      : (fs.existsSync(libraryPath) ? fs.readdirSync(libraryPath) : [])
        .map(name => ({ dir: path.join(libraryPath, name), id: null as string | null }));
    for (const t of targets) {
      if (!fs.existsSync(t.dir)) continue;
      const owner = ownedBy(t.dir);
      if (owner && (t.id === null || owner === t.id)) {
        fs.rmSync(t.dir, { recursive: true, force: true });
        result.removed_folders++;
      } else if (t.id !== null) {
        result.errors.push(`${t.dir}: not created by ytome (no ${SHOW_MARKER}) — left untouched`);
      }
    }
  }

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
    const showDir = path.join(libraryPath, folderNames.get(channel.youtube_id) || sanitizeFilename(channel.name));
    const owner = fs.existsSync(showDir) ? ownedBy(showDir) : null;
    if (fs.existsSync(showDir) && owner !== null && owner !== channel.youtube_id) {
      result.errors.push(`${showDir}: belongs to channel ${owner} — skipped`);
      continue;
    }
    const dayIndexes = computeDayIndexes(channel.id);
    let channelExported = 0;

    for (const v of videos) {
      // Jellyfin TV-бібліотеки ігнорують аудіо — тому mp3 лише на запит
      const src: string | null = v.video_path || (opts.includeAudio ? v.audio_path : null);
      if (!src) { result.skipped_audio_only++; continue; }
      if (!fs.existsSync(src)) { result.missing_source++; continue; }

      try {
        ensureDir(showDir);
        writeFileNoFollow(path.join(showDir, SHOW_MARKER), `${channel.youtube_id}\n`);
        const seasonDir = path.join(showDir, `Season ${seasonOf(v.published_at)}`);
        ensureDir(seasonDir);

        const video: NfoVideo = { ...v, summary: getSummaryText(v.youtube_id) };
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
        writeFileNoFollow(path.join(seasonDir, `${base}.nfo`), buildEpisodeNfo(nfoChannel, video, dayIndex));

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
      writeFileNoFollow(path.join(showDir, 'tvshow.nfo'), buildShowNfo(nfoChannel));
      await ensureChannelPoster(channel, showDir, mode).catch(e =>
        result.errors.push(`${channel.youtube_id} poster: ${e.message}`)
      );
      result.channels++;
    }
  }

  log.info({ ...result, errors: result.errors.length }, 'library export complete');
  return result;
}
