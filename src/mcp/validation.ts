/**
 * Zod-схеми валідації вхідних даних для MCP-інструментів.
 *
 * Кожен інструмент має свою схему. handleTool() парсить args
 * через відповідну схему перед виконанням бізнес-логіки.
 */

import { z } from 'zod';

// =============================================
// Helpers
// =============================================

const videoIdOrUrl = z.string().min(1, 'video_id is required');
const channelIdOrHandle = z.string().min(1, 'channel is required');
const visibility = z.enum(['private', 'public']).default('private');
const visibilityFilter = z.enum(['all', 'private', 'public']).default('all');

// =============================================
// Підписки
// =============================================

export const subscribeSchema = z.object({
  channel:    channelIdOrHandle,
  visibility: visibility.optional(),
  notes:      z.string().optional(),
});

export const listSubscriptionsSchema = z.object({
  visibility: visibilityFilter.optional(),
});

export const unsubscribeSchema = z.object({
  channel: channelIdOrHandle,
});

// =============================================
// Фід
// =============================================

export const getFeedSchema = z.object({
  since:       z.string().optional(),
  type:        z.enum(['all', 'video', 'short']).default('all').optional(),
  visibility:  visibilityFilter.optional(),
  unseen_only: z.boolean().default(false).optional(),
});

export const markSeenSchema = z.object({
  video_id: z.string().min(1, 'video_id is required'),
});

// =============================================
// Транскрипції
// =============================================

export const getTranscriptSchema = z.object({
  video_id:      videoIdOrUrl,
  language:      z.string().optional(),
  force_refresh: z.boolean().default(false).optional(),
});

export const analyzeTranscriptSchema = z.object({
  video_id: videoIdOrUrl,
  task:     z.enum(['summary', 'key_points', 'quotes', 'full']).default('summary').optional(),
});

// =============================================
// Watch Later
// =============================================

export const watchLaterAddSchema = z.object({
  video_id:  videoIdOrUrl,
  priority:  z.enum(['high', 'medium', 'low']).optional(),
  remind_at: z.string().optional(),
  note:      z.string().optional(),
  tags:      z.array(z.string()).optional(),
});

export const watchLaterListSchema = z.object({
  status:   z.enum(['pending', 'done', 'skipped', 'all']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  tag:      z.string().optional(),
  overdue:  z.boolean().optional(),
});

export const watchLaterUpdateSchema = z.object({
  id:       z.number().int().positive('id must be a positive integer'),
  status:   z.enum(['done', 'skipped', 'pending']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  note:     z.string().optional(),
});

export const watchLaterStatsSchema = z.object({});

// =============================================
// Коментарі
// =============================================

export const getCommentsSchema = z.object({
  video_id:      videoIdOrUrl,
  limit:         z.number().int().min(1).max(100).optional(),
  owner_only:    z.boolean().optional(),
  with_replies:  z.boolean().optional(),
  force_refresh: z.boolean().optional(),
});

// =============================================
// Синхронізація
// =============================================

export const syncSchema = z.object({
  channel: z.string().optional(),
});

// =============================================
// Групи
// =============================================

export const createGroupSchema = z.object({
  name:       z.string().min(1, 'name is required'),
  visibility: visibility.optional(),
});

export const listGroupsSchema = z.object({});

// =============================================
// Експорт / Імпорт
// =============================================

export const exportOpmlSchema = z.object({
  visibility:     z.enum(['public', 'private', 'all']).default('public').optional(),
  include_groups: z.boolean().default(true).optional(),
});

export const exportJsonSchema = z.object({
  visibility: z.enum(['public', 'private', 'all']).default('all').optional(),
});

export const importOpmlSchema = z.object({
  file_path:          z.string().min(1, 'file_path is required'),
  default_visibility: z.enum(['private', 'public']).default('private').optional(),
});

// =============================================
// Кеш
// =============================================

export const cacheStatusSchema = z.object({
  video_id:  z.string().optional(),
  video_ids: z.array(z.string()).optional(),
});

// =============================================
// AI
// =============================================

export const aiUsageSchema = z.object({
  days: z.number().int().min(1).max(365).default(7).optional(),
});

export const aiSetModeSchema = z.object({
  mode: z.enum(['priority', 'cost', 'roundrobin']),
});

export const aiStatusSchema = z.object({
  check_health: z.boolean().optional(),
});

// =============================================
// Оцінка
// =============================================

export const evaluateVideoSchema = z.object({
  video_id: z.string().min(1, 'video_id is required'),
});

export const evaluateBatchSchema = z.object({
  video_ids: z.array(z.string().min(1)).min(1, 'video_ids must contain at least 1 ID'),
});

// =============================================
// Завантаження
// =============================================

export const downloadSchema = z.object({
  video_id:  videoIdOrUrl,
  format:    z.enum(['audio', 'video', 'video_hd']).optional().default('audio'),
  subtitles: z.boolean().optional().default(false),
  lang:      z.string().optional().default('en'),
});

// =============================================
// Проксі
// =============================================

export const proxyAddSchema = z.object({
  url:     z.string().url('Invalid proxy URL'),
  label:   z.string().optional(),
  enabled: z.boolean().default(true).optional(),
});

export const proxyListSchema = z.object({});
export const proxyRemoveSchema = z.object({
  id: z.number().int().positive('id must be a positive integer'),
});
export const proxyTestSchema = z.object({});

export const proxySetModeSchema = z.object({
  mode: z.enum(['disabled', 'single', 'rotation', 'fallback']),
});

// =============================================
// Фільтри
// =============================================

export const filterAddSchema = z.object({
  type:           z.enum(['whitelist', 'blacklist']),
  scope:          z.enum(['channel', 'description']),
  value:          z.string().min(1, 'value is required'),
  case_sensitive: z.boolean().default(false).optional(),
  note:           z.string().optional(),
});

export const filterListSchema = z.object({
  type:  z.enum(['whitelist', 'blacklist']).optional(),
  scope: z.enum(['channel', 'description']).optional(),
});

export const filterRemoveSchema = z.object({
  id: z.number().int().positive('id must be a positive integer'),
});

export const filterClearSchema = z.object({
  type: z.enum(['whitelist', 'blacklist']).optional(),
});

// =============================================
// Квота
// =============================================

export const quotaStatusSchema = z.object({
  history_days: z.number().int().min(1).max(365).optional(),
  breakdown:    z.boolean().optional(),
});

// =============================================
// Маппінг: tool name → schema
// =============================================

export const SCHEMAS: Record<string, z.ZodType> = {
  subscribe:          subscribeSchema,
  list_subscriptions: listSubscriptionsSchema,
  unsubscribe:        unsubscribeSchema,
  get_feed:           getFeedSchema,
  mark_seen:          markSeenSchema,
  get_transcript:     getTranscriptSchema,
  analyze_transcript: analyzeTranscriptSchema,
  watch_later_add:    watchLaterAddSchema,
  watch_later_list:   watchLaterListSchema,
  watch_later_update: watchLaterUpdateSchema,
  watch_later_stats:  watchLaterStatsSchema,
  get_comments:       getCommentsSchema,
  sync:               syncSchema,
  create_group:       createGroupSchema,
  list_groups:        listGroupsSchema,
  export_opml:        exportOpmlSchema,
  export_json:        exportJsonSchema,
  import_opml:        importOpmlSchema,
  cache_status:       cacheStatusSchema,
  ai_usage:           aiUsageSchema,
  ai_set_mode:        aiSetModeSchema,
  ai_status:          aiStatusSchema,
  evaluate_video:     evaluateVideoSchema,
  evaluate_batch:     evaluateBatchSchema,
  download:           downloadSchema,
  proxy_add:          proxyAddSchema,
  proxy_list:         proxyListSchema,
  proxy_remove:       proxyRemoveSchema,
  proxy_test:         proxyTestSchema,
  proxy_set_mode:     proxySetModeSchema,
  filter_add:         filterAddSchema,
  filter_list:        filterListSchema,
  filter_remove:      filterRemoveSchema,
  filter_clear:       filterClearSchema,
  quota_status:       quotaStatusSchema,
};

/**
 * Валідувати аргументи інструменту.
 * Повертає розпарсені дані або кидає помилку.
 */
export function validateArgs(toolName: string, args: unknown): any {
  const schema = SCHEMAS[toolName];
  if (!schema) return args; // невідомий інструмент — пропускаємо

  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Validation error: ${issues}`);
  }
  return result.data;
}
