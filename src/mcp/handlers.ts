import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logger';
import { validateArgs } from './validation';

const log = createLogger('mcp');

import {
  getChannels, addChannel, getChannel, getNewVideos,
  getUnseenVideos, markAsSeen, getTranscript, saveTranscript,
  hasTranscript, createGroup, addChannelToGroup, getGroups,
} from '../db/queries';
import {
  addToWatchLater, getWatchLater, updateWatchLaterStatus,
  updateWatchLaterPriority, updateWatchLaterNote, getWatchLaterStats,
  saveComments, getCachedComments, hasComments,
} from '../db/queries-v2';
import { getChannelInfo, fetchTranscript, getChannelVideos } from '../youtube/api';
import { fetchTopComments, fetchChannelOwnerComments } from '../youtube/comments';
import { checkChannel, checkAllChannels } from '../scheduler/index';
import { exportOPML, exportJSON, parseOPML } from '../youtube/export';
import { addProxy, removeProxy, setProxyEnabled, listProxies, getProxyMode, setProxyMode, checkAllProxies, checkProxyHealth } from '../proxy/manager';
import { evaluateVideo, evaluateBatch } from '../evaluation/index';
import { getVideoCacheStatus, getBatchCacheStatus, getTranscriptCached, getCommentsCached, getThumbnailCached, getMediaCached, getVideoMeta } from '../cache/resolver';
import { getRoutingInfo, getAIUsageStats, getMode } from '../ai/balancer';
import { checkAllProviders } from '../ai/providers';
import { downloadVideo, downloadSubtitles, srtToText, checkYtDlp } from '../youtube/ytdlp';
import { addFilterRule, removeFilterRule, setFilterEnabled, listFilterRules, clearFilterRules } from '../filters/index';
import { getQuotaStatus, getQuotaHistory, getQuotaBreakdown, QUOTA_COSTS } from '../db/quota';


// =============================================
// Определение инструментов (Tools)
// =============================================

export const TOOLS: Tool[] = [
  // ----------- Подписки -----------
  {
    name: 'subscribe',
    description: 'Добавить канал YouTube в архив (подписаться)',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '@handle или channel ID (UCxxx)' },
        visibility: { type: 'string', enum: ['private', 'public'], default: 'private' },
        notes: { type: 'string', description: 'Личные заметки о канале' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'list_subscriptions',
    description: 'Показать список подписок (все, приватные или публичные)',
    inputSchema: {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['all', 'private', 'public'], default: 'all' },
      },
    },
  },
  {
    name: 'unsubscribe',
    description: 'Удалить канал из подписок',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '@handle или channel ID' },
      },
      required: ['channel'],
    },
  },

  // ----------- Видео и фид -----------
  {
    name: 'get_feed',
    description: 'Показать новые видео и Shorts из подписок за период',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO дата или "1d", "1w", "1m"' },
        type: { type: 'string', enum: ['all', 'video', 'short'], default: 'all' },
        visibility: { type: 'string', enum: ['all', 'private', 'public'], default: 'all' },
        unseen_only: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'mark_seen',
    description: 'Отметить видео как просмотренное',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'YouTube video ID (dQw4w9WgXcQ)' },
      },
      required: ['video_id'],
    },
  },

  // ----------- Транскрипции -----------
  {
    name: 'get_transcript',
    description: 'Получить транскрипцию видео (из кеша или загрузить)',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'YouTube video ID или URL' },
        force_refresh: { type: 'boolean', default: false },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'analyze_transcript',
    description: 'Загрузить и проанализировать транскрипцию видео',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string' },
        task: {
          type: 'string',
          description: 'Что сделать: "summary" | "key_points" | "quotes" | "full"',
          default: 'summary',
        },
      },
      required: ['video_id'],
    },
  },


  // ----------- Watch Later (TODO) -----------
  {
    name: 'watch_later_add',
    description: 'Добавить видео в список посмотреть позже',
    inputSchema: {
      type: 'object',
      properties: {
        video_id:  { type: 'string', description: 'YouTube video ID или URL' },
        priority:  { type: 'string', enum: ['high', 'medium', 'low'] },
        remind_at: { type: 'string', description: 'ISO дата напоминания' },
        note:      { type: 'string', description: 'Зачем сохранил' },
        tags:      { type: 'array', items: { type: 'string' } },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'watch_later_list',
    description: 'Показать список посмотреть позже',
    inputSchema: {
      type: 'object',
      properties: {
        status:   { type: 'string', enum: ['pending', 'done', 'skipped', 'all'] },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        tag:      { type: 'string' },
        overdue:  { type: 'boolean' },
      },
    },
  },
  {
    name: 'watch_later_update',
    description: 'Обновить статус, приоритет или заметку в Watch Later',
    inputSchema: {
      type: 'object',
      properties: {
        id:       { type: 'number' },
        status:   { type: 'string', enum: ['done', 'skipped', 'pending'] },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        note:     { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'watch_later_stats',
    description: 'Статистика Watch Later',
    inputSchema: { type: 'object', properties: {} },
  },

  // ----------- Комментарии -----------
  {
    name: 'get_comments',
    description: 'Получить топ комментарии видео (из кеша или загрузить с YouTube)',
    inputSchema: {
      type: 'object',
      properties: {
        video_id:      { type: 'string' },
        limit:         { type: 'number' },
        owner_only:    { type: 'boolean' },
        with_replies:  { type: 'boolean' },
        force_refresh: { type: 'boolean' },
      },
      required: ['video_id'],
    },
  },

  // ----------- Синхронизация -----------
  {
    name: 'sync',
    description: 'Принудительно проверить новые видео (один канал или все)',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'channel ID или @handle. Пусто = все каналы' },
      },
    },
  },

  // ----------- Группы -----------
  {
    name: 'create_group',
    description: 'Создать группу каналов',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'public'], default: 'private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'export_opml',
    description: 'Экспорт подписок в OPML файл (совместим с RSS-ридерами и другими экземплярами)',
    inputSchema: {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['public', 'private', 'all'], default: 'public' },
        include_groups: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'export_json',
    description: 'Экспорт подписок в JSON файл',
    inputSchema: {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['public', 'private', 'all'], default: 'all' },
      },
    },
  },
  {
    name: 'import_opml',
    description: 'Импорт подписок из OPML файла',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Путь к .opml файлу' },
        default_visibility: { type: 'string', enum: ['private', 'public'], default: 'private' },
      },
      required: ['file_path'],
    },
  },

  // ----------- AI Балансер -----------
  {
    name: 'cache_status',
    description: 'Перевірити що є локально для відео: транскрипція, коментарі, thumbnail, аудіо/відео. fully_offline=true означає що запити в мережу не потрібні',
    inputSchema: {
      type: 'object',
      properties: {
        video_id:  { type: 'string', description: 'YouTube video ID або масив через кому' },
        video_ids: { type: 'array', items: { type: 'string' }, description: 'Масив video ID для batch перевірки' },
      },
    },
  },

  {
    name: 'ai_usage',
    description: 'Статистика використання AI-провайдерів та витрати за період',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7, description: 'За скільки днів показати статистику' },
      },
    },
  },

  {
    name: 'ai_set_mode',
    description: 'Змінити режим балансера: priority | cost | roundrobin',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['priority', 'cost', 'roundrobin'] },
      },
      required: ['mode'],
    },
  },

  {
    name: 'ai_status',
    description: 'Показати стан AI-провайдерів та маршрутизацію по складності задач',
    inputSchema: { type: 'object', properties: { check_health: { type: 'boolean', description: 'Виконати health check кожного провайдера (повільніше)' } } },
  },

  // ----------- Оцінка відео -----------
  {
    name: 'evaluate_video',
    description: 'Оцінити відео для додавання в архів / knowledge base. Скор 0–100 по свіжості, якості, релевантності (AI stub). Повертає рекомендацію 🟢/🟡/🔴/⛔',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'YouTube video ID' },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'evaluate_batch',
    description: 'Оцінити кілька відео одночасно, результат відсортований по скору',
    inputSchema: {
      type: 'object',
      properties: {
        video_ids: { type: 'array', items: { type: 'string' }, description: 'Масив YouTube video ID' },
      },
      required: ['video_ids'],
    },
  },

  // ----------- Завантаження -----------
  {
    name: 'download',
    description: 'Завантажити відео або аудіо через yt-dlp (з підтримкою проксі)',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'YouTube video ID або URL' },
        format:   { type: 'string', enum: ['audio', 'video', 'video_hd'], default: 'audio' },
        subtitles:{ type: 'boolean', default: false },
        lang:     { type: 'string', default: 'en', description: 'Мова субтитрів' },
      },
      required: ['video_id'],
    },
  },

  // ----------- Проксі -----------
  {
    name: 'proxy_add',
    description: 'Додати проксі-сервер. URL формат: http://user:pass@host:port або socks5://host:port',
    inputSchema: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Повний URL проксі' },
        label:   { type: 'string', description: 'Назва для зручності' },
        enabled: { type: 'boolean', default: true },
      },
      required: ['url'],
    },
  },
  {
    name: 'proxy_list',
    description: 'Показати список проксі-серверів та їх стан',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'proxy_remove',
    description: 'Видалити проксі-сервер за ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'proxy_test',
    description: 'Перевірити доступність всіх проксі (health check)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'proxy_set_mode',
    description: 'Встановити режим проксі: disabled / single / rotation / fallback',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['disabled', 'single', 'rotation', 'fallback'] },
      },
      required: ['mode'],
    },
  },

  // ----------- Фільтри (white/blacklist) -----------
  {
    name: 'filter_add',
    description: 'Додати правило white або blacklist',
    inputSchema: {
      type: 'object',
      properties: {
        type:  { type: 'string', enum: ['whitelist', 'blacklist'] },
        scope: { type: 'string', enum: ['channel', 'description'],
                 description: 'channel=ID або @handle каналу, description=ключове слово в описі відео' },
        value: { type: 'string', description: 'Значення: channel ID, @handle, або ключове слово' },
        case_sensitive: { type: 'boolean', default: false },
        note:  { type: 'string' },
      },
      required: ['type', 'scope', 'value'],
    },
  },
  {
    name: 'filter_list',
    description: 'Показати всі правила фільтрації',
    inputSchema: {
      type: 'object',
      properties: {
        type:  { type: 'string', enum: ['whitelist', 'blacklist'] },
        scope: { type: 'string', enum: ['channel', 'description'] },
      },
    },
  },
  {
    name: 'filter_remove',
    description: 'Видалити правило фільтрації за ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'filter_clear',
    description: 'Очистити всі правила (або тільки whitelist/blacklist)',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['whitelist', 'blacklist'] },
      },
    },
  },

  {
    name: 'quota_status',
    description: 'Перевірити використання безкоштовної квоти YouTube API (10 000 одиниць/день)',
    inputSchema: {
      type: 'object',
      properties: {
        history_days: { type: 'number', description: 'Показати історію за N днів (за замовчуванням 7)' },
        breakdown:    { type: 'boolean', description: 'Розбивка по операціях за сьогодні' },
      },
    },
  },

  {
    name: 'list_groups',
    description: 'Показать список групп каналов',
    inputSchema: { type: 'object', properties: {} },
  },
];

// =============================================
// Хелперы
// =============================================

function parseSince(since?: string): string {
  if (!since) return new Date(Date.now() - 7 * 86400000).toISOString();
  if (since === '1d') return new Date(Date.now() - 86400000).toISOString();
  if (since === '1w') return new Date(Date.now() - 7 * 86400000).toISOString();
  if (since === '1m') return new Date(Date.now() - 30 * 86400000).toISOString();
  return new Date(since).toISOString();
}

function extractVideoId(input: string): string {
  // Извлечь video ID из URL или вернуть как есть
  const urlMatch = input.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return urlMatch ? urlMatch[1] : input;
}

function buildBar(percent: number): string {
  const filled = Math.round(percent / 5);
  const empty  = 20 - filled;
  const color  = percent >= 95 ? '🔴' : percent >= 80 ? '🟡' : '🟢';
  return `${color} [${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

function ok(data: any) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: `❌ Error: ${message}` }],
    isError: true,
  };
}

// =============================================
// Обработчики инструментов
// =============================================

export async function handleTool(name: string, rawArgs: any): Promise<any> {
  // Валідація вхідних даних через Zod
  let args: any;
  try {
    args = validateArgs(name, rawArgs || {});
  } catch (e: any) {
    log.warn({ tool: name, error: e.message }, 'validation failed');
    return err(e.message);
  }

  log.info({ tool: name }, 'handling tool call');

  switch (name) {

    case 'subscribe': {
      const info = await getChannelInfo(args.channel);
      if (!info) return err(`Channel not found: ${args.channel}`);
      const id = addChannel(info, args.visibility || 'private', args.notes);
      return ok({ success: true, channel: info.name, db_id: id, visibility: args.visibility || 'private' });
    }

    case 'list_subscriptions': {
      const vis = args.visibility === 'all' ? undefined : args.visibility;
      const channels = getChannels(vis);
      return ok({
        total: channels.length,
        channels: channels.map(c => ({
          id: c.youtube_id,
          name: c.name,
          handle: c.handle,
          visibility: c.visibility,
          last_checked: c.last_checked_at,
          notes: c.notes,
        })),
      });
    }

    case 'get_feed': {
      const since = parseSince(args.since);
      const type = args.type === 'all' ? undefined : args.type;
      let videos = getNewVideos(since, type);

      if (args.visibility && args.visibility !== 'all') {
        videos = videos.filter((v: any) => v.channel_visibility === args.visibility);
      }
      if (args.unseen_only) {
        videos = videos.filter((v: any) => !v.is_seen);
      }

      return ok({
        since,
        total: videos.length,
        videos: videos.map((v: any) => ({
          id: v.youtube_id,
          title: v.title,
          channel: v.channel_name,
          type: v.type,
          published_at: v.published_at,
          duration_sec: v.duration_sec,
          views: v.view_count,
          seen: !!v.is_seen,
          url: `https://youtube.com/watch?v=${v.youtube_id}`,
          has_transcript: hasTranscript(v.youtube_id),
        })),
      });
    }

    case 'mark_seen': {
      markAsSeen(args.video_id);
      return ok({ success: true, video_id: args.video_id });
    }

    case 'get_transcript': {
      const vid = extractVideoId(args.video_id);

      // 1. Перевіряємо локальний кеш
      if (!args.force_refresh) {
        const cached = getTranscriptCached(vid, args.language);
        if (cached.data) {
          return ok({
            source:   '📦 local_cache',
            language: cached.data.language,
            text:     cached.data.text,
            segments: JSON.parse(cached.data.segments as any || '[]'),
            cached_source: cached.data.source,
          });
        }
      }

      // 2. Кешу немає або force_refresh — лізем в мережу (оригінальна логіка нижче)
      // fall through to original case
      /* ORIGINAL_GET_TRANSCRIPT_START */
      const videoId = extractVideoId(args.video_id);

      // Проверяем кеш
      if (!args.force_refresh) {
        const cached = getTranscript(videoId);
        if (cached) {
          return ok({
            video_id: videoId,
            source: 'cache',
            language: cached.language,
            text: cached.text,
            fetched_at: cached.fetched_at,
          });
        }
      }

      // Загружаем
      const result = await fetchTranscript(videoId);
      if (!result) return err(`No transcript available for ${videoId}`);

      // Сохраняем в кеш (если видео есть в БД)
      const db = require('../db/init').getDb();
      let video: any;
      try {
        video = db.prepare('SELECT id FROM videos WHERE youtube_id = ?').get(videoId);
      } finally {
        db.close();
      }
      if (video) {
        saveTranscript(video.id, result.text, result.segments, result.language);
      }

      return ok({
        video_id: videoId,
        source: 'youtube',
        language: result.language,
        text: result.text,
      });
    }

    case 'analyze_transcript': {
      const videoId = extractVideoId(args.video_id);
      const cached = getTranscript(videoId);
      let text: string;

      if (cached) {
        text = cached.text;
      } else {
        const result = await fetchTranscript(videoId);
        if (!result) return err(`No transcript available for ${videoId}`);
        text = result.text;
      }

      // Возвращаем текст — Claude сам анализирует согласно task
      return ok({
        video_id: videoId,
        task: args.task || 'summary',
        transcript_length: text.length,
        transcript: text,
        instruction: `Please ${args.task || 'summarize'} the above transcript.`,
      });
    }


    case 'watch_later_add': {
      const videoId = extractVideoId(args.video_id);
      const result = addToWatchLater(videoId, {
        priority: args.priority,
        remindAt: args.remind_at,
        note:     args.note,
        tags:     args.tags,
      });
      if (!result) return err(`Video not found in archive: ${videoId}. Sync first.`);
      return ok({ success: true, watch_later_id: result.id });
    }

    case 'watch_later_list': {
      const items = getWatchLater({
        status:   args.status || 'pending',
        priority: args.priority,
        tag:      args.tag,
        overdue:  args.overdue,
      });
      return ok({
        total: items.length,
        items: items.map(i => ({
          id:         i.id,
          video_id:   i.youtube_id,
          title:      i.title,
          channel:    i.channel_name,
          priority:   i.priority,
          remind_at:  i.remind_at,
          note:       i.note,
          tags:       i.tags,
          status:     i.status,
          added_at:   i.added_at,
          url:        i.url,
          duration_sec: i.duration_sec,
        })),
      });
    }

    case 'watch_later_update': {
      if (args.status)   updateWatchLaterStatus(args.id, args.status);
      if (args.priority) updateWatchLaterPriority(args.id, args.priority);
      if (args.note !== undefined) updateWatchLaterNote(args.id, args.note);
      return ok({ success: true, id: args.id });
    }

    case 'watch_later_stats': {
      return ok(getWatchLaterStats());
    }

    case 'get_comments': {
      const vid = extractVideoId(args.video_id);

      // 1. Перевіряємо локальний кеш (якщо немає force_refresh)
      if (!args.force_refresh) {
        const cached = getCommentsCached(vid, {
          limit:     args.limit,
          ownerOnly: args.owner_only,
        });
        if (cached.data && cached.data.count > 0) {
          return ok({
            source:     '📦 local_cache',
            stale:      cached.stale,
            total:      cached.data.count,
            cached_at:  cached.data.cached_at,
            comments:   cached.data.comments,
          });
        }
      }

      // 2. Кешу немає або force_refresh — лізем в мережу
      /* ORIGINAL_GET_COMMENTS_START */
      const videoId = extractVideoId(args.video_id);
      const limit       = args.limit        || 20;
      const ownerOnly   = args.owner_only   || false;
      const withReplies = args.with_replies !== false;

      // Проверяем кеш
      if (!args.force_refresh && hasComments(videoId)) {
        const cached = getCachedComments(videoId, { limit, ownerOnly, withReplies });
        return ok({
          video_id: videoId,
          source: 'cache',
          total: cached.length,
          comments: cached.map(c => ({
            id:           c.youtube_comment_id,
            author:       c.author_name,
            owner:        c.is_channel_owner,
            text:         c.text,
            likes:        c.like_count,
            reply_count:  c.reply_count,
            published_at: c.published_at,
            replies:      (c.replies || []).map(r => ({
              author: r.author_name,
              owner:  r.is_channel_owner,
              text:   r.text,
              likes:  r.like_count,
            })),
          })),
        });
      }

      // Загружаем с YouTube
      const fetched = ownerOnly
        ? await fetchChannelOwnerComments(videoId, '')
        : await fetchTopComments(videoId, limit, withReplies);

      if (!fetched.length) return err(`No comments available for ${videoId}`);

      // Flatten для сохранения в БД
      const allComments: any[] = [];
      for (const c of fetched) {
        allComments.push(c);
        if (c.replies) allComments.push(...c.replies);
      }
      saveComments(videoId, allComments);

      return ok({
        video_id: videoId,
        source: 'youtube',
        total: fetched.length,
        comments: fetched.map(c => ({
          id:           c.youtube_comment_id,
          author:       c.author_name,
          owner:        c.is_channel_owner,
          text:         c.text,
          likes:        c.like_count,
          reply_count:  c.reply_count,
          published_at: c.published_at,
          replies:      (c.replies || []).map(r => ({
            author: r.author_name,
            owner:  r.is_channel_owner,
            text:   r.text,
            likes:  r.like_count,
          })),
        })),
      });
    }

    case 'export_opml': {
      const result = exportOPML({
        visibility: args.visibility || 'public',
        includeGroups: args.include_groups !== false,
      });
      return ok({ success: true, path: result.path, channels_exported: result.count });
    }

    case 'export_json': {
      const result = exportJSON({ visibility: args.visibility || 'all' });
      return ok({ success: true, path: result.path, channels_exported: result.count });
    }

    case 'import_opml': {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.resolve(args.file_path);
      if (!resolved.endsWith('.opml') && !resolved.endsWith('.xml')) {
        return err('Only .opml and .xml files are allowed');
      }
      if (!fs.existsSync(resolved)) return err(`File not found: ${resolved}`);
      const content = fs.readFileSync(resolved, 'utf-8');
      const channels = parseOPML(content);
      let imported = 0;
      for (const ch of channels) {
        try {
          const info = await getChannelInfo(ch.youtube_id);
          if (info) { addChannel(info, ch.visibility || args.default_visibility || 'private', ch.notes); imported++; }
        } catch {}
      }
      return ok({ success: true, found: channels.length, imported });
    }

    case 'cache_status': {
      if (args.video_ids?.length) {
        const ids = (args.video_ids as string[]).map(extractVideoId);
        return ok(getBatchCacheStatus(ids));
      }
      const vid = extractVideoId(args.video_id);
      const status = getVideoCacheStatus(vid);
      return ok({
        ...status,
        summary: status.fully_offline
          ? '✅ Повністю офлайн — мережа не потрібна'
          : `⚠ Потрібна мережа для: ${['transcript','comments'].filter(f => {
              if (f === 'transcript') return !status.has_transcript;
              if (f === 'comments')  return !status.has_comments;
              return false;
            }).join(', ') || 'оновлення застарілих даних'}`,
      });
    }

    case 'ai_usage': {
      const stats = getAIUsageStats(args.days || 7);
      const totalCost = stats.reduce((s, r) => s + r.total_cost_usd, 0);
      return ok({ total_cost_usd: +totalCost.toFixed(6), stats });
    }

    case 'ai_set_mode': {
      process.env.BALANCER_MODE = args.mode;
      return ok({ success: true, mode: args.mode, note: 'Зміна діє до рестарту. Для постійної зміни — оновіть BALANCER_MODE в .env' });
    }

    case 'ai_status': {
      const routing = getRoutingInfo();
      const mode = getMode();
      if (args.check_health) {
        const health = await checkAllProviders();
        return ok({ mode, routing, health });
      }
      return ok({ mode, routing });
    }

    case 'evaluate_video': {
      const db2 = require('../db/init').getDb();
      let video: any;
      try {
        video = db2.prepare('SELECT * FROM videos WHERE youtube_id = ?').get(extractVideoId(args.video_id));
      } finally {
        db2.close();
      }
      if (!video) return err(`Video ${args.video_id} not found in archive. Run sync first.`);
      const result = await evaluateVideo({
        youtube_id:    video.youtube_id,
        title:         video.title,
        description:   video.description,
        published_at:  video.published_at,
        duration_sec:  video.duration_sec,
        view_count:    video.view_count,
        like_count:    video.like_count,
        comment_count: video.comment_count,
        has_captions:  !!video.thumbnail_path,
        caption_type:  'auto',
        tags:          video.tags ? JSON.parse(video.tags) : [],
        contains_synthetic_media: !!video.contains_synthetic_media,
      });
      return ok(result);
    }

    case 'evaluate_batch': {
      const db3 = require('../db/init').getDb();
      let rows: any[];
      try {
        const ids = (args.video_ids as string[]).map(extractVideoId);
        rows = ids.map((id: string) => db3.prepare('SELECT * FROM videos WHERE youtube_id = ?').get(id)).filter(Boolean) as any[];
      } finally {
        db3.close();
      }
      if (rows.length === 0) return err('No matching videos found in archive');
      const inputs = rows.map((v: any) => ({
        youtube_id: v.youtube_id, title: v.title, description: v.description,
        published_at: v.published_at, duration_sec: v.duration_sec,
        view_count: v.view_count, like_count: v.like_count,
        has_captions: true, caption_type: 'auto' as const,
        tags: v.tags ? JSON.parse(v.tags) : [],
      }));
      const results = await evaluateBatch(inputs);
      return ok({ total: results.length, results });
    }

    case 'download': {
      const videoId = extractVideoId(args.video_id);
      const result  = await downloadVideo(videoId, {
        format:    args.format || 'audio',
        subtitles: args.subtitles,
        lang:      args.lang,
      });
      // Зберігаємо шлях в БД якщо відео є в архіві
      const dbInst = require('../db/init').getDb();
      try {
        const vid = dbInst.prepare('SELECT id FROM videos WHERE youtube_id = ?').get(videoId) as any;
        if (vid) {
          if (result.format === 'audio') {
            dbInst.prepare('UPDATE videos SET audio_path = ? WHERE id = ?').run(result.filePath, vid.id);
          } else {
            dbInst.prepare('UPDATE videos SET video_path = ?, is_archived = 1 WHERE id = ?').run(result.filePath, vid.id);
          }
        }
      } finally {
        dbInst.close();
      }
      return ok({
        success:   true,
        video_id:  videoId,
        format:    result.format,
        file_path: result.filePath,
        file_size: `${(result.fileSize / 1024 / 1024).toFixed(1)} MB`,
      });
    }

    case 'proxy_add': {
      const p = addProxy({ url: args.url, label: args.label, enabled: args.enabled });
      return ok({ success: true, proxy: { id: p.id, url: p.url, label: p.label, protocol: p.protocol } });
    }

    case 'proxy_list': {
      const mode    = getProxyMode();
      const proxies = listProxies();
      return ok({
        mode,
        total: proxies.length,
        proxies: proxies.map(p => ({
          id:        p.id,
          label:     p.label,
          protocol:  p.protocol,
          host:      p.host,
          port:      p.port,
          enabled:   p.enabled,
          healthy:   p.healthy,
          fail_count: p.fail_count,
          last_used: p.last_used_at,
          last_check: p.last_check_at,
          last_error: p.last_error,
        })),
      });
    }

    case 'proxy_remove': {
      removeProxy(args.id);
      return ok({ success: true });
    }

    case 'proxy_test': {
      const results = await checkAllProxies();
      return ok({
        total:   results.length,
        healthy: results.filter(r => r.ok).length,
        results: results.map(r => ({
          id:        r.id,
          label:     r.label,
          url:       r.url,
          status:    r.ok ? '✅ ok' : '❌ fail',
          latency:   r.latencyMs ? `${r.latencyMs}ms` : undefined,
          error:     r.error,
        })),
      });
    }

    case 'proxy_set_mode': {
      setProxyMode(args.mode);
      return ok({ success: true, mode: args.mode });
    }

    case 'filter_add': {
      const rule = addFilterRule({
        type:          args.type,
        scope:         args.scope,
        value:         args.value,
        caseSensitive: args.case_sensitive,
        note:          args.note,
      });
      return ok({ success: true, rule });
    }

    case 'filter_list': {
      const rules = listFilterRules({ type: args.type, scope: args.scope });
      const whitelist = rules.filter(r => r.type === 'whitelist');
      const blacklist = rules.filter(r => r.type === 'blacklist');
      return ok({
        total: rules.length,
        whitelist: whitelist.length,
        blacklist: blacklist.length,
        rules,
      });
    }

    case 'filter_remove': {
      removeFilterRule(args.id);
      return ok({ success: true });
    }

    case 'filter_clear': {
      clearFilterRules(args.type);
      return ok({ success: true, cleared: args.type || 'all' });
    }

    case 'quota_status': {
      const status    = getQuotaStatus();
      const history   = getQuotaHistory(args.history_days || 7);
      const breakdown = args.breakdown ? getQuotaBreakdown() : undefined;

      const bar = buildBar(status.percent);

      return ok({
        today: {
          date:      status.date,
          used:      status.used,
          remaining: status.remaining,
          limit:     status.limit,
          percent:   `${status.percent}%`,
          bar,
          status:    status.critical ? '🔴 критично' : status.warning ? '🟡 увага' : '🟢 норма',
        },
        costs_reference: QUOTA_COSTS,
        history,
        ...(breakdown ? { breakdown_today: breakdown } : {}),
      });
    }

    case 'sync': {
      if (args.channel) {
        const channel = getChannel(args.channel) || getChannels().find(
          (c: any) => c.handle === args.channel || c.youtube_id === args.channel
        );
        if (!channel) return err(`Channel not found: ${args.channel}`);
        const count = await checkChannel(channel);
        return ok({ success: true, channel: channel.name, new_videos: count });
      } else {
        await checkAllChannels();
        return ok({ success: true, message: 'All channels checked' });
      }
    }

    case 'create_group': {
      const id = createGroup(args.name, args.visibility || 'private');
      return ok({ success: true, group_id: id, name: args.name });
    }

    case 'list_groups': {
      return ok({ groups: getGroups() });
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}

// =============================================
// MCP Server
// =============================================
