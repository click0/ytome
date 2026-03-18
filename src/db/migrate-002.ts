import { getDb } from './init';

/**
 * Миграция 002: TODO (watch later) + комментарии
 * Запуск: node dist/db/migrate-002.js
 */
export function migrate002(): void {
  const db = getDb();

  db.exec(`
    -- =============================================
    -- WATCH LATER (TODO список)
    -- =============================================
    CREATE TABLE IF NOT EXISTS watch_later (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      priority    TEXT    NOT NULL DEFAULT 'medium'
                          CHECK(priority IN ('high', 'medium', 'low')),
      remind_at   DATETIME,                    -- дедлайн / напомнить до
      note        TEXT,                        -- зачем сохранил
      tags        TEXT,                        -- JSON массив тегов
      status      TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending', 'done', 'skipped')),
      added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      done_at     DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_wl_status   ON watch_later(status);
    CREATE INDEX IF NOT EXISTS idx_wl_priority ON watch_later(priority);
    CREATE INDEX IF NOT EXISTS idx_wl_remind   ON watch_later(remind_at);

    -- =============================================
    -- КОММЕНТАРИИ (кеш)
    -- =============================================
    CREATE TABLE IF NOT EXISTS comments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id         INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      youtube_comment_id TEXT  NOT NULL UNIQUE,
      author_name      TEXT    NOT NULL,
      author_channel_id TEXT,
      is_channel_owner BOOLEAN NOT NULL DEFAULT 0,  -- комментарий автора канала
      text             TEXT    NOT NULL,
      like_count       INTEGER NOT NULL DEFAULT 0,
      reply_count      INTEGER NOT NULL DEFAULT 0,
      published_at     DATETIME,
      parent_id        TEXT,   -- если это ответ (youtube comment id родителя)
      fetched_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_comments_video    ON comments(video_id);
    CREATE INDEX IF NOT EXISTS idx_comments_likes    ON comments(like_count DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_owner    ON comments(is_channel_owner);
    CREATE INDEX IF NOT EXISTS idx_comments_parent   ON comments(parent_id);

    -- Обновляем версию схемы
    INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '2');
  `);

  console.log('✅ Migration 002 applied: watch_later + comments');
  db.close();
}

if (require.main === module) {
  migrate002();
}
