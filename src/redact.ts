/**
 * Прибирає облікові дані з тексту, що йде в чат або в логи:
 *   scheme://user:pass@host → scheme://***@host (URL проксі, командні рядки yt-dlp);
 *   ?key=… / &access_token=… → ?key=*** (ключ YouTube API в URL помилок googleapis).
 * Решта тексту не змінюється.
 */
// Userinfo — до ОСТАННЬОГО "@" перед хостом: пароль може містити "@", лапки тощо
const CREDENTIALS_IN_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@(?=[^\s@/?#]*(?:[/?#\s]|$))/gi;
const SECRET_QUERY_PARAMS = /([?&](?:key|api_key|apikey|access_token|token|client_secret|password)=)[^&#\s"']+/gi;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, '$1***@').replace(SECRET_QUERY_PARAMS, '$1***');
}

/** Повідомлення помилки без облікових даних */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'Unknown error');
  return redactCredentials(msg || 'Unknown error');
}
