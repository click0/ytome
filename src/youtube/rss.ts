/**
 * RSS-фіди каналів YouTube — безкоштовна детекція нових відео.
 *
 * https://www.youtube.com/feeds/videos.xml?channel_id=UC...
 * Без API-ключа, без квоти. Повертає ~15 останніх публікацій
 * (включно зі стрімами, що йдуть або заплановані).
 *
 * Порівняння: search.list = 100 одиниць квоти на канал за перевірку.
 */
import axios from 'axios';
import { axiosProxyConfig } from '../proxy/manager';

export interface FeedEntry {
  video_id: string;
  channel_id: string;
  title: string;
  published_at: string;
}

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].trim()) : undefined;
}

/** Розібрати Atom-фід YouTube на записи (нові → старі, як у фіді) */
export function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const videoId = tag(block, 'yt:videoId');
    const channelId = tag(block, 'yt:channelId');
    const published = tag(block, 'published');
    if (!videoId || !channelId || !published) continue;
    entries.push({
      video_id: videoId,
      channel_id: channelId,
      title: tag(block, 'title') || 'Untitled',
      published_at: published,
    });
  }
  return entries;
}

export async function fetchChannelFeed(channelId: string): Promise<FeedEntry[]> {
  const res = await axios.get<string>(FEED_URL + encodeURIComponent(channelId), {
    timeout: 15_000,
    responseType: 'text',
    ...(await axiosProxyConfig()),
  });
  return parseFeed(res.data);
}
