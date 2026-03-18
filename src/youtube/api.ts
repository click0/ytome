import { google, youtube_v3 } from 'googleapis';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { trackQuota, assertQuota } from '../db/quota';
import { axiosProxyConfig, googleApiProxyConfig, getProxyMode } from '../proxy/manager';
import { downloadSubtitles, srtToText } from './ytdlp';
import { getTranscriptCached } from '../cache/resolver';
import { createLogger } from '../logger';

dotenv.config();

const log = createLogger('youtube');

// YouTube client без проксі (для googleapis через fetchOptions)
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

/** Повертає youtube-клієнт з або без проксі-агента */
function getYoutube() {
  const proxyOpts = googleApiProxyConfig();
  if (!proxyOpts.agent) return youtube;
  return google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY,
    // googleapis передає fetchOptions до node-fetch
    fetchOptions: { agent: proxyOpts.agent },
  } as any);
}

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';

// =============================================
// Типы
// =============================================

export interface ChannelInfo {
  youtube_id: string;
  handle?: string;
  name: string;
  description?: string;
  thumbnail_url?: string;
  subscriber_count?: number;
  video_count?: number;
}

export interface VideoInfo {
  youtube_id: string;
  channel_youtube_id: string;
  title: string;
  description?: string;
  published_at: string;
  duration_sec?: number;
  type: 'video' | 'short';
  view_count?: number;
  like_count?: number;
  thumbnail_url?: string;
  tags?: string[];
  language?: string;
}

// =============================================
// Получение информации о канале
// =============================================

export async function getChannelInfo(channelIdOrHandle: string): Promise<ChannelInfo | null> {
  try {
    // Поддержка @handle и UCxxx
    const params: youtube_v3.Params$Resource$Channels$List = {
      part: ['snippet', 'statistics'],
      maxResults: 1,
    };

    if (channelIdOrHandle.startsWith('@')) {
      params.forHandle = channelIdOrHandle.slice(1);
    } else if (channelIdOrHandle.startsWith('UC')) {
      params.id = [channelIdOrHandle];
    } else {
      params.forHandle = channelIdOrHandle;
    }

    const res = await getYoutube().channels.list(params);
    const channel = res.data.items?.[0];
    if (!channel) return null;

    return {
      youtube_id:       channel.id!,
      handle:           channel.snippet?.customUrl ?? undefined,
      name:             channel.snippet?.title || 'Unknown',
      description:      channel.snippet?.description ?? undefined,
      thumbnail_url:    (channel.snippet?.thumbnails?.high?.url
                     || channel.snippet?.thumbnails?.default?.url) ?? undefined,
      subscriber_count: parseInt(channel.statistics?.subscriberCount || '0'),
      video_count:      parseInt(channel.statistics?.videoCount || '0'),
    };
  } catch (err) {
    log.error({ error: (err as Error).message }, 'getChannelInfo failed');
    return null;
  }
}

// =============================================
// Получение видео канала (с пагинацией)
// =============================================

export async function getChannelVideos(
  channelId: string,
  options: {
    maxResults?: number;
    publishedAfter?: string;  // ISO 8601
    pageToken?: string;
  } = {}
): Promise<{ videos: VideoInfo[]; nextPageToken?: string }> {

  const { maxResults = 50, publishedAfter, pageToken } = options;

  assertQuota('search.list');
  const searchRes = await getYoutube().search.list({
    part: ['id', 'snippet'],
    channelId,
    type: ['video'],
    order: 'date',
    maxResults: Math.min(maxResults, 50),
    publishedAfter,
    pageToken,
  });

  trackQuota('search.list', channelId);
  const items = searchRes.data.items || [];
  if (items.length === 0) return { videos: [] };

  // Получаем детали (duration и т.д.) одним запросом
  const videoIds = items.map(i => i.id?.videoId).filter(Boolean) as string[];
  if (videoIds.length > 0) trackQuota('videos.list', channelId, videoIds.length);
  const detailsRes = await getYoutube().videos.list({
    part: ['snippet', 'contentDetails', 'statistics'],
    id: videoIds,
  });

  const detailsMap = new Map(
    (detailsRes.data.items || []).map(v => [v.id, v])
  );

  const videos: VideoInfo[] = items.map(item => {
    const vid = item.id?.videoId!;
    const details = detailsMap.get(vid);
    const durationSec = parseDuration(details?.contentDetails?.duration);
    const isShort = durationSec !== null && durationSec <= 60;

    return {
      youtube_id:          vid,
      channel_youtube_id:  channelId,
      title:               item.snippet?.title || 'Untitled',
      description:         details?.snippet?.description ?? undefined,
      published_at:        item.snippet?.publishedAt || new Date().toISOString(),
      duration_sec:        durationSec ?? undefined,
      type:                isShort ? 'short' : 'video',
      view_count:          parseInt(details?.statistics?.viewCount || '0'),
      like_count:          parseInt(details?.statistics?.likeCount || '0'),
      thumbnail_url:       (item.snippet?.thumbnails?.high?.url
                        || item.snippet?.thumbnails?.default?.url) ?? undefined,
      tags:                details?.snippet?.tags ?? undefined,
      language:            details?.snippet?.defaultAudioLanguage ?? undefined,
    };
  });

  return {
    videos,
    nextPageToken: searchRes.data.nextPageToken ?? undefined,
  };
}

// =============================================
// Транскрипция
// =============================================

/**
 * Offline-first: спочатку перевіряємо локальний кеш транскрипцій.
 * В мережу лізем тільки якщо кешу немає або forceRefresh=true.
 */
export async function fetchTranscriptOfflineFirst(
  videoId: string,
  lang?: string,
  forceRefresh = false
): Promise<{ text: string; segments: any[]; language: string; source: string } | null> {
  if (!forceRefresh) {
    const cached = getTranscriptCached(videoId, lang);
    if (cached.data) {
      const segments = typeof cached.data.segments === 'string'
        ? JSON.parse(cached.data.segments)
        : cached.data.segments;
      return {
        text:     cached.data.text,
        segments: segments || [],
        language: cached.data.language,
        source:   `local:${cached.data.source}`,
      };
    }
  }
  return fetchTranscript(videoId, lang);
}

export async function fetchTranscript(videoId: string, _lang?: string): Promise<{
  text: string;
  segments: Array<{ start: number; dur: number; text: string }>;
  language: string;
  source: string;
} | null> {
  try {
    // Используем youtube-transcript (не требует API ключа)
    const { YoutubeTranscript } = await import('youtube-transcript');
    // youtube-transcript підтримує проксі через axios interceptor
    const proxyCfg = axiosProxyConfig();
    const segments = await YoutubeTranscript.fetchTranscript(videoId, {
      ...(Object.keys(proxyCfg).length ? { httpsAgent: (proxyCfg as any).httpsAgent } : {}),
    } as any);

    const text = segments.map(s => s.text).join(' ');
    return {
      text,
      segments: segments.map(s => ({
        start: s.offset / 1000,
        dur:   s.duration / 1000,
        text:  s.text,
      })),
      language: 'auto',
      source:   'youtube-transcript',
    };
  } catch (err) {
    log.warn({ videoId }, 'youtube-transcript failed, trying yt-dlp fallback');
    try {
      const srt = await downloadSubtitles(videoId);
      if (srt) {
        const text = srtToText(srt);
        return { text, segments: [], language: 'auto', source: 'yt-dlp' };
      }
    } catch (e2) {
      log.error({ videoId, error: (e2 as Error).message }, 'yt-dlp fallback also failed');
    }
    return null;
  }
}

// =============================================
// Скачивание thumbnail
// =============================================

export async function downloadThumbnail(
  videoId: string,
  url: string
): Promise<string | null> {
  try {
    const dir = path.join(STORAGE_PATH, 'thumbnails');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${videoId}.jpg`);
    if (fs.existsSync(filePath)) return filePath;

    const res = await axios.get(url, { responseType: 'stream', ...axiosProxyConfig() });
    const writer = fs.createWriteStream(filePath);
    res.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (err) {
    log.error({ videoId, error: (err as Error).message }, 'thumbnail download failed');
    return null;
  }
}

// =============================================
// Утилиты
// =============================================

/** ISO 8601 duration → секунды. PT1H2M3S → 3723 */
function parseDuration(iso?: string | null): number | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (parseInt(m[1] || '0') * 3600)
       + (parseInt(m[2] || '0') * 60)
       + parseInt(m[3] || '0');
}
