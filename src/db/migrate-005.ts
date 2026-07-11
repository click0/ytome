/**
 * Міграція 005: профілі (браузерні сесії / cookies) + YouTube Music
 */
import { getDb } from './init';
import { createLogger } from '../logger';

const log = createLogger('migrate');

export function migrate005(): void {
  const db = getDb();

  db.exec(`
    -- =============================================
    -- ПРОФІЛІ (браузерні сесії / Google-акаунти)
    -- =============================================
    CREATE TABLE IF NOT EXISTS profiles (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL UNIQUE,
      youtube_api_key TEXT,
      cookie_path     TEXT,
      is_default      BOOLEAN NOT NULL DEFAULT 0,
      enabled         BOOLEAN NOT NULL DEFAULT 1,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at    DATETIME,
      notes           TEXT
    );

    -- =============================================
    -- YOUTUBE MUSIC ПЛЕЙЛИСТИ
    -- =============================================
    CREATE TABLE IF NOT EXISTS music_playlists (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id     TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL,
      description     TEXT,
      thumbnail_url   TEXT,
      track_count     INTEGER,
      source_url      TEXT,
      visibility      TEXT    NOT NULL DEFAULT 'private'
                              CHECK(visibility IN ('private','public')),
      added_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_synced_at  DATETIME
    );

    CREATE TABLE IF NOT EXISTS music_tracks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id      INTEGER NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
      video_youtube_id TEXT    NOT NULL,
      position         INTEGER NOT NULL,
      title            TEXT    NOT NULL,
      artist           TEXT,
      album            TEXT,
      duration_sec     INTEGER,
      thumbnail_url    TEXT,
      is_available     BOOLEAN NOT NULL DEFAULT 1,
      added_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, video_youtube_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mt_playlist ON music_tracks(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_mt_artist   ON music_tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_mt_video    ON music_tracks(video_youtube_id);
  `);

  // channels.profile_id — окремо, бо ALTER TABLE падає якщо колонка вже є
  const cols = db.prepare(`PRAGMA table_info(channels)`).all() as any[];
  if (!cols.some(c => c.name === 'profile_id')) {
    db.exec(`ALTER TABLE channels ADD COLUMN profile_id INTEGER REFERENCES profiles(id)`);
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '5')`).run();
  log.info('migration 005 applied: profiles + music_playlists + music_tracks');
}

if (require.main === module) {
  migrate005();
}
