/**
 * Підсумки транскриптів: збереження, автоматична черга, дайджест.
 *
 * Черга бере нові відео з каналів з auto_summary = 1 (без shorts і коротких),
 * тягне транскрипт (кеш → мережа з cookies профілю) і підсумовує через
 * AI-балансувальник. Невдачі — з причиною: блок IP / збій AI повторюються
 * з паузою, що росте; «немає субтитрів» і подібне — більше не пробуємо.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/init';
import { ensureSummarySchema } from '../db/migrate-007';
import { saveTranscriptForVideo } from '../db/queries';
import { fetchTranscriptOfflineFirst } from '../youtube/api';
import { TranscriptUnavailableError } from '../youtube/transcript-errors';
import { lookupVideoMeta, formatTimestamp } from '../export/transcript';
import { profileOptsForVideo } from '../profiles/manager';
import { summarizeTranscript, summaryLanguage, PROMPT_VERSION, type Chapter, type VideoSummary } from './summarize';
import { createLogger } from '../logger';

const log = createLogger('summary');

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';

/** Причини, з якими повтор не допоможе */
const PERMANENT = new Set(['no_captions', 'login_required', 'unavailable', 'language']);
const MAX_ATTEMPTS = 5;

export interface StoredSummary extends VideoSummary {
  video_id: string;
  prompt_version: number;
  created_at: string;
  updated_at: string;
}

function rowToSummary(r: any): StoredSummary {
  return {
    video_id: r.youtube_id,
    tldr: r.tldr,
    key_points: r.key_points ? JSON.parse(r.key_points) : [],
    chapters: r.chapters ? JSON.parse(r.chapters) : [],
    language: r.language,
    provider: r.provider,
    prompt_version: r.prompt_version,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function getSummary(youtubeId: string): StoredSummary | null {
  ensureSummarySchema();
  const row = getDb().prepare(`
    SELECT s.*, v.youtube_id FROM summaries s JOIN videos v ON v.id = s.video_id
    WHERE v.youtube_id = ? AND s.status = 'ok'
  `).get(youtubeId);
  return row ? rowToSummary(row) : null;
}

/** TL;DR для списку відео (для стрічки) */
export function getTldrs(youtubeIds: string[]): Map<string, string> {
  ensureSummarySchema();
  if (youtubeIds.length === 0) return new Map();
  const rows = getDb().prepare(`
    SELECT v.youtube_id, s.tldr FROM summaries s JOIN videos v ON v.id = s.video_id
    WHERE s.status = 'ok' AND v.youtube_id IN (${youtubeIds.map(() => '?').join(',')})
  `).all(...youtubeIds) as Array<{ youtube_id: string; tldr: string }>;
  return new Map(rows.map(r => [r.youtube_id, r.tldr]));
}

function saveSummary(videoDbId: number, s: VideoSummary, transcriptHash: string): void {
  getDb().prepare(`
    INSERT INTO summaries (video_id, status, language, tldr, key_points, chapters, provider,
                           prompt_version, transcript_hash, reason, attempts, next_attempt_at)
    VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
    ON CONFLICT(video_id) DO UPDATE SET
      status = 'ok', language = excluded.language, tldr = excluded.tldr,
      key_points = excluded.key_points, chapters = excluded.chapters,
      provider = excluded.provider, prompt_version = excluded.prompt_version,
      transcript_hash = excluded.transcript_hash, reason = NULL, attempts = 0,
      next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
  `).run(videoDbId, s.language, s.tldr, JSON.stringify(s.key_points), JSON.stringify(s.chapters),
    s.provider, PROMPT_VERSION, transcriptHash);
}

/** Невдача: skipped назавжди або retry з паузою 1, 2, 4, … год (до 48) */
function saveFailure(videoDbId: number, reason: string, permanent: boolean): 'retry' | 'skipped' {
  const db = getDb();
  const prev = db.prepare('SELECT attempts FROM summaries WHERE video_id = ?').get(videoDbId) as
    { attempts: number } | undefined;
  const attempts = (prev?.attempts ?? 0) + 1;
  const status = permanent || attempts >= MAX_ATTEMPTS ? 'skipped' : 'retry';
  const delayHours = Math.min(48, 2 ** (attempts - 1));
  db.prepare(`
    INSERT INTO summaries (video_id, status, reason, attempts, next_attempt_at)
    VALUES (?, ?, ?, ?, datetime('now', ?))
    ON CONFLICT(video_id) DO UPDATE SET
      status = excluded.status, reason = excluded.reason, attempts = excluded.attempts,
      next_attempt_at = excluded.next_attempt_at, updated_at = CURRENT_TIMESTAMP
  `).run(videoDbId, status, reason, attempts, `+${delayHours} hours`);
  return status;
}

export interface SummarizeResult {
  summary: StoredSummary | VideoSummary;
  cached: boolean;
  saved: boolean;            // false — відео поза архівом, підсумок не збережено
}

/**
 * Підсумок відео: зі збереженого (та сама мова й версія промпту),
 * інакше транскрипт → AI. Кидає TranscriptUnavailableError з причиною.
 */
export async function summarizeVideo(youtubeId: string, opts: {
  language?: string; force?: boolean;
} = {}): Promise<SummarizeResult> {
  ensureSummarySchema();
  const lang = summaryLanguage(opts.language);

  const existing = getSummary(youtubeId);
  if (existing && !opts.force && existing.language === lang && existing.prompt_version === PROMPT_VERSION) {
    return { summary: existing, cached: true, saved: true };
  }

  const video = getDb().prepare(`
    SELECT v.id, v.title, v.description, c.name AS channel FROM videos v
    JOIN channels c ON c.id = v.channel_id WHERE v.youtube_id = ?
  `).get(youtubeId) as { id: number; title: string; description: string | null; channel: string } | undefined;

  const transcript = await fetchTranscriptOfflineFirst(youtubeId, undefined, false, profileOptsForVideo(youtubeId));
  if (video && !transcript.source.startsWith('local:')) saveTranscriptForVideo(youtubeId, transcript);

  const meta = video
    ? { title: video.title, channel: video.channel, description: video.description ?? undefined }
    : await lookupVideoMeta(youtubeId);

  const summary = await summarizeTranscript({
    videoId: youtubeId, ...meta, text: transcript.text, segments: transcript.segments,
  }, { language: lang });

  if (!video) return { summary, cached: false, saved: false };

  const hash = crypto.createHash('sha1').update(transcript.text).digest('hex');
  saveSummary(video.id, summary, hash);
  log.info({ videoId: youtubeId, provider: summary.provider, chapters: summary.chapters.length }, 'video summarized');
  return { summary: getSummary(youtubeId)!, cached: false, saved: true };
}

// =============================================
// Автоматична черга
// =============================================

export function setChannelAutoSummary(channelYoutubeId: string, enabled: boolean): boolean {
  ensureSummarySchema();
  return getDb().prepare('UPDATE channels SET auto_summary = ? WHERE youtube_id = ?')
    .run(enabled ? 1 : 0, channelYoutubeId).changes > 0;
}

/** Відео, що чекають на підсумок (нові спершу) */
export function pendingSummaries(limit: number): Array<{ id: number; youtube_id: string }> {
  ensureSummarySchema();
  const minDuration = parseInt(process.env.SUMMARY_MIN_DURATION_SEC || '180');
  return getDb().prepare(`
    SELECT v.id, v.youtube_id FROM videos v
    JOIN channels c ON c.id = v.channel_id
    LEFT JOIN summaries s ON s.video_id = v.id
    WHERE c.auto_summary = 1
      AND v.type = 'video'
      AND (v.duration_sec IS NULL OR v.duration_sec >= ?)
      AND (s.id IS NULL OR (s.status = 'retry' AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= datetime('now'))))
    ORDER BY v.published_at DESC
    LIMIT ?
  `).all(minDuration, limit) as Array<{ id: number; youtube_id: string }>;
}

function summarizedToday(): number {
  return (getDb().prepare(`
    SELECT COUNT(*) AS n FROM summaries WHERE status = 'ok' AND date(updated_at) = date('now')
  `).get() as { n: number }).n;
}

export interface QueueResult {
  processed: number;
  summarized: number;
  retry: number;
  skipped: number;
  stopped?: string;          // чому зупинились достроково
}

/** AI недоступний зовсім — далі пробувати безглуздо */
function aiUnavailable(e: Error): boolean {
  return /No available AI providers|All providers failed/.test(e.message);
}

export async function processSummaryQueue(opts: { limit?: number } = {}): Promise<QueueResult> {
  const dailyLimit = parseInt(process.env.SUMMARY_DAILY_LIMIT || '50');
  const result: QueueResult = { processed: 0, summarized: 0, retry: 0, skipped: 0 };

  const budget = Math.max(0, dailyLimit - summarizedToday());
  if (budget === 0) return { ...result, stopped: `daily limit reached (${dailyLimit})` };

  for (const v of pendingSummaries(Math.min(opts.limit ?? budget, budget))) {
    result.processed++;
    try {
      await summarizeVideo(v.youtube_id);
      result.summarized++;
    } catch (e: any) {
      const permanent = e instanceof TranscriptUnavailableError && PERMANENT.has(e.reason);
      const reason = e instanceof TranscriptUnavailableError ? `${e.reason}: ${e.message}` : e.message;
      result[saveFailure(v.id, reason, permanent)]++;
      log.warn({ videoId: v.youtube_id, reason }, 'summary failed');
      if (!(e instanceof TranscriptUnavailableError) && aiUnavailable(e)) {
        result.stopped = 'no AI provider available';
        break;
      }
    }
  }

  if (result.processed) log.info(result, 'summary queue processed');
  return result;
}

// =============================================
// Дайджест і форматування
// =============================================

export function chapterLink(videoId: string, start: number | null): string {
  return start === null
    ? `https://youtube.com/watch?v=${videoId}`
    : `https://youtube.com/watch?v=${videoId}&t=${start}s`;
}

/** Розділи текстом: "[mm:ss] Назва" */
export function formatChapters(chapters: Chapter[]): string[] {
  return chapters.map(c => c.start === null ? c.title : `[${formatTimestamp(c.start)}] ${c.title}`);
}

/** Текст підсумку для .nfo / .txt */
export function summaryAsText(s: Pick<VideoSummary, 'tldr' | 'key_points' | 'chapters'>): string {
  return [
    s.tldr,
    s.key_points.length ? s.key_points.map(p => `• ${p}`).join('\n') : '',
    s.chapters.length ? formatChapters(s.chapters).join('\n') : '',
  ].filter(Boolean).join('\n\n');
}

export interface DigestResult {
  path: string;
  since: string;
  channels: number;
  videos: number;
  without_summary: number;
  markdown: string;
}

/** Markdown-дайджест нових відео з підсумками, згрупований за каналами */
export function buildDigest(opts: { since: string; channelYoutubeId?: string }): DigestResult {
  ensureSummarySchema();
  const params: unknown[] = [opts.since];
  let where = 'v.published_at > ?';
  if (opts.channelYoutubeId) { where += ' AND c.youtube_id = ?'; params.push(opts.channelYoutubeId); }

  const rows = getDb().prepare(`
    SELECT v.youtube_id, v.title, v.published_at, v.duration_sec, c.name AS channel,
           s.tldr, s.key_points, s.chapters, s.language, s.provider, s.prompt_version,
           s.created_at, s.updated_at
    FROM videos v JOIN channels c ON c.id = v.channel_id
    LEFT JOIN summaries s ON s.video_id = v.id AND s.status = 'ok'
    WHERE ${where}
    ORDER BY c.name, v.published_at DESC
  `).all(...params) as any[];

  const byChannel = new Map<string, any[]>();
  for (const r of rows) byChannel.set(r.channel, [...(byChannel.get(r.channel) || []), r]);

  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# Дайджест ${date}`, '', `Нові відео з ${opts.since.slice(0, 10)}: ${rows.length}`, ''];
  for (const [channel, videos] of byChannel) {
    lines.push(`## ${channel}`, '');
    for (const v of videos) {
      const minutes = v.duration_sec ? ` · ${Math.round(v.duration_sec / 60)} хв` : '';
      lines.push(`### [${v.title}](https://youtube.com/watch?v=${v.youtube_id})`,
        `${v.published_at.slice(0, 10)}${minutes}`, '');
      if (!v.tldr) { lines.push('_Підсумку ще немає_', ''); continue; }
      const s = rowToSummary(v);
      lines.push(s.tldr, '');
      if (s.key_points.length) lines.push(...s.key_points.map(p => `- ${p}`), '');
      if (s.chapters.length) {
        lines.push(...s.chapters.map(c => c.start === null
          ? `- ${c.title}`
          : `- [${formatTimestamp(c.start)}](${chapterLink(v.youtube_id, c.start)}) ${c.title}`), '');
      }
    }
  }
  const markdown = lines.join('\n').trimEnd() + '\n';

  const dir = path.join(STORAGE_PATH, 'exports', 'digests');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = opts.channelYoutubeId ? `-${opts.channelYoutubeId.replace(/[^\w-]/g, '_')}` : '';
  const filePath = path.resolve(dir, `digest-${date}${suffix}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');

  return {
    path: filePath,
    since: opts.since,
    channels: byChannel.size,
    videos: rows.length,
    without_summary: rows.filter(r => !r.tldr).length,
    markdown,
  };
}

/** Підсумок для .nfo (null — немає) */
export function getSummaryText(youtubeId: string): string | null {
  const s = getSummary(youtubeId);
  return s ? summaryAsText(s) : null;
}
