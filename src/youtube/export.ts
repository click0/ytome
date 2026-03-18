import fs from 'fs';
import path from 'path';
import { getChannels, getGroups } from '../db/queries';

const STORAGE_PATH = process.env.STORAGE_PATH || './storage';
const EXPORTS_DIR  = path.join(STORAGE_PATH, 'exports');

function ensureExportsDir() {
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// =============================================
// OPML export
// =============================================

/**
 * OPML 2.0 — совместим с:
 * - Feedly, Inoreader, NewsBlur (RSS-ридеры)
 * - Можно импортировать в другой экземпляр youtube-archive
 * - YouTube каналы как RSS: https://www.youtube.com/feeds/videos.xml?channel_id=UC...
 */
export function exportOPML(options: {
  visibility?: 'public' | 'private' | 'all';
  includeGroups?: boolean;
  filename?: string;
}): { path: string; content: string; count: number } {

  const { visibility = 'public', includeGroups = true } = options;

  const channels = getChannels(visibility === 'all' ? undefined : visibility);
  const groups   = includeGroups ? getGroups() : [];

  const now = new Date().toUTCString();

  // Строим карту: channelId → группы
  const channelGroupMap = new Map<number, string[]>();
  // (группы пока без member lookup — упрощённо)

  // Генерируем OPML
  function channelOutline(ch: any): string {
    const rssUrl  = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.youtube_id}`;
    const htmlUrl = ch.handle
      ? `https://www.youtube.com/@${ch.handle.replace('@', '')}`
      : `https://www.youtube.com/channel/${ch.youtube_id}`;

    const escapedName = ch.name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    return [
      `    <outline`,
      `      type="rss"`,
      `      text="${escapedName}"`,
      `      title="${escapedName}"`,
      `      xmlUrl="${rssUrl}"`,
      `      htmlUrl="${htmlUrl}"`,
      `      visibility="${ch.visibility}"`,
      `      youtubeId="${ch.youtube_id}"`,
      ch.handle ? `      handle="${ch.handle}"` : '',
      ch.notes  ? `      notes="${ch.notes.replace(/"/g, '&quot;')}"` : '',
      `    />`,
    ].filter(Boolean).join('\n');
  }

  let body: string;

  if (includeGroups && groups.length > 0) {
    // Группируем публичные каналы по группам
    const groupedChannelIds = new Set<number>();

    const groupBlocks = groups
      .filter(g => visibility === 'all' || g.visibility === visibility)
      .map(g => {
        const members = channels.filter((ch: any) => channelGroupMap.get(ch.id)?.includes(g.name));
        if (members.length === 0) return '';
        members.forEach((ch: any) => groupedChannelIds.add(ch.id));
        return [
          `  <outline text="${g.name}" title="${g.name}">`,
          ...members.map(channelOutline),
          `  </outline>`,
        ].join('\n');
      })
      .filter(Boolean);

    // Каналы не в группах — в корень
    const ungrouped = channels
      .filter((ch: any) => !groupedChannelIds.has(ch.id))
      .map(channelOutline);

    body = [...groupBlocks, ...ungrouped].join('\n');
  } else {
    body = channels.map(channelOutline).join('\n');
  }

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>YouTube Archive — Subscriptions</title>
    <dateCreated>${now}</dateCreated>
    <dateModified>${now}</dateModified>
    <ownerName>youtube-archive</ownerName>
    <docs>http://opml.org/spec2.opml</docs>
  </head>
  <body>
${body}
  </body>
</opml>`;

  ensureExportsDir();
  const filename = options.filename || `subscriptions-${Date.now()}.opml`;
  const outPath  = path.join(EXPORTS_DIR, filename);
  fs.writeFileSync(outPath, content, 'utf-8');

  return { path: outPath, content, count: channels.length };
}

// =============================================
// JSON export
// =============================================

export function exportJSON(options: {
  visibility?: 'public' | 'private' | 'all';
  filename?: string;
}): { path: string; count: number } {

  const { visibility = 'all' } = options;
  const channels = getChannels(visibility === 'all' ? undefined : visibility);
  const groups   = getGroups();

  const payload = {
    exported_at:   new Date().toISOString(),
    version:       '0.2',
    total_channels: channels.length,
    channels: channels.map((ch: any) => ({
      youtube_id:       ch.youtube_id,
      handle:           ch.handle,
      name:             ch.name,
      visibility:       ch.visibility,
      notes:            ch.notes,
      tags:             ch.tags ? JSON.parse(ch.tags) : null,
      subscriber_count: ch.subscriber_count,
      added_at:         ch.added_at,
    })),
    groups: groups.map((g: any) => ({
      id:         g.id,
      name:       g.name,
      visibility: g.visibility,
    })),
  };

  ensureExportsDir();
  const filename = options.filename || `subscriptions-${Date.now()}.json`;
  const outPath  = path.join(EXPORTS_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');

  return { path: outPath, count: channels.length };
}

// =============================================
// Import from OPML (обратная совместимость)
// =============================================

export function parseOPML(content: string): Array<{
  youtube_id: string;
  handle?: string;
  name: string;
  visibility: 'public' | 'private';
  notes?: string;
}> {
  const results: any[] = [];
  const regex = /<outline[^>]+youtubeId="([^"]+)"[^>]*>/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const tag = match[0];

    const get = (attr: string) => {
      const m = new RegExp(`${attr}="([^"]*)"`).exec(tag);
      return m ? m[1] : undefined;
    };

    results.push({
      youtube_id: get('youtubeId')!,
      handle:     get('handle'),
      name:       get('text') || get('title') || 'Unknown',
      visibility: (get('visibility') as any) || 'private',
      notes:      get('notes'),
    });
  }

  return results;
}
