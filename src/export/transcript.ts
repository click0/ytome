/**
 * Транскрипт у локальний .txt — з кешу, а якщо його немає, то з YouTube.
 *
 * storage/exports/transcripts/<videoId>[.<мова>][.timed].txt
 *
 * Працює й для відео, яких немає в архіві: назву й канал тоді беремо
 * з oEmbed (без API-ключа й без квоти).
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getDb } from '../db/init';
import { saveTranscriptForVideo } from '../db/queries';
import { axiosProxyConfig } from '../proxy/manager';
import {
  fetchTranscriptOfflineFirst, type TranscriptFetchOptions, type TranscriptResult,
} from '../youtube/api';
import { createLogger } from '../logger';

const log = createLogger('transcript-export');

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';

export interface TranscriptMeta {
  title?: string;
  channel?: string;
}

/** 75 → 01:15, 3725 → 1:02:05 */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Заголовок (назва, канал, посилання) + текст, або рядки з таймкодами */
export function formatTranscript(
  videoId: string,
  transcript: Pick<TranscriptResult, 'text' | 'segments'>,
  meta: TranscriptMeta,
  opts: { timestamps?: boolean } = {},
): string {
  const header = [
    meta.title || videoId,
    meta.channel,
    `https://youtube.com/watch?v=${videoId}`,
  ].filter(Boolean).join('\n');

  const body = opts.timestamps && transcript.segments.length > 0
    ? transcript.segments.map(s => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n')
    : transcript.text;

  return `${header}\n\n${body.trim()}\n`;
}

/** Назва й канал: з архіву, інакше з oEmbed; без них файл просто без заголовка */
export async function lookupVideoMeta(videoId: string): Promise<TranscriptMeta> {
  const row = getDb().prepare(`
    SELECT v.title, c.name AS channel FROM videos v
    JOIN channels c ON c.id = v.channel_id WHERE v.youtube_id = ?
  `).get(videoId) as TranscriptMeta | undefined;
  if (row?.title) return row;

  try {
    const res = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: 10_000,
      ...(await axiosProxyConfig()),
    });
    return { title: res.data?.title, channel: res.data?.author_name };
  } catch (e: any) {
    log.debug({ videoId, error: e.message }, 'oEmbed lookup failed');
    return {};
  }
}

export interface TranscriptExportResult {
  path: string;
  source: string;
  language: string;
  chars: number;
  timestamps: boolean;   // false, якщо просили, але сегментів немає (yt-dlp)
}

export async function exportTranscriptToFile(videoId: string, opts: {
  language?: string;
  forceRefresh?: boolean;
  timestamps?: boolean;
  fetch?: TranscriptFetchOptions;
} = {}): Promise<TranscriptExportResult> {
  // Кидає TranscriptUnavailableError з причиною — її покаже обробник
  const transcript = await fetchTranscriptOfflineFirst(
    videoId, opts.language, opts.forceRefresh, opts.fetch,
  );
  if (!transcript.source.startsWith('local:')) saveTranscriptForVideo(videoId, transcript);

  const timestamps = !!opts.timestamps && transcript.segments.length > 0;
  const content = formatTranscript(videoId, transcript, await lookupVideoMeta(videoId), { timestamps });

  const dir = path.join(STORAGE_PATH, 'exports', 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  // id і мова приходять від користувача — лише безпечні символи, файл не виходить за межі dir
  const name = [videoId, opts.language, timestamps ? 'timed' : null]
    .filter(Boolean).map(p => String(p).replace(/[^\w-]/g, '_')).join('.') + '.txt';
  const filePath = path.resolve(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');

  log.info({ videoId, filePath, chars: content.length }, 'transcript exported');
  return {
    path: filePath,
    source: transcript.source,
    language: transcript.language,
    chars: content.length,
    timestamps,
  };
}
