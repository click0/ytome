import cron from 'node-cron';
import dotenv from 'dotenv';
import { getChannels, updateChannelChecked, upsertVideo, logCheck, updateThumbnailPath } from '../db/queries';
import { getChannelVideos, downloadThumbnail, fetchTranscriptOfflineFirst } from '../youtube/api';
import { getVideoCacheStatus } from '../cache/resolver';
import { getQuotaStatus, canAfford } from '../db/quota';
import { filterVideos } from '../filters/index';

dotenv.config();

const CHECK_INTERVAL = process.env.CHECK_INTERVAL || '0 */2 * * *';
const AUTO_THUMBNAILS = process.env.AUTO_DOWNLOAD_THUMBNAILS !== 'false';

// =============================================
// Проверка одного канала
// =============================================

export async function checkChannel(channel: any): Promise<number> {
  console.log(`🔍 Checking: ${channel.name} (${channel.youtube_id})`);

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
      console.log(`  🚫 Filtered out ${blocked.length} videos from ${channel.name}`);
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

    console.log(`  ✅ ${newCount} new videos from ${channel.name}`);
    return newCount;

  } catch (err: any) {
    const isQuota = err?.message?.includes('quota');
    logCheck(channel.id, 0, isQuota ? 'quota_exceeded' : 'error', err.message);
    console.error(`  ❌ Error checking ${channel.name}:`, err.message);
    return 0;
  }
}

// =============================================
// Проверка всех каналов
// =============================================

export async function checkAllChannels(): Promise<void> {
  const quota = getQuotaStatus();
  if (quota.critical) {
    console.warn(`🔴 Quota critical (${quota.used}/${quota.limit}). Skipping scheduled check.`);
    return;
  }
  if (quota.warning) {
    console.warn(`🟡 Quota warning: ${quota.used}/${quota.limit} units used (${quota.percent}%)`);
  }

  const channels = getChannels();
  console.log(`\n🚀 Starting check: ${channels.length} channels (quota remaining: ${quota.remaining})`);

  let totalNew = 0;
  for (const channel of channels) {
    if (!canAfford('search.list')) {
      console.warn(`🔴 Quota exhausted mid-run. Stopping after ${totalNew} new videos.`);
      break;
    }
    const count = await checkChannel(channel);
    totalNew += count;

    // Пауза между каналами, чтобы не исчерпать квоту YouTube API
    await sleep(1000);
  }

  console.log(`\n✅ Check complete. Total new videos: ${totalNew}`);
}

// =============================================
// Запуск планировщика
// =============================================

export function startScheduler(): void {
  console.log(`⏰ Scheduler started. Interval: "${CHECK_INTERVAL}"`);

  cron.schedule(CHECK_INTERVAL, async () => {
    console.log(`\n[${new Date().toISOString()}] Running scheduled check...`);
    await checkAllChannels();
  });

  // Первая проверка сразу при запуске
  checkAllChannels().catch(console.error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Запуск напрямую
if (require.main === module) {
  startScheduler();
}
