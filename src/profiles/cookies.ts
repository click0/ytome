/**
 * Робота з cookies.txt (Netscape format)
 *
 * Формат: domain \t include_subdomains \t path \t secure \t expires \t name \t value
 * Експортується браузерними розширеннями або yt-dlp --cookies-from-browser
 */
import fs from 'fs';
import { createLogger } from '../logger';

const log = createLogger('cookies');

export interface ParsedCookie {
  domain: string;
  path: string;
  secure: boolean;
  expires: number;   // unix timestamp, 0 = session cookie
  name: string;
  value: string;
}

/** Розпарсити cookies.txt у список cookie */
export function parseCookiesFile(filePath: string): ParsedCookie[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const cookies: ParsedCookie[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    cookies.push({
      domain:  parts[0],
      path:    parts[2],
      secure:  parts[3].toUpperCase() === 'TRUE',
      expires: parseInt(parts[4]) || 0,
      name:    parts[5],
      value:   parts[6],
    });
  }

  return cookies;
}

/**
 * Зібрати Cookie-заголовок для домену (youtube.com за замовчуванням).
 * Прострочені cookie відкидаються.
 */
export function buildCookieHeader(filePath: string, domain = 'youtube.com'): string {
  const now = Math.floor(Date.now() / 1000);
  const cookies = parseCookiesFile(filePath).filter(c => {
    const domainMatch = c.domain === domain
      || c.domain === `.${domain}`
      || c.domain.endsWith(`.${domain}`);
    const notExpired = c.expires === 0 || c.expires > now;
    return domainMatch && notExpired;
  });

  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/** Перевірити що файл існує і схожий на Netscape cookies.txt */
export function validateCookiesFile(filePath: string): { valid: boolean; error?: string; cookieCount?: number } {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: `File not found: ${filePath}` };
  }
  try {
    const cookies = parseCookiesFile(filePath);
    if (cookies.length === 0) {
      return { valid: false, error: 'No cookies found — is this a Netscape-format cookies.txt?' };
    }
    const ytCookies = cookies.filter(c => c.domain.includes('youtube.com') || c.domain.includes('google.com'));
    if (ytCookies.length === 0) {
      return { valid: false, error: 'No youtube.com/google.com cookies in file', cookieCount: cookies.length };
    }
    return { valid: true, cookieCount: cookies.length };
  } catch (e: any) {
    log.warn({ filePath, error: e.message }, 'cookie file validation failed');
    return { valid: false, error: e.message };
  }
}
