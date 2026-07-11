import { getDb } from './init';
import type { MusicPlaylistInfo, MusicTrackInfo } from '../youtube/music';

// =============================================
// MUSIC PLAYLISTS
// =============================================

export function addMusicPlaylist(
  info: MusicPlaylistInfo,
  visibility: 'private' | 'public' = 'private'
): number {
  const row = getDb().prepare(`
    INSERT INTO music_playlists (playlist_id, title, description, thumbnail_url,
                                 track_count, source_url, visibility)
    VALUES (@playlist_id, @title, @description, @thumbnail_url,
            @track_count, @source_url, @visibility)
    ON CONFLICT(playlist_id) DO UPDATE SET
      title          = excluded.title,
      description    = excluded.description,
      thumbnail_url  = excluded.thumbnail_url,
      track_count    = excluded.track_count,
      last_synced_at = CURRENT_TIMESTAMP
    RETURNING id
  `).get({
    playlist_id: info.playlist_id,
    title: info.title,
    description: info.description ?? null,
    thumbnail_url: info.thumbnail_url ?? null,
    track_count: info.track_count ?? null,
    source_url: info.source_url ?? null,
    visibility,
  }) as { id: number };
  return row.id;
}

export function getMusicPlaylists(visibility?: 'private' | 'public') {
  const db = getDb();
  return visibility
    ? db.prepare('SELECT * FROM music_playlists WHERE visibility = ? ORDER BY title').all(visibility) as any[]
    : db.prepare('SELECT * FROM music_playlists ORDER BY title').all() as any[];
}

export function getMusicPlaylist(playlistId: string) {
  return getDb().prepare('SELECT * FROM music_playlists WHERE playlist_id = ?').get(playlistId) as any;
}

export function removeMusicPlaylist(playlistId: string): boolean {
  const db = getDb();
  const pl = getMusicPlaylist(playlistId);
  if (!pl) return false;
  db.prepare('DELETE FROM music_tracks WHERE playlist_id = ?').run(pl.id);
  db.prepare('DELETE FROM music_playlists WHERE id = ?').run(pl.id);
  return true;
}

// =============================================
// MUSIC TRACKS
// =============================================

/** Записати всі треки плейлиста; повертає скільки нових/оновлених */
export function saveMusicTracks(playlistDbId: number, tracks: MusicTrackInfo[]): {
  saved: number; removed: number;
} {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO music_tracks (playlist_id, video_youtube_id, position, title,
                              artist, album, duration_sec, thumbnail_url, is_available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(playlist_id, video_youtube_id) DO UPDATE SET
      position     = excluded.position,
      title        = excluded.title,
      artist       = excluded.artist,
      duration_sec = excluded.duration_sec,
      is_available = 1
  `);

  const currentIds = tracks.map(t => t.video_youtube_id);

  const tx = db.transaction(() => {
    for (const t of tracks) {
      stmt.run(
        playlistDbId, t.video_youtube_id, t.position, t.title,
        t.artist ?? null, t.album ?? null, t.duration_sec ?? null, t.thumbnail_url ?? null,
      );
    }
    // Треки що зникли з плейлиста — позначаємо недоступними (не видаляємо: це архів)
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      return db.prepare(`
        UPDATE music_tracks SET is_available = 0
        WHERE playlist_id = ? AND video_youtube_id NOT IN (${placeholders}) AND is_available = 1
      `).run(playlistDbId, ...currentIds).changes;
    }
    return 0;
  });

  const removed = tx() as number;
  db.prepare('UPDATE music_playlists SET last_synced_at = CURRENT_TIMESTAMP, track_count = ? WHERE id = ?')
    .run(tracks.length, playlistDbId);

  return { saved: tracks.length, removed };
}

export function getMusicTracks(playlistDbId: number, opts: {
  artist?: string;
  includeUnavailable?: boolean;
} = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM music_tracks WHERE playlist_id = ?';
  const params: any[] = [playlistDbId];

  if (!opts.includeUnavailable) sql += ' AND is_available = 1';
  if (opts.artist) { sql += ' AND artist LIKE ?'; params.push(`%${opts.artist}%`); }
  sql += ' ORDER BY position';

  return db.prepare(sql).all(...params) as any[];
}
