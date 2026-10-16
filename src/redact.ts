/**
 * Прибирає облікові дані з тексту, що йде в чат або в логи:
 * scheme://user:pass@host → scheme://***@host (URL проксі, командні рядки yt-dlp,
 * повідомлення про помилки). Решта тексту не змінюється.
 */
const CREDENTIALS_IN_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+(?::[^\s/@'"]*)?@/gi;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, '$1***@');
}

/** Повідомлення помилки без облікових даних */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'Unknown error');
  return redactCredentials(msg || 'Unknown error');
}
