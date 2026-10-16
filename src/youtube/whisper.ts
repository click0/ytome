/**
 * Розпізнавання аудіо через Whisper — для відео без субтитрів.
 *
 * yt-dlp качає лише аудіодоріжку → ffmpeg стискає (моно, 16 кГц, 32 кбіт/с) і ріже
 * на шматки по 10 хв (ліміт API — 25 МБ на файл) → кожен шматок іде в
 * Whisper-сумісний API з response_format=verbose_json, тож сегменти мають таймкоди.
 *
 * Провайдери: Groq (whisper-large-v3, безкоштовний тариф) і OpenAI (whisper-1).
 * Аудіо надсилається лише одному провайдеру й лише за згодою:
 *   WHISPER_PROVIDER=auto | groq | openai — автоматично, коли субтитрів немає;
 *   off (за замовчуванням) — лише через явний виклик transcribe_audio.
 * До іншого провайдера при збої аудіо не пересилається.
 */
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { downloadAudioForTranscription } from './ytdlp';
import { safeErrorMessage } from '../redact';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const log = createLogger('whisper');

export type WhisperProvider = 'groq' | 'openai';

const PROVIDERS: Record<WhisperProvider, { endpoint: string; model: string; keyEnv: string }> = {
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3',
    keyEnv: 'GROQ_API_KEY',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    keyEnv: 'OPENAI_API_KEY',
  },
};

const CHUNK_SECONDS = 600;

export class WhisperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperError';
  }
}

function hasKey(p: WhisperProvider): boolean {
  return !!process.env[PROVIDERS[p].keyEnv];
}

/**
 * Провайдер для розпізнавання або null.
 * explicit — користувач сам попросив (transcribe_audio): тоді підходить будь-який
 * налаштований ключ, навіть якщо автоматичний режим вимкнено.
 */
export function whisperProvider(opts: { explicit?: boolean; preferred?: WhisperProvider } = {}): WhisperProvider | null {
  const setting = (process.env.WHISPER_PROVIDER || 'off').toLowerCase();
  const wanted = opts.preferred ?? (setting === 'groq' || setting === 'openai' ? setting : null);
  if (wanted) return hasKey(wanted) ? wanted : null;
  if (setting !== 'auto' && !opts.explicit) return null;
  return (['groq', 'openai'] as const).find(hasKey) ?? null;
}

/** Найдовше відео, яке погоджуємось розпізнавати (хвилин) */
function maxMinutes(): number {
  return parseInt(process.env.WHISPER_MAX_MINUTES || '180');
}

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', ukrainian: 'uk', russian: 'ru', polish: 'pl', german: 'de', french: 'fr',
  spanish: 'es', italian: 'it', portuguese: 'pt', czech: 'cs', japanese: 'ja', chinese: 'zh',
};

/** Whisper повертає мову назвою ("english") — зводимо до ISO-коду */
export function normalizeLanguage(lang?: string): string {
  if (!lang) return 'auto';
  const l = lang.trim().toLowerCase();
  return LANGUAGE_CODES[l] || l;
}

export interface WhisperResult {
  text: string;
  segments: Array<{ start: number; dur: number; text: string }>;
  language: string;
  source: string;            // whisper:groq / whisper:openai
}

/** ffmpeg: стиснути й нарізати аудіо на шматки по 10 хв */
async function splitAudio(input: string, outDir: string): Promise<string[]> {
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  try {
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
      path.join(outDir, 'chunk%03d.mp3'),
    ], { timeout: 10 * 60_000 });
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new WhisperError('ffmpeg не знайдено — встанови ffmpeg або вкажи FFMPEG_BIN');
    throw new WhisperError(`ffmpeg: ${safeErrorMessage(e)}`);
  }
  return fs.readdirSync(outDir).filter(f => /^chunk\d{3}\.mp3$/.test(f)).sort().map(f => path.join(outDir, f));
}

async function transcribeChunk(file: string, provider: WhisperProvider, lang?: string): Promise<any> {
  const cfg = PROVIDERS[provider];
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', cfg.model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (lang && /^[a-z]{2}$/.test(lang)) form.append('language', lang);

  try {
    const res = await axios.post(cfg.endpoint, form, {
      headers: { Authorization: `Bearer ${process.env[cfg.keyEnv]}` },
      timeout: 5 * 60_000,
      maxBodyLength: 30 * 1024 * 1024,
    });
    return res.data;
  } catch (e: any) {
    const status = e.response?.status;
    const detail = e.response?.data?.error?.message || e.message;
    throw new WhisperError(`${provider} Whisper${status ? ` HTTP ${status}` : ''}: ${safeErrorMessage(detail)}`);
  }
}

/** Розпізнати аудіо відео. Кидає WhisperError з поясненням. */
export async function transcribeWithWhisper(videoId: string, opts: {
  provider: WhisperProvider;
  lang?: string;
  cookiePath?: string;
}): Promise<WhisperResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytome-whisper-'));
  try {
    const audio = await downloadAudioForTranscription(videoId, dir, {
      cookiePath: opts.cookiePath, maxDurationSec: maxMinutes() * 60,
    });
    const chunksDir = path.join(dir, 'chunks');
    fs.mkdirSync(chunksDir);
    const chunks = await splitAudio(audio, chunksDir);
    if (chunks.length === 0) throw new WhisperError('ffmpeg не створив жодного шматка аудіо');

    log.info({ videoId, provider: opts.provider, chunks: chunks.length }, 'transcribing audio');
    const segments: WhisperResult['segments'] = [];
    let offset = 0;
    let language: string | undefined;
    for (const chunk of chunks) {
      const data = await transcribeChunk(chunk, opts.provider, opts.lang);
      language ??= data.language;
      for (const s of data.segments || []) {
        const text = String(s.text || '').trim();
        if (!text) continue;
        segments.push({ start: offset + s.start, dur: Math.max(0, s.end - s.start), text });
      }
      if (!data.segments?.length && data.text?.trim()) {
        segments.push({ start: offset, dur: data.duration || CHUNK_SECONDS, text: data.text.trim() });
      }
      offset += typeof data.duration === 'number' ? data.duration : CHUNK_SECONDS;
    }
    if (segments.length === 0) throw new WhisperError('Whisper не розпізнав мовлення в аудіо');

    return {
      text: segments.map(s => s.text).join(' '),
      segments,
      language: opts.lang || normalizeLanguage(language),
      source: `whisper:${opts.provider}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
