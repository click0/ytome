import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { getNextProxy, getProxyMode } from '../proxy/manager';

const execFileAsync = promisify(execFile);

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';
const YTDLP_BIN    = process.env.YTDLP_BIN    || 'yt-dlp'; // або повний шлях

// =============================================
// Типи
// =============================================

export type DownloadFormat = 'audio' | 'video' | 'video_hd';

export interface DownloadOptions {
  format?:    DownloadFormat;
  outDir?:    string;
  subtitles?: boolean;       // завантажити субтитри
  lang?:      string;        // мова субтитрів ('uk', 'en', 'auto')
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

function buildArgs(videoId: string, opts: DownloadOptions): string[] {
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
      console.warn('⚠  yt-dlp: no healthy proxy, using direct connection (fallback)');
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
    const { stdout } = await execFileAsync(YTDLP_BIN, ['--version']);
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

  const args     = buildArgs(videoId, opts);
  const format   = opts.format || 'audio';

  console.log(`⬇  yt-dlp downloading ${videoId} [${format}]${args.includes('--proxy') ? ' via proxy' : ' direct'}...`);

  const { stdout, stderr } = await execFileAsync(YTDLP_BIN, args, {
    timeout: 10 * 60 * 1000, // 10 хвилин максимум
  });

  // --print after_move:filepath виводить шлях у stdout
  const filePath = stdout.trim().split('\n').pop()!.trim();

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`yt-dlp completed but output file not found.\nstderr: ${stderr}`);
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
  lang = 'en'
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
  ];

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
    console.error(`downloadSubtitles(${videoId}) error:`, e.message);
    return null;
  }
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
