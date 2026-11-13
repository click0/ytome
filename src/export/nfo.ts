/**
 * Генерація .nfo (Kodi XML) для Jellyfin / Emby / Plex (XBMCnfo agent).
 *
 * Схема: канал = серіал, рік публікації = сезон,
 * епізод = MMDD + 2-значний денний індекс (напр. 15 березня, перше відео → 031501).
 * Номер детермінований: не зсувається, коли пізніше архівується старіше відео.
 */

export interface NfoChannel {
  youtube_id: string;
  name: string;
  description?: string | null;
}

export interface NfoVideo {
  youtube_id: string;
  title: string;
  description?: string | null;
  published_at: string;
  duration_sec?: number | null;
  tags?: string | null;          // JSON-масив з БД
  summary?: string | null;       // AI-підсумок транскрипту (TL;DR, тези, розділи)
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Керуючі символи заборонені в XML 1.0
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Обрізати до maxBytes байтів UTF-8, не розрізаючи символ */
function truncateBytes(s: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * Безпечне ім'я файлу/теки на Windows, Linux, macOS, FreeBSD.
 * Ліміт — у байтах UTF-8 (файлові системи обмежують ім'я 255 байтами, а кирилиця —
 * 2 байти на символ, CJK — 3): з запасом на суфікси на кшталт "-thumb.jpg".
 */
export function sanitizeFilename(s: string, maxBytes = 120): string {
  const clean = (v: string) => v
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');            // Windows не любить крапку/пробіл у кінці
  let cut = clean(truncateBytes(clean(s), maxBytes));
  if (WINDOWS_RESERVED.test(cut)) cut = `_${cut}`;
  return cut || 'untitled';
}

export function seasonOf(publishedAt: string): number {
  return new Date(publishedAt).getUTCFullYear();
}

/** MMDD × 100 + денний індекс (1-based) */
export function episodeOf(publishedAt: string, dayIndex: number): number {
  const d = new Date(publishedAt);
  return ((d.getUTCMonth() + 1) * 100 + d.getUTCDate()) * 100 + dayIndex;
}

export function episodeCode(season: number, episode: number): string {
  return `S${season}E${String(episode).padStart(6, '0')}`;
}

/** Базове ім'я файлу епізоду без розширення */
export function episodeBaseName(channelName: string, video: NfoVideo, dayIndex: number): string {
  const season = seasonOf(video.published_at);
  const code = episodeCode(season, episodeOf(video.published_at, dayIndex));
  // 200 байтів + "-thumb.jpg" / ".nfo" / ".webm" укладаються в 255
  return sanitizeFilename(`${channelName} - ${code} - ${video.title}`, 200);
}

function parseTags(tags?: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function buildShowNfo(channel: NfoChannel): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<tvshow>',
    `  <title>${escapeXml(channel.name)}</title>`,
    channel.description ? `  <plot>${escapeXml(channel.description)}</plot>` : '',
    '  <studio>YouTube</studio>',
    `  <uniqueid type="youtube" default="true">${escapeXml(channel.youtube_id)}</uniqueid>`,
    '</tvshow>',
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}

/** Опис епізоду: AI-підсумок (якщо є) над оригінальним описом */
function episodePlot(video: NfoVideo): string | null {
  const parts = [video.summary, video.description].filter(p => p && p.trim());
  return parts.length ? parts.join('\n\n———\n\n') : null;
}

export function buildEpisodeNfo(channel: NfoChannel, video: NfoVideo, dayIndex: number): string {
  const season = seasonOf(video.published_at);
  const episode = episodeOf(video.published_at, dayIndex);
  const aired = video.published_at.slice(0, 10);
  const runtimeMin = video.duration_sec ? Math.max(1, Math.round(video.duration_sec / 60)) : null;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<episodedetails>',
    `  <title>${escapeXml(video.title)}</title>`,
    `  <showtitle>${escapeXml(channel.name)}</showtitle>`,
    `  <season>${season}</season>`,
    `  <episode>${episode}</episode>`,
    episodePlot(video) ? `  <plot>${escapeXml(episodePlot(video)!)}</plot>` : '',
    `  <aired>${aired}</aired>`,
    `  <premiered>${aired}</premiered>`,
    runtimeMin ? `  <runtime>${runtimeMin}</runtime>` : '',
    '  <studio>YouTube</studio>',
    `  <uniqueid type="youtube" default="true">${escapeXml(video.youtube_id)}</uniqueid>`,
    ...parseTags(video.tags).map(t => `  <tag>${escapeXml(t)}</tag>`),
    '</episodedetails>',
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}
