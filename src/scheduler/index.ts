import cron from 'node-cron';
import dotenv from 'dotenv';
import { getChannels, updateChannelChecked, upsertVideo, logCheck, updateThumbnailPath } from '../db/queries';
import { getChannelVideos, downloadThumbnail, fetchTranscriptOfflineFirst } from '../youtube/api';
import { getVideoCacheStatus } from '../cache/resolver';
import { getQuotaStatus, canAfford } from '../db/quota';
import { filterVideos } from '../filters/index';
import { createLogger } from '../logger';

dotenv.config();

const log = createLogger('scheduler');

const CHECK_INTERVAL = process.env.CHECK_INTERVAL || '0 */2 * * *';
const AUTO_THUMBNAILS = process.env.AUTO_DOWNLOAD_THUMBNAILS !== 'false';

// =============================================
// Проверка одного канала
// =============================================

export async function checkChannel(channel: any): Promise<number> {
  log.info({ channel: channel.name, id: channel.youtube_id }, 'checking channel');

  const since = channel.last_checked_at
    ? new Date(channel.last_checked_at).toISOString()
    : undefined;

  try {
    const { videos } = await getChannelVideos(channel.youtube_id, {
      publishedAfter: since,
      maxResults: 50,
    });

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

    log.info({ channel: channel.name, newVideos: newCount }, 'channel check complete');
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
    if (!canAfford('search.list')) {
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
