import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './storage/archive.db';

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function initDb(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_id      TEXT    NOT NULL UNIQUE,
      handle          TEXT,
      name            TEXT    NOT NULL,
      description     TEXT,
      thumbnail_url   TEXT,
      thumbnail_path  TEXT,
      visibility      TEXT    NOT NULL DEFAULT 'private'
                              CHECK(visibility IN ('private', 'public')),
      subscriber_count INTEGER,
      video_count     INTEGER,
      added_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at DATETIME,
      last_video_at   DATETIME,
      notes           TEXT,
      tags            TEXT
    );

    CREATE TABLE IF NOT EXISTS videos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_id      TEXT    NOT NULL UNIQUE,
      channel_id      INTEGER NOT NULL REFERENCES channels(id),
      title           TEXT    NOT NULL,
      description     TEXT,
      published_at    DATETIME NOT NULL,
      duration_sec    INTEGER,
      type            TEXT    NOT NULL DEFAULT 'video'
                              CHECK(type IN ('video', 'short')),
      view_count      INTEGER,
      like_count      INTEGER,
      comment_count   INTEGER,
      is_available    BOOLEAN NOT NULL DEFAULT 1,
      is_seen         BOOLEAN NOT NULL DEFAULT 0,
      is_archived     BOOLEAN NOT NULL DEFAULT 0,
      thumbnail_url   TEXT,
      thumbnail_path  TEXT,
      audio_path      TEXT,
      video_path      TEXT,
      tags            TEXT,
      category_id     TEXT,
      language        TEXT,
      fetched_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id    INTEGER NOT NULL UNIQUE REFERENCES videos(id),
      language    TEXT    NOT NULL DEFAULT 'auto',
      text        TEXT    NOT NULL,
      segments    TEXT,
      source      TEXT    NOT NULL DEFAULT 'youtube'
                          CHECK(source IN ('youtube', 'whisper', 'manual')),
      fetched_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      visibility  TEXT    NOT NULL DEFAULT 'private'
                          CHECK(visibility IN ('private', 'public')),
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_group_members (
      group_id    INTEGER NOT NULL REFERENCES channel_groups(id),
      channel_id  INTEGER NOT NULL REFERENCES channels(id),
      PRIMARY KEY (group_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS check_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    INTEGER REFERENCES channels(id),
      checked_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      new_videos    INTEGER  NOT NULL DEFAULT 0,
      status        TEXT     NOT NULL DEFAULT 'ok'
                             CHECK(status IN ('ok', 'error', 'quota_exceeded')),
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_videos_channel    ON videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_videos_published  ON videos(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_type       ON videos(type);
    CREATE INDEX IF NOT EXISTS idx_videos_seen       ON videos(is_seen);
    CREATE INDEX IF NOT EXISTS idx_channels_visibility ON channels(visibility);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('schema_version', '1'),
      ('created_at', datetime('now'));
  `);

  const { createLogger } = require('../logger');
  createLogger('db').info({ path: DB_PATH }, 'database initialized');
}

process.on('exit', () => closeDb());

if (require.main === module) {
  initDb();
  closeDb();
}
