import { getDb } from './init';

// =============================================
// WATCH LATER
// =============================================

export interface WatchLaterItem {
  id: number;
  video_id: number;
  youtube_id: string;
  title: string;
  channel_name: string;
  duration_sec: number | null;
  priority: 'high' | 'medium' | 'low';
  remind_at: string | null;
  note: string | null;
  tags: string[] | null;
  status: 'pending' | 'done' | 'skipped';
  added_at: string;
  done_at: string | null;
  url: string;
}

export function addToWatchLater(
  videoYoutubeId: string,
  options: {
    priority?: 'high' | 'medium' | 'low';
    remindAt?: string;
    note?: string;
    tags?: string[];
  } = {}
): { id: number } | null {
  const db = getDb();
  try {
    const video = db.prepare('SELECT id FROM videos WHERE youtube_id = ?').get(videoYoutubeId) as any;
    if (!video) return null;

    const existing = db.prepare(
      "SELECT id FROM watch_later WHERE video_id = ? AND status = 'pending'"
    ).get(video.id) as any;

    if (existing) return { id: existing.id };

    const row = db.prepare(`
      INSERT INTO watch_later (video_id, priority, remind_at, note, tags)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      video.id,
      options.priority || 'medium',
      options.remindAt || null,
      options.note || null,
      options.tags ? JSON.stringify(options.tags) : null
    ) as { id: number };

    return row;
  } finally {
    db.close();
  }
}

export function getWatchLater(options: {
  status?: 'pending' | 'done' | 'skipped' | 'all';
  priority?: 'high' | 'medium' | 'low';
  tag?: string;
  overdue?: boolean;
} = {}): WatchLaterItem[] {
  const db = getDb();
  try {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    const status = options.status || 'pending';
    if (status !== 'all') {
      where += ' AND wl.status = ?';
      params.push(status);
    }

    if (options.priority) {
      where += ' AND wl.priority = ?';
      params.push(options.priority);
    }

    if (options.overdue) {
      where += ' AND wl.remind_at IS NOT NULL AND wl.remind_at < datetime("now")';
    }

    if (options.tag) {
      where += ` AND wl.tags LIKE ?`;
      params.push(`%"${options.tag}"%`);
    }

    const rows = db.prepare(`
      SELECT
        wl.id, wl.priority, wl.remind_at, wl.note, wl.tags,
        wl.status, wl.added_at, wl.done_at,
        v.id     AS video_id,
        v.youtube_id,
        v.title,
        v.duration_sec,
        c.name   AS channel_name
      FROM watch_later wl
      JOIN videos v  ON v.id  = wl.video_id
      JOIN channels c ON c.id = v.channel_id
      ${where}
      ORDER BY
        CASE wl.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        wl.remind_at ASC NULLS LAST,
        wl.added_at ASC
    `).all(...params) as any[];

    return rows.map(r => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : null,
      url: `https://youtube.com/watch?v=${r.youtube_id}`,
    }));
  } finally {
    db.close();
  }
}

export function updateWatchLaterStatus(
  id: number,
  status: 'done' | 'skipped' | 'pending'
): void {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE watch_later SET
        status  = ?,
        done_at = CASE WHEN ? IN ('done','skipped') THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = ?
    `).run(status, status, id);
  } finally {
    db.close();
  }
}

export function updateWatchLaterPriority(id: number, priority: 'high' | 'medium' | 'low'): void {
  const db = getDb();
  try {
    db.prepare('UPDATE watch_later SET priority = ? WHERE id = ?').run(priority, id);
  } finally {
    db.close();
  }
}

export function updateWatchLaterNote(id: number, note: string): void {
  const db = getDb();
  try {
    db.prepare('UPDATE watch_later SET note = ? WHERE id = ?').run(note, id);
  } finally {
    db.close();
  }
}

export function getWatchLaterStats() {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='done'     THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status='skipped'  THEN 1 ELSE 0 END) AS skipped,
        SUM(CASE WHEN priority='high' AND status='pending' THEN 1 ELSE 0 END) AS high_priority,
        SUM(CASE WHEN remind_at < datetime('now') AND status='pending' THEN 1 ELSE 0 END) AS overdue
      FROM watch_later
    `).get() as any;
  } finally {
    db.close();
  }
}

// =============================================
// КОММЕНТАРИИ
// =============================================

export interface CommentRow {
  id: number;
  youtube_comment_id: string;
  author_name: string;
  is_channel_owner: boolean;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: string;
  parent_id: string | null;
  replies?: CommentRow[];
}

export function saveComments(videoYoutubeId: string, comments: any[]): void {
  const db = getDb();
  try {
    const video = db.prepare('SELECT id FROM videos WHERE youtube_id = ?').get(videoYoutubeId) as any;
    if (!video) return;

    const stmt = db.prepare(`
      INSERT INTO comments (
        video_id, youtube_comment_id, author_name, author_channel_id,
        is_channel_owner, text, like_count, reply_count, published_at, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(youtube_comment_id) DO UPDATE SET
        like_count  = excluded.like_count,
        reply_count = excluded.reply_count,
        fetched_at  = CURRENT_TIMESTAMP
    `);

    const insertMany = db.transaction((items: any[]) => {
      for (const c of items) {
        stmt.run(
          video.id,
          c.youtube_comment_id,
          c.author_name,
          c.author_channel_id || null,
          c.is_channel_owner ? 1 : 0,
          c.text,
          c.like_count || 0,
          c.reply_count || 0,
          c.published_at || null,
          c.parent_id || null
        );
      }
    });

    insertMany(comments);
  } finally {
    db.close();
  }
}

export function getCachedComments(videoYoutubeId: string, options: {
  limit?: number;
  ownerOnly?: boolean;
  withReplies?: boolean;
} = {}): CommentRow[] {
  const db = getDb();
  try {
    const { limit = 20, ownerOnly = false, withReplies = false } = options;

    const where = ownerOnly
      ? "AND c.is_channel_owner = 1"
      : "AND c.parent_id IS NULL";

    const rows = db.prepare(`
      SELECT c.*
      FROM comments c
      JOIN videos v ON v.id = c.video_id
      WHERE v.youtube_id = ? ${where}
      ORDER BY c.is_channel_owner DESC, c.like_count DESC
      LIMIT ?
    `).all(videoYoutubeId, limit) as any[];

    let result: CommentRow[] = rows.map(r => ({
      ...r,
      is_channel_owner: !!r.is_channel_owner,
      replies: [],
    }));

    if (withReplies && result.length > 0) {
      const parentIds = result.map(r => r.youtube_comment_id);
      const replies = db.prepare(`
        SELECT * FROM comments
        WHERE parent_id IN (${parentIds.map(() => '?').join(',')})
        ORDER BY like_count DESC
        LIMIT 5
      `).all(...parentIds) as any[];

      const repliesMap = new Map<string, CommentRow[]>();
      for (const reply of replies) {
        if (!repliesMap.has(reply.parent_id)) repliesMap.set(reply.parent_id, []);
        repliesMap.get(reply.parent_id)!.push(reply);
      }

      result = result.map(r => ({
        ...r,
        replies: repliesMap.get(r.youtube_comment_id) || [],
      }));
    }

    return result;
  } finally {
    db.close();
  }
}

export function hasComments(videoYoutubeId: string): boolean {
  const db = getDb();
  try {
    return !!db.prepare(`
      SELECT 1 FROM comments c
      JOIN videos v ON v.id = c.video_id
      WHERE v.youtube_id = ? LIMIT 1
    `).get(videoYoutubeId);
  } finally {
    db.close();
  }
}
