import cron from 'node-cron';
import dotenv from 'dotenv';
import { getChannels, updateChannelChecked, upsertVideo, logCheck, updateThumbnailPath, getKnownVideoIds } from '../db/queries';
import { getChannelVideos, getVideosByIds, downloadThumbnail, type VideoInfo } from '../youtube/api';
import { fetchChannelFeed } from '../youtube/rss';
import { getVideoCacheStatus } from '../cache/resolver';
import { getQuotaStatus, canAfford } from '../db/quota';
import { filterVideos } from '../filters/index';
import { resolveProfileForChannel, markProfileUsed } from '../profiles/manager';
import { parseSqliteTime } from '../db/time';
import { createLogger } from '../logger';

dotenv.config({ quiet: true });

const log = createLogger('scheduler');

const CHECK_INTERVAL = process.env.CHECK_INTERVAL || '0 */2 * * *';
const AUTO_THUMBNAILS = process.env.AUTO_DOWNLOAD_THUMBNAILS !== 'false';
// RSS-детекція: ~1 одиниця квоти на канал замість 100 (search.list)
const RSS_DETECTION = process.env.RSS_DETECTION !== 'false';

/**
 * RSS для вже синхронізованих каналів; search.list — для першої синхронізації
 * (фід дає лише ~15 останніх, а початковий бекфіл глибший).
 */
function usesRss(channel: any): boolean {
  return RSS_DETECTION && !!channel.last_checked_at;
}

async function detectNewVideos(
  channel: any,
  since: string | undefined,
  apiKey: string | undefined,
): Promise<{ videos: VideoInfo[]; via: 'rss' | 'search' }> {
  if (usesRss(channel)) {
    // Фолбек лише на збій самого фіду: помилка videos.list (квота, API) — не привід
    // витрачати 100 одиниць на search.list
    let entries: Awaited<ReturnType<typeof fetchChannelFeed>> | null = null;
    try {
      entries = await fetchChannelFeed(channel.youtube_id);
    } catch (e: any) {
      log.warn({ channel: channel.name, error: e.message }, 'RSS failed — falling back to search.list');
    }
    if (entries) {
      const known = getKnownVideoIds(entries.map(e => e.video_id));
      const newIds = entries.map(e => e.video_id).filter(id => !known.has(id));
      return { videos: await getVideosByIds(newIds, channel.youtube_id, apiKey), via: 'rss' };
    }
  }
  const { videos } = await getChannelVideos(channel.youtube_id, {
    publishedAfter: since,
    maxResults: 50,
    apiKey,
  });
  return { videos, via: 'search' };
}

// =============================================
// Проверка одного канала
// =============================================

export async function checkChannel(channel: any): Promise<number> {
  log.info({ channel: channel.name, id: channel.youtube_id }, 'checking channel');

  const since = parseSqliteTime(channel.last_checked_at)?.toISOString();

  // Профіль каналу: власний API key = окрема квота
  const profile = resolveProfileForChannel(channel.youtube_id);
  if (profile) markProfileUsed(profile.id);

  try {
    const { videos: detected, via } = await detectNewVideos(
      channel, since, profile?.youtube_api_key ?? undefined,
    );

    // Стріми, що ще йдуть або заплановані, відкладаємо: тривалість невідома.
    // Вони лишаються у фіді й підхопляться RSS-перевіркою після завершення.
    const videos = detected.filter(v => !v.live_status || v.live_status === 'none');
    const deferred = detected.length - videos.length;
    if (deferred > 0) {
      log.info({ channel: channel.name, deferred }, 'live/upcoming streams deferred');
    }

    // Застосовуємо фільтри
    const { allowed, blocked } = filterVideos(videos);
    if (blocked.length > 0) {
      log.info({ channel: channel.name, filtered: blocked.length }, 'videos filtered out');
    }

    let newCount = 0;
    for (const video of allowed) {
      const videoDbId = upsertVideo(video, channel.id);
      newCount++;

      // Скачиваем thumbnail автоматически
      if (AUTO_THUMBNAILS && video.thumbnail_url) {
        const localPath = await downloadThumbnail(video.youtube_id, video.thumbnail_url);
        if (localPath) updateThumbnailPath(videoDbId, localPath);
      }
    }

    updateChannelChecked(channel.id);
    logCheck(channel.id, newCount, 'ok');

    log.info({ channel: channel.name, newVideos: newCount, via }, 'channel check complete');
    return newCount;

  } catch (err: any) {
    const isQuota = err?.message?.includes('quota');
    logCheck(channel.id, 0, isQuota ? 'quota_exceeded' : 'error', err.message);
    log.error({ channel: channel.name, error: err.message }, 'channel check failed');
    return 0;
  }
}

// =============================================
// Проверка всех каналов
// =============================================

export async function checkAllChannels(): Promise<void> {
  const quota = getQuotaStatus();
  if (quota.critical) {
    log.warn({ used: quota.used, limit: quota.limit }, 'quota critical — skipping scheduled check');
    return;
  }
  if (quota.warning) {
    log.warn({ used: quota.used, limit: quota.limit, percent: quota.percent }, 'quota warning');
  }

  const channels = getChannels();
  log.info({ totalChannels: channels.length, quotaRemaining: quota.remaining }, 'starting scheduled check');

  let totalNew = 0;
  for (const channel of channels) {
    if (!canAfford(usesRss(channel) ? 'videos.list' : 'search.list')) {
      log.warn({ newVideosSoFar: totalNew }, 'quota exhausted mid-run — stopping');
      break;
    }
    const count = await checkChannel(channel);
    totalNew += count;

    // Пауза между каналами, чтобы не исчерпать квоту YouTube API
    await sleep(1000);
  }

  log.info({ totalNew }, 'scheduled check complete');
}

// =============================================
// Запуск планировщика
// =============================================

export function startScheduler(): void {
  log.info({ interval: CHECK_INTERVAL }, 'scheduler started');

  cron.schedule(CHECK_INTERVAL, async () => {
    log.info('running scheduled check');
    await checkAllChannels();
  });

  // Первая проверка сразу при запуске
  checkAllChannels().catch(e => log.error({ error: e.message }, 'initial check failed'));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Запуск напрямую
if (require.main === module) {
  startScheduler();
}
