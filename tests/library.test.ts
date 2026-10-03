/**
 * End-to-end тест експорту медіабібліотеки на тимчасовій БД і справжніх файлах.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ytome-lib-'));
const STORAGE = path.join(TMP, 'storage');
const LIBRARY = path.join(STORAGE, 'library');

// Модулі читають env під час імпорту — задаємо до динамічного import
process.env.STORAGE_PATH = STORAGE;
process.env.DB_PATH = path.join(STORAGE, 'test.db');
process.env.MEDIA_LIBRARY_PATH = LIBRARY;

let lib: typeof import('../src/export/library');
let closeDb: () => void;

const showDir = path.join(LIBRARY, 'Test Channel');
const seasonDir = path.join(showDir, 'Season 2026');

beforeAll(async () => {
  const init = await import('../src/db/init');
  init.initDb();
  closeDb = init.closeDb;
  lib = await import('../src/export/library');

  const mediaDir = path.join(STORAGE, 'media', 'video');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'vid1.mp4'), 'video-1-bytes');
  fs.writeFileSync(path.join(mediaDir, 'vid2.mp4'), 'video-2-bytes');
  const audioDir = path.join(STORAGE, 'media', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(path.join(audioDir, 'aud1.mp3'), 'audio-bytes');

  const db = init.getDb();
  const ch = db.prepare(
    `INSERT INTO channels (youtube_id, name, description) VALUES ('UCtest', 'Test Channel', 'desc') RETURNING id`
  ).get() as { id: number };

  const insert = db.prepare(`
    INSERT INTO videos (youtube_id, channel_id, title, published_at, duration_sec, video_path, audio_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // Два відео в один день → денні індекси 1 і 2
  insert.run('vid1', ch.id, 'First', '2026-03-15T08:00:00Z', 120, path.join(mediaDir, 'vid1.mp4'), null);
  insert.run('vid2', ch.id, 'Second', '2026-03-15T18:00:00Z', 240, path.join(mediaDir, 'vid2.mp4'), null);
  insert.run('aud1', ch.id, 'Podcast', '2026-04-01T10:00:00Z', 3600, null, path.join(audioDir, 'aud1.mp3'));
  insert.run('gone', ch.id, 'Missing file', '2026-05-01T10:00:00Z', 60, path.join(mediaDir, 'nope.mp4'), null);
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('exportLibrary', () => {
  it('exports videos with hardlinks and reports skipped/missing', async () => {
    const r = await lib.exportLibrary();
    expect(r.channels).toBe(1);
    expect(r.exported).toBe(2);
    expect(r.hardlinked).toBe(2);
    expect(r.skipped_audio_only).toBe(1);
    expect(r.missing_source).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('numbers same-day videos by publish time', () => {
    expect(fs.existsSync(path.join(seasonDir, 'Test Channel - S2026E031501 - First.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(seasonDir, 'Test Channel - S2026E031502 - Second.mp4'))).toBe(true);
  });

  it('uses hardlinks — same inode as the original, no extra bytes', () => {
    const linked = fs.statSync(path.join(seasonDir, 'Test Channel - S2026E031501 - First.mp4'));
    const orig = fs.statSync(path.join(STORAGE, 'media', 'video', 'vid1.mp4'));
    expect(linked.ino).toBe(orig.ino);
  });

  it('writes episode and show NFO files', () => {
    const nfo = fs.readFileSync(path.join(seasonDir, 'Test Channel - S2026E031501 - First.nfo'), 'utf-8');
    expect(nfo).toContain('<episode>31501</episode>');
    expect(fs.readFileSync(path.join(showDir, 'tvshow.nfo'), 'utf-8')).toContain('<title>Test Channel</title>');
  });

  it('is idempotent — second run changes nothing', async () => {
    const r = await lib.exportLibrary();
    expect(r.hardlinked).toBe(0);
    expect(r.unchanged).toBe(2);
  });

  it('includes audio when asked', async () => {
    const r = await lib.exportLibrary({ includeAudio: true });
    expect(r.exported).toBe(3);
    expect(fs.existsSync(path.join(seasonDir, 'Test Channel - S2026E040101 - Podcast.mp3'))).toBe(true);
  });

  it('rebuild removes stale files but keeps originals', async () => {
    const stale = path.join(seasonDir, 'stale-leftover.nfo');
    fs.writeFileSync(stale, 'old');
    await lib.exportLibrary({ rebuild: true });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(STORAGE, 'media', 'video', 'vid1.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(seasonDir, 'Test Channel - S2026E031501 - First.mp4'))).toBe(true);
  });
});

describe('assertSafeLibraryRoot', () => {
  it('accepts a dedicated library folder', () => {
    expect(() => lib.assertSafeLibraryRoot(LIBRARY)).not.toThrow();
  });

  it('refuses the storage root (would delete media and DB)', () => {
    expect(() => lib.assertSafeLibraryRoot(STORAGE)).toThrow(/Refusing to rebuild/);
  });

  it('refuses a parent of storage', () => {
    expect(() => lib.assertSafeLibraryRoot(TMP)).toThrow(/Refusing to rebuild/);
  });

  it('refuses a folder inside the media originals', () => {
    expect(() => lib.assertSafeLibraryRoot(path.join(STORAGE, 'media', 'lib'))).toThrow(/Refusing to rebuild/);
  });
});

// =============================================
// Ланцюжок: хардлінк → клон блоків → (copy) → symlink
// Справжній reflink тут не перевірити (немає btrfs/XFS/ZFS),
// тому "інший датасет" і "клон недоступний" імітуємо моками.
// =============================================

const errno = (code: string) => Object.assign(new Error(code), { code });
const realCopy = fs.copyFileSync.bind(fs);

describe('linkFile fallback chain', () => {
  const dir = path.join(TMP, 'linktest');
  const src = path.join(dir, 'src.mp4');
  let n = 0;
  const nextDst = () => path.join(dir, `dst-${++n}.mp4`);

  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(src, 'payload');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LIBRARY_LINK_MODE;
  });

  it('uses a hardlink on the same filesystem', () => {
    expect(lib.linkFile(src, nextDst())).toBe('hardlink');
  });

  it('reports "exists" without touching an existing target', () => {
    const dst = nextDst();
    fs.writeFileSync(dst, 'keep');
    expect(lib.linkFile(src, dst)).toBe('exists');
    expect(fs.readFileSync(dst, 'utf-8')).toBe('keep');
  });

  it('clones blocks when hardlink crosses filesystems (EXDEV)', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw errno('EXDEV'); });
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation((s: any, d: any) => realCopy(s, d));
    const dst = nextDst();

    expect(lib.linkFile(src, dst)).toBe('clone');
    // Клон лише примусовий — тихої повної копії бути не може
    expect(copy).toHaveBeenCalledWith(src, dst, fs.constants.COPYFILE_FICLONE_FORCE);
  });

  it('auto mode: falls back to symlink when cloning is unavailable', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw errno('EXDEV'); });
    vi.spyOn(fs, 'copyFileSync').mockImplementation((_s: any, d: any) => {
      fs.writeFileSync(d, '');            // імітуємо порожній залишок невдалої спроби
      throw errno('ENOTTY');
    });
    const dst = nextDst();

    expect(lib.linkFile(src, dst)).toBe('symlink');
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dst)).toBe(path.resolve(src));
  });

  it('copy mode: falls back to a regular copy, never a symlink', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw errno('EXDEV'); });
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation((s: any, d: any, flags?: any) => {
      if (flags === fs.constants.COPYFILE_FICLONE_FORCE) throw errno('EOPNOTSUPP');
      realCopy(s, d);
    });
    const dst = nextDst();

    expect(lib.linkFile(src, dst, 'copy')).toBe('copy');
    expect(copy).toHaveBeenLastCalledWith(src, dst);   // звичайна копія — без прапорців
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dst, 'utf-8')).toBe('payload');
  });

  it('rethrows hardlink errors that are not "wrong filesystem"', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw errno('EACCES'); });
    expect(() => lib.linkFile(src, nextDst())).toThrow('EACCES');
  });

  it('reads LIBRARY_LINK_MODE, unknown values fall back to auto', () => {
    process.env.LIBRARY_LINK_MODE = 'COPY';
    expect(lib.getLinkMode()).toBe('copy');
    process.env.LIBRARY_LINK_MODE = 'reflink-please';
    expect(lib.getLinkMode()).toBe('auto');
  });

  it('export report counts copies and their bytes in copy mode', async () => {
    process.env.LIBRARY_LINK_MODE = 'copy';
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw errno('EXDEV'); });
    vi.spyOn(fs, 'copyFileSync').mockImplementation((s: any, d: any, flags?: any) => {
      if (flags === fs.constants.COPYFILE_FICLONE_FORCE) throw errno('EXDEV');
      realCopy(s, d);
    });

    const r = await lib.exportLibrary({ rebuild: true });
    expect(r.link_mode).toBe('copy');
    expect(r.copied).toBe(2);
    expect(r.copied_bytes).toBe('video-1-bytes'.length + 'video-2-bytes'.length);
    expect(r.hardlinked + r.symlinked).toBe(0);
  });
});
