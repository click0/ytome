import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { getNextProxy, getProxyMode } from '../proxy/manager';
import { createLogger } from '../logger';
import { redactCredentials, safeErrorMessage } from '../redact';

const execFileAsync = promisify(execFile);
const log = createLogger('ytdlp');

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';
const YTDLP_BIN    = process.env.YTDLP_BIN    || 'yt-dlp'; // або повний шлях
// З ретраями та backoff великий файл може качатись довше — 30 хв за замовчуванням
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.YTDLP_TIMEOUT_MIN || '30') * 60 * 1000;

/**
 * Вбудована надійність yt-dlp: докачка обірваних файлів,
 * ретраї запитів і фрагментів (DASH) з експоненційним backoff.
 */
const RESILIENCE_ARGS = [
  '--continue',
  '--retries', '10',
  '--fragment-retries', '10',
  '--retry-sleep', 'exp=1:120',
];

// =============================================
// JS-середовище (YouTube вимагає його з yt-dlp 2025.11.12)
// =============================================

/** Версія, з якої yt-dlp має --js-runtimes */
export const JS_RUNTIMES_SINCE: [number, number, number] = [2025, 11, 12];

/** "2025.11.12" / "2025.11.12.1" / нічна "2025.11.12.232920" → [рік, місяць, день] */
export function parseYtDlpVersion(version?: string): [number, number, number] | null {
  const m = version?.trim().match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.\d+)?$/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** Повний шлях до програми в PATH (з PATHEXT на Windows) або null */
export function findExecutable(name: string): string | null {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* немає — далі */ }
    }
  }
  return null;
}

/**
 * Аргументи JS-середовища для yt-dlp. Без нього YouTube віддає лише частину
 * форматів або нічого. deno yt-dlp вмикає сам, Node — лише явно, тож за
 * замовчуванням передаємо той Node, на якому працює ytome.
 * YTDLP_JS_RUNTIME: auto (за замовч.) | none | deno | node | bun | quickjs | <назва>:<шлях>
 */
export function jsRuntimeArgs(version?: string): string[] {
  const setting = (process.env.YTDLP_JS_RUNTIME || 'auto').trim();
  if (setting === 'none') return [];
  const v = parseYtDlpVersion(version);
  if (!v || !versionAtLeast(v, JS_RUNTIMES_SINCE)) return [];   // старий yt-dlp не знає параметра
  if (setting !== 'auto') return ['--js-runtimes', setting];
  if (findExecutable('deno')) return [];                        // deno увімкнений за замовчуванням
  return ['--js-runtimes', `node:${process.execPath}`];
}

// =============================================
// Типи
// =============================================

export type DownloadFormat = 'audio' | 'video' | 'video_hd';

export interface DownloadOptions {
  format?:     DownloadFormat;
  outDir?:     string;
  subtitles?:  boolean;      // завантажити субтитри
  lang?:       string;       // мова субтитрів ('uk', 'en', 'auto')
  cookiePath?: string;       // cookies.txt профілю (Netscape format)
}

export interface DownloadResult {
  filePath:   string;
  format:     string;
  fileSize:   number;
  duration?:  number;
}

// =============================================
// Побудова аргументів yt-dlp
// =============================================

function buildArgs(videoId: string, opts: DownloadOptions, version?: string): string[] {
  const format = opts.format || 'audio';
  const outDir = opts.outDir || path.join(STORAGE_PATH, 'media', format);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outTemplate = path.join(outDir, '%(id)s.%(ext)s');

  const args: string[] = [
    `https://www.youtube.com/watch?v=${videoId}`,
    '--no-playlist',
    '--output', outTemplate,
    '--no-warnings',
    '--quiet',
    '--print', 'after_move:filepath',   // виводить фінальний шлях
    ...RESILIENCE_ARGS,
    ...jsRuntimeArgs(version),
  ];

  // Формат
  switch (format) {
    case 'audio':
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '192K');
      break;
    case 'video':
      args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]', '--merge-output-format', 'mp4');
      break;
    case 'video_hd':
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
      break;
  }

  // Субтитри
  if (opts.subtitles) {
    const lang = opts.lang || 'en';
    args.push(
      '--write-auto-sub',
      '--sub-lang', `${lang},${lang}-*`,
      '--sub-format', 'vtt',
      '--convert-subs', 'srt',
    );
  }

  // ── Cookies (профіль) ───────────────────────
  if (opts.cookiePath && fs.existsSync(opts.cookiePath)) {
    args.push('--cookies', opts.cookiePath);
  }

  // ── Проксі ──────────────────────────────────
  const proxyArg = buildProxyArg();
  if (proxyArg) {
    args.push('--proxy', proxyArg);
  }

  return args;
}

/**
 * Отримати проксі-рядок у форматі, який розуміє yt-dlp.
 * yt-dlp приймає: http://host:port, socks5://host:port
 * Fallback: якщо всі проксі недоступні і режим = fallback → без проксі
 */
function buildProxyArg(): string | null {
  const mode = getProxyMode();
  if (mode === 'disabled') return null;

  const proxy = getNextProxy();

  if (!proxy) {
    if (mode === 'fallback') {
      log.warn('no healthy proxy, using direct connection (fallback)');
      return null;
    }
    throw new Error('yt-dlp: no healthy proxy available and fallback is disabled');
  }

  // yt-dlp розуміє повний URL проксі
  return proxy.url;
}

// =============================================
// Перевірка наявності yt-dlp
// =============================================

export async function checkYtDlp(): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync(YTDLP_BIN, ['--version'], { timeout: 15_000 });
    return { available: true, version: stdout.trim() };
  } catch {
    return { available: false };
  }
}

// =============================================
// Завантаження
// =============================================

export async function downloadVideo(
  videoId: string,
  opts: DownloadOptions = {}
): Promise<DownloadResult> {

  const check = await checkYtDlp();
  if (!check.available) {
    throw new Error(
      `yt-dlp not found. Install from https://github.com/yt-dlp/yt-dlp or set YTDLP_BIN in .env`
    );
  }

  const args     = buildArgs(videoId, opts, check.version);
  const format   = opts.format || 'audio';

  log.info({ videoId, format, proxy: args.includes('--proxy') }, 'downloading');

  let stdout: string, stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(YTDLP_BIN, args, { timeout: DOWNLOAD_TIMEOUT_MS }));
  } catch (e) {
    // Повідомлення execFile містить увесь командний рядок, зокрема --proxy з паролем
    throw new Error(safeErrorMessage(e));
  }

  // --print after_move:filepath виводить шлях у stdout
  const lines = stdout.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    throw new Error(`yt-dlp produced no output.\nstderr: ${redactCredentials(stderr)}`);
  }
  const filePath = lastLine.trim();

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`yt-dlp completed but output file not found.\nstderr: ${redactCredentials(stderr)}`);
  }

  const stat = fs.statSync(filePath);

  return {
    filePath,
    format,
    fileSize: stat.size,
  };
}

// =============================================
// Отримати тільки субтитри (для транскрипцій)
// =============================================

export async function downloadSubtitles(
  videoId: string,
  lang = 'en',
  cookiePath?: string
): Promise<string | null> {
  const check = await checkYtDlp();
  if (!check.available) return null;

  const outDir = path.join(STORAGE_PATH, 'transcripts', 'srt');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outTemplate = path.join(outDir, `%(id)s.%(ext)s`);

  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    '--no-playlist',
    '--skip-download',
    '--write-auto-sub',
    '--sub-lang', `${lang},${lang}-*,en`,
    '--sub-format', 'vtt',
    '--convert-subs', 'srt',
    '--output', outTemplate,
    '--quiet',
    '--no-warnings',
    '--retries', '5',
    ...jsRuntimeArgs(check.version),
  ];

  if (cookiePath && fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  }

  const proxyArg = buildProxyArg();
  if (proxyArg) args.push('--proxy', proxyArg);

  try {
    await execFileAsync(YTDLP_BIN, args, { timeout: 60_000 });

    // Шукаємо завантажений .srt файл
    const srtPath = path.join(outDir, `${videoId}.${lang}.srt`);
    const enPath  = path.join(outDir, `${videoId}.en.srt`);
    const anyPath = [srtPath, enPath].find(p => fs.existsSync(p));

    if (!anyPath) return null;
    return fs.readFileSync(anyPath, 'utf-8');
  } catch (e: any) {
    log.error({ videoId, error: safeErrorMessage(e) }, 'subtitle download failed');
    return null;
  }
}

// =============================================
// Пошук відео без квоти YouTube Data API
// =============================================

export interface SearchResult {
  youtube_id:   string;
  title:        string;
  channel?:     string;
  channel_id?:  string;
  duration_sec?: number;
  view_count?:  number;
  url:          string;
}

/**
 * Пошук через yt-dlp ("ytsearchN:" / "ytsearchdateN:") — без API-ключа й квоти
 * (search.list коштує 100 одиниць). Плоский режим: без відкриття кожного відео.
 */
export async function searchVideos(query: string, opts: {
  limit?: number; sort?: 'relevance' | 'date';
} = {}): Promise<SearchResult[]> {
  const check = await checkYtDlp();
  if (!check.available) {
    throw new Error('yt-dlp not found. Install from https://github.com/yt-dlp/yt-dlp or set YTDLP_BIN in .env');
  }
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const prefix = opts.sort === 'date' ? 'ytsearchdate' : 'ytsearch';
  const args = [
    `${prefix}${limit}:${query}`,
    '--flat-playlist', '--dump-single-json',
    '--no-warnings', '--quiet',
    '--retries', '3',
    ...jsRuntimeArgs(check.version),
  ];
  const proxyArg = buildProxyArg();
  if (proxyArg) args.push('--proxy', proxyArg);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(YTDLP_BIN, args, { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }));
  } catch (e) {
    throw new Error(safeErrorMessage(e));
  }

  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp returned unreadable search results');
  }
  return (data.entries || [])
    .filter((e: any) => e?.id && (e.ie_key === undefined || e.ie_key === 'Youtube'))
    .map((e: any): SearchResult => ({
      youtube_id: e.id,
      title: e.title || 'Untitled',
      channel: e.channel ?? e.uploader ?? undefined,
      channel_id: e.channel_id ?? undefined,
      duration_sec: typeof e.duration === 'number' ? Math.round(e.duration) : undefined,
      view_count: typeof e.view_count === 'number' ? e.view_count : undefined,
      url: `https://youtube.com/watch?v=${e.id}`,
    }));
}

// =============================================
// Аудіо для розпізнавання (Whisper)
// =============================================

/**
 * Лише аудіодоріжка в outDir (без перекодування — це робить ffmpeg).
 * Відео довші за maxDurationSec yt-dlp пропускає, не завантажуючи.
 */
export async function downloadAudioForTranscription(
  videoId: string,
  outDir: string,
  opts: { cookiePath?: string; maxDurationSec?: number } = {},
): Promise<string> {
  const check = await checkYtDlp();
  if (!check.available) {
    throw new Error('yt-dlp not found. Install from https://github.com/yt-dlp/yt-dlp or set YTDLP_BIN in .env');
  }

  const args = [
    `https://www.youtube.com/watch?v=${videoId}`,
    '--no-playlist',
    '-f', 'bestaudio/best',
    '--output', path.join(outDir, '%(id)s.%(ext)s'),
    '--no-warnings',
    '--quiet',
    '--print', 'after_move:filepath',
    ...RESILIENCE_ARGS,
    ...jsRuntimeArgs(check.version),
  ];
  if (opts.maxDurationSec) args.push('--match-filter', `duration <=? ${opts.maxDurationSec}`);
  if (opts.cookiePath && fs.existsSync(opts.cookiePath)) args.push('--cookies', opts.cookiePath);
  const proxyArg = buildProxyArg();
  if (proxyArg) args.push('--proxy', proxyArg);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(YTDLP_BIN, args, { timeout: DOWNLOAD_TIMEOUT_MS }));
  } catch (e) {
    throw new Error(safeErrorMessage(e));
  }
  const filePath = stdout.trim().split('\n').pop()?.trim();
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(opts.maxDurationSec
      ? `audio not downloaded (video longer than ${Math.round(opts.maxDurationSec / 60)} min, or unavailable)`
      : 'audio not downloaded');
  }
  return filePath;
}

// =============================================
// Парсер SRT → чистий текст
// =============================================

export function srtToText(srt: string): string {
  return srt
    .split('\n')
    .filter(line => {
      if (/^\d+$/.test(line.trim())) return false;        // номер блоку
      if (/\d{2}:\d{2}:\d{2}/.test(line)) return false;  // тайм-код
      return line.trim().length > 0;
    })
    .join(' ')
    .replace(/<[^>]+>/g, '')                              // HTML теги
    .replace(/\s+/g, ' ')
    .trim();
}
