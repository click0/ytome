/**
 * YouTube Music: архівування плейлистів.
 *
 * YouTube Music плейлисти — це звичайні YouTube-плейлисти (PLxxx, OLAKxxx, RDxxx),
 * доступні через playlistItems.list з тим самим API-ключем.
 * Вартість: 1 одиниця квоти на сторінку (50 треків) — дуже дешево.
 */
import { getYoutube } from './api';
import { trackQuota, assertQuota } from '../db/quota';
import { createLogger } from '../logger';

const log = createLogger('music');

export interface MusicPlaylistInfo {
  playlist_id: string;
  title: string;
  description?: string;
  thumbnail_url?: string;
  track_count?: number;
  source_url?: string;
}

export interface MusicTrackInfo {
  video_youtube_id: string;
  position: number;
  title: string;
  artist?: string;
  album?: string;
  duration_sec?: number;
  thumbnail_url?: string;
}

/** Витягти playlist ID з URL (youtube.com або music.youtube.com) або повернути як є */
export function extractPlaylistId(input: string): string {
  const m = input.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : input;
}

/** Метадані плейлиста */
export async function fetchPlaylistInfo(playlistId: string): Promise<MusicPlaylistInfo | null> {
  const yt = await getYoutube();

  assertQuota('videos.list');
  const res = await yt.playlists.list({
    part: ['snippet', 'contentDetails'],
    id: [playlistId],
  });
  trackQuota('videos.list', playlistId);

  const pl = res.data.items?.[0];
  if (!pl) return null;

  return {
    playlist_id: playlistId,
    title: pl.snippet?.title || 'Untitled playlist',
    description: pl.snippet?.description ?? undefined,
    thumbnail_url: (pl.snippet?.thumbnails?.high?.url || pl.snippet?.thumbnails?.default?.url) ?? undefined,
    track_count: pl.contentDetails?.itemCount ?? undefined,
  };
}

/** Всі треки плейлиста (з пагінацією, 50/сторінка, 1 unit/сторінка) */
export async function fetchPlaylistTracks(playlistId: string): Promise<MusicTrackInfo[]> {
  const yt = await getYoutube();
  const tracks: MusicTrackInfo[] = [];
  let pageToken: string | undefined;

  do {
    assertQuota('videos.list');
    const res = await yt.playlistItems.list({
      part: ['snippet', 'contentDetails'],
      playlistId,
      maxResults: 50,
      pageToken,
    });
    trackQuota('videos.list', playlistId);

    for (const item of res.data.items || []) {
      const vid = item.contentDetails?.videoId;
      if (!vid) continue;
      // Видалені/приватні треки мають порожній snippet.title = "Deleted video"
      const title = item.snippet?.title || '';
      if (title === 'Deleted video' || title === 'Private video') continue;

      tracks.push({
        video_youtube_id: vid,
        position: item.snippet?.position ?? tracks.length,
        title,
        // videoOwnerChannelTitle — канал-власник треку; для музики це "Artist - Topic"
        artist: (item.snippet as any)?.videoOwnerChannelTitle?.replace(/ - Topic$/, '') ?? undefined,
        thumbnail_url: (item.snippet?.thumbnails?.high?.url
          || item.snippet?.thumbnails?.default?.url) ?? undefined,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Тривалість — batch-запит videos.list (50 id за раз, 1 unit)
  await enrichDurations(tracks);

  log.info({ playlistId, tracks: tracks.length }, 'playlist tracks fetched');
  return tracks;
}

async function enrichDurations(tracks: MusicTrackInfo[]): Promise<void> {
  const yt = await getYoutube();

  for (let i = 0; i < tracks.length; i += 50) {
    const batch = tracks.slice(i, i + 50);
    assertQuota('videos.list');
    const res = await yt.videos.list({
      part: ['contentDetails'],
      id: batch.map(t => t.video_youtube_id),
    });
    trackQuota('videos.list', undefined, 1);

    const durations = new Map(
      (res.data.items || []).map(v => [v.id, parseIsoDuration(v.contentDetails?.duration)])
    );
    for (const t of batch) {
      const d = durations.get(t.video_youtube_id);
      if (d != null) t.duration_sec = d;
    }
  }
}

/** PT1H2M3S → 3723 */
function parseIsoDuration(iso?: string | null): number | undefined {
  if (!iso) return undefined;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return undefined;
  return (parseInt(m[1] || '0') * 3600) + (parseInt(m[2] || '0') * 60) + parseInt(m[3] || '0');
}
