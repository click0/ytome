/**
 * Чому не вдалося отримати транскрипт — з людським поясненням і підказкою.
 *
 * youtube-transcript-plus кидає загальне «No transcripts are available» і тоді,
 * коли субтитрів справді немає, і тоді, коли YouTube заблокував IP
 * («Sign in to confirm you're not a bot»). Розрізняємо за відповіддю плеєра
 * та HTTP-статусами, які бачать наші fetch-хуки.
 */

export type TranscriptFailureReason =
  | 'blocked'          // YouTube відхиляє запити з цієї IP-адреси (бот-перевірка, 403, 429)
  | 'login_required'   // вік, приватне відео, лише для спонсорів
  | 'unavailable'      // видалене, недоступне в регіоні, стрім ще не почався
  | 'no_captions'      // відео доступне, але субтитрів немає
  | 'language'         // субтитри є, але не потрібною мовою
  | 'error';           // мережа чи інше

export class TranscriptUnavailableError extends Error {
  constructor(
    public readonly videoId: string,
    public readonly reason: TranscriptFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptUnavailableError';
  }
}

/** Що побачили fetch-хуки під час спроби */
export interface TranscriptDiagnostics {
  videoPageStatus?: number;
  recaptcha?: boolean;
  playerStatus?: number;
  playability?: { status?: string; reason?: string };
  transcriptStatus?: number;
}

const HINT_BLOCKED =
  'Допоможе профіль з cookies.txt Google-акаунта (profile_add, profile_set_default) ' +
  'або проксі з «домашньою» IP (proxy_add, proxy_set_mode).';

export function classifyTranscriptFailure(
  videoId: string,
  err: unknown,
  diag: TranscriptDiagnostics,
): TranscriptUnavailableError {
  const e = err as { name?: string; message?: string };
  const status = diag.playability?.status;
  const playReason = diag.playability?.reason || '';
  const make = (reason: TranscriptFailureReason, msg: string) =>
    new TranscriptUnavailableError(videoId, reason, `${videoId}: ${msg}`);

  const httpBlocked = [diag.videoPageStatus, diag.playerStatus, diag.transcriptStatus]
    .some(s => s === 403 || s === 429);

  if ((status === 'LOGIN_REQUIRED' && /\bbot\b/i.test(playReason))
      || diag.recaptcha || httpBlocked || e.name === 'YoutubeTranscriptTooManyRequestError') {
    return make('blocked',
      `YouTube відхиляє запити з цієї IP-адреси (${playReason || 'HTTP 403/429 або капча'}). ` + HINT_BLOCKED);
  }
  if (status === 'LOGIN_REQUIRED') {
    return make('login_required',
      `відео доступне лише після входу (${playReason || 'вікове обмеження чи приватне'}). ` +
      'Потрібен профіль з cookies.txt акаунта, який має доступ (profile_add).');
  }
  if (status && status !== 'OK') {
    return make('unavailable', `відео недоступне: ${playReason || status}`);
  }
  if (e.name === 'YoutubeTranscriptNotAvailableLanguageError') {
    return make('language', e.message || 'немає субтитрів потрібною мовою');
  }
  if (e.name === 'YoutubeTranscriptDisabledError' || status === 'OK') {
    return make('no_captions', 'у відео немає субтитрів (ні ручних, ні автоматичних)');
  }
  return make('error', e.message || 'невідома помилка');
}
