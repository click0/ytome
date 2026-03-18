import { ask, askJSON } from '../ai/balancer';

/**
 * Модуль оцінки відео для архіву / knowledge base
 *
 * AI-логіка замінена заглушками (stub).
 * ТЗ готується окремо — кожен метод позначений TODO.
 */

// =============================================
// Типи
// =============================================

export type RecommendationLevel = 'high' | 'medium' | 'low' | 'skip';

export type VolatilityClass =
  | 'high'    // React, AI/ML, AWS — швидко застарівають
  | 'medium'  // Python, JS загалом
  | 'low';    // алгоритми, математика, фізика

export interface VideoEvalInput {
  youtube_id:    string;
  title:         string;
  description?:  string;
  published_at:  string;    // ISO
  duration_sec?: number;
  view_count?:   number;
  like_count?:   number;
  comment_count?: number;
  has_captions:  boolean;
  caption_type?: 'manual' | 'auto' | 'none';
  tags?:         string[];
  category_id?:  string;
}

export interface EvalScore {
  total:        number;   // 0–100
  freshness:    number;   // 0–30
  quality:      number;   // 0–30
  relevance:    number;   // 0–20  ← AI stub
  tech_currency: number;  // 0–20  ← AI stub
}

export interface EvalResult {
  video_id:      string;
  recommendation: RecommendationLevel;
  score:         EvalScore;
  label:         string;   // 🟢 / 🟡 / 🔴 / ⛔
  reasons:       string[]; // пояснення
  warnings:      string[]; // попередження
  volatility:    VolatilityClass;
  age_days:      number;
  evaluated_at:  string;

  // AI-поля — заглушки поки що
  ai_summary?:       string;  // TODO: короткий AI-опис
  ai_topics?:        string[]; // TODO: ключові теми
  ai_audience?:      string;  // TODO: цільова аудиторія
  ai_quality_notes?: string;  // TODO: нотатки по якості
}

// =============================================
// Константи та конфіги
// =============================================

/** Теми з високою волатильністю (швидко застарівають) */
const HIGH_VOLATILITY_KEYWORDS = [
  'react', 'next.js', 'nextjs', 'vue', 'angular', 'svelte',
  'aws', 'azure', 'gcp', 'kubernetes', 'docker',
  'gpt', 'chatgpt', 'llm', 'claude', 'gemini', 'openai',
  'langchain', 'rag', 'stable diffusion', 'midjourney',
  'typescript', 'tailwind', 'vite',
];

const MEDIUM_VOLATILITY_KEYWORDS = [
  'python', 'javascript', 'nodejs', 'fastapi', 'django',
  'rust', 'golang', 'java', 'kotlin', 'swift',
  'postgresql', 'mongodb', 'redis',
  'machine learning', 'deep learning', 'neural',
];

/** Індикатори свіжості у назві/описі */
const FRESHNESS_SIGNALS = [
  '2025', '2026', 'latest', 'new', 'updated', 'v2', 'v3',
  'оновлений', 'новий', 'свіжий',
];

/** Індикатори якості контенту */
const QUALITY_SIGNALS_POSITIVE = [
  'tutorial', 'course', 'guide', 'explained', 'deep dive',
  'complete', 'full', 'advanced', 'beginner',
  'урок', 'курс', 'посібник', 'пояснення',
];

const QUALITY_SIGNALS_NEGATIVE = [
  'shorts', '#shorts', 'reaction', 'meme', 'funny',
  'clickbait', 'subscribe', 'гайд за 1 хвилину',
];

// =============================================
// Детерміновані scorer-и (без AI)
// =============================================

/** Підрахунок віку відео в днях */
function calcAgeDays(publishedAt: string): number {
  const ms = Date.now() - new Date(publishedAt).getTime();
  return Math.floor(ms / 86_400_000);
}

/** Визначення класу волатильності теми */
function detectVolatility(input: VideoEvalInput): VolatilityClass {
  const text = [input.title, input.description, ...(input.tags || [])]
    .join(' ').toLowerCase();

  if (HIGH_VOLATILITY_KEYWORDS.some(kw => text.includes(kw)))   return 'high';
  if (MEDIUM_VOLATILITY_KEYWORDS.some(kw => text.includes(kw))) return 'medium';
  return 'low';
}

/**
 * Скор свіжості (0–30)
 *
 * Враховує вік + волатильність теми.
 * Для high-volatile тем старий контент штрафується сильніше.
 */
function scoreFreshness(ageDays: number, volatility: VolatilityClass): number {
  const thresholds: Record<VolatilityClass, [number, number]> = {
    high:   [30,  180],   // [ідеальний вік, критичний вік] в днях
    medium: [90,  730],
    low:    [365, 3650],
  };

  const [ideal, critical] = thresholds[volatility];
  if (ageDays <= ideal)    return 30;
  if (ageDays >= critical) return 0;

  const ratio = (ageDays - ideal) / (critical - ideal);
  return Math.round(30 * (1 - ratio));
}

/**
 * Скор якості (0–30)
 *
 * Детермінований: перегляди, лайки, субтитри, сигнали в назві.
 */
function scoreQuality(input: VideoEvalInput): number {
  let score = 0;
  const text = [input.title, input.description || ''].join(' ').toLowerCase();

  // Перегляди (0–10)
  if (input.view_count) {
    if (input.view_count >= 100_000) score += 10;
    else if (input.view_count >= 10_000) score += 6;
    else if (input.view_count >= 1_000)  score += 3;
  }

  // Engagement ratio (0–8)
  if (input.view_count && input.like_count) {
    const ratio = input.like_count / input.view_count;
    if (ratio >= 0.05) score += 8;
    else if (ratio >= 0.02) score += 5;
    else if (ratio >= 0.01) score += 2;
  }

  // Субтитри (0–6)
  if (input.caption_type === 'manual') score += 6;
  else if (input.caption_type === 'auto') score += 3;

  // Позитивні сигнали в назві (0–4)
  if (QUALITY_SIGNALS_POSITIVE.some(s => text.includes(s))) score += 4;

  // Негативні сигнали (штраф)
  if (QUALITY_SIGNALS_NEGATIVE.some(s => text.includes(s))) score -= 6;

  // Тривалість (0–2): занадто короткі відео (<2хв) — штраф
  if (input.duration_sec && input.duration_sec < 120) score -= 4;

  return Math.max(0, Math.min(30, score));
}

// =============================================
// AI STUBS — буде замінено за ТЗ
// =============================================

/**
 * TODO: AI-скор релевантності (0–20)
 *
 * Має враховувати:
 * - відповідність темі архіву / інтересам користувача
 * - семантичну схожість з існуючим контентом в архіві
 * - ключові слова з персонального профілю
 *
 * @stub повертає заглушку 10/20
 */
async function scoreRelevanceAI(input: VideoEvalInput): Promise<number> {
  // TODO: розширити за ТЗ (embeddings, user profile, archive similarity)
  const result = await askJSON<{ score: number; reason: string }>({
    complexity: 'simple',
    tag: 'relevance',
    system: 'You are a video relevance scorer. Return ONLY JSON: {"score": 0-20, "reason": "..."}',
    prompt: `Rate relevance (0-20) of this YouTube video for a tech/education archive:
Title: ${input.title}
Description: ${(input.description || '').slice(0, 300)}`,
    maxTokens: 80,
  });
  return result?.score ?? 10;
}

/**
 * TODO: AI-скор технічної актуальності (0–20)
 *
 * Має враховувати:
 * - чи згадуються актуальні версії інструментів
 * - чи контент відповідає поточному стану технології
 * - порівняння з датами виходу major версій (React 19, Python 3.12, etc.)
 *
 * @stub детермінований fallback на основі сигналів у тексті
 */
async function scoreTechCurrencyAI(input: VideoEvalInput): Promise<number> {
  // TODO: розширити за ТЗ (порівняння з датами релізів фреймворків)
  // Проста задача — використовуємо дешевий провайдер
  const text = [input.title, input.description || ''].join(' ').toLowerCase();
  const hits  = FRESHNESS_SIGNALS.filter(s => text.includes(s)).length;
  const baseScore = Math.min(20, hits * 5);

  // AI уточнює якщо базовий скор неоднозначний
  if (baseScore > 0 && baseScore < 15) {
    const result = await askJSON<{ score: number }>({
      complexity: 'simple',
      tag: 'tech_currency',
      system: 'You score tech currency of YouTube video content. Return ONLY JSON: {"score": 0-20}',
      prompt: `Score tech currency (0-20). Is this content current for ${new Date().getFullYear()}?
Title: ${input.title}
Published: ${input.published_at}`,
      maxTokens: 40,
    });
    return result?.score ?? baseScore;
  }
  return baseScore;
}

/**
 * TODO: AI-генерація опису відео (string)
 *
 * Короткий summary для архіву без перегляду відео.
 * Вхід: title + description + transcript (якщо є)
 *
 * @stub повертає null поки не реалізовано
 */
async function generateAISummary(input: VideoEvalInput): Promise<string | undefined> {
  // TODO: підключити транскрипцію якщо є в кеші
  const result = await ask({
    complexity: 'medium',
    tag: 'summary',
    system: 'Summarize this YouTube video in 2 sentences based on title and description. Be concise.',
    prompt: `Title: ${input.title}
Description: ${(input.description || '').slice(0, 500)}`,
    maxTokens: 120,
  });
  return result.text.trim() || undefined;
}

/**
 * TODO: AI-витяг тем відео (string[])
 *
 * Список тегів/тем що відрізняється від YouTube-тегів.
 * Семантичне розуміння, а не просто keywords.
 *
 * @stub повертає YouTube-теги як є
 */
async function extractAITopics(input: VideoEvalInput): Promise<string[] | undefined> {
  // TODO: семантичні теми, не просто теги
  const result = await askJSON<{ topics: string[] }>({
    complexity: 'simple',
    tag: 'topics',
    system: 'Extract main topics from YouTube video. Return ONLY JSON: {"topics": ["topic1", "topic2", ...]} (max 5 items)',
    prompt: `Title: ${input.title}
Tags: ${(input.tags || []).join(', ')}
Description: ${(input.description || '').slice(0, 200)}`,
    maxTokens: 80,
  });
  return result?.topics ?? input.tags?.slice(0, 5);
}

/**
 * TODO: AI-визначення цільової аудиторії (string)
 *
 * Наприклад: "beginner Python developers", "senior backend engineers"
 *
 * @stub повертає null
 */
async function detectAIAudience(input: VideoEvalInput): Promise<string | undefined> {
  const result = await askJSON<{ audience: string }>({
    complexity: 'simple',
    tag: 'audience',
    system: 'Identify target audience of YouTube video. Return ONLY JSON: {"audience": "short description"}',
    prompt: `Title: ${input.title}
Description: ${(input.description || '').slice(0, 200)}`,
    maxTokens: 60,
  });
  return result?.audience;
}

// =============================================
// Головна функція оцінки
// =============================================

export async function evaluateVideo(input: VideoEvalInput): Promise<EvalResult> {
  const ageDays    = calcAgeDays(input.published_at);
  const volatility = detectVolatility(input);

  // Детерміновані скори
  const freshness = scoreFreshness(ageDays, volatility);
  const quality   = scoreQuality(input);

  // AI стаби
  const relevance    = await scoreRelevanceAI(input);
  const techCurrency = await scoreTechCurrencyAI(input);

  const total: number = freshness + quality + relevance + techCurrency;

  // Рекомендація
  let recommendation: RecommendationLevel;
  let label: string;

  if (total >= 75)      { recommendation = 'high';   label = '🟢 РЕКОМЕНДОВАНО'; }
  else if (total >= 50) { recommendation = 'medium'; label = '🟡 МОЖНА ДОДАТИ'; }
  else if (total >= 25) { recommendation = 'low';    label = '🔴 СЛАБКИЙ КОНТЕНТ'; }
  else                  { recommendation = 'skip';   label = '⛔ ПРОПУСТИТИ'; }

  // Пояснення
  const reasons:  string[] = [];
  const warnings: string[] = [];

  if (freshness >= 25) reasons.push(`Свіжий контент (${ageDays} днів)`);
  if (freshness <= 5)  warnings.push(`Старий контент для ${volatility}-volatile теми (${ageDays} днів)`);
  if (quality >= 20)   reasons.push('Висока якість (перегляди, лайки, субтитри)');
  if (quality <= 8)    warnings.push('Низькі показники якості');
  if (input.caption_type === 'manual') reasons.push('Ручні субтитри — краща транскрипція');
  if (!input.has_captions)            warnings.push('Немає субтитрів');

  // AI-поля (stubs)
  const [aiSummary, aiTopics, aiAudience] = await Promise.all([
    generateAISummary(input),
    extractAITopics(input),
    detectAIAudience(input),
  ]);

  return {
    video_id:       input.youtube_id,
    recommendation,
    score: { total, freshness, quality, relevance, tech_currency: techCurrency },
    label,
    reasons,
    warnings,
    volatility,
    age_days:       ageDays,
    evaluated_at:   new Date().toISOString(),
    ai_summary:     aiSummary,
    ai_topics:      aiTopics,
    ai_audience:    aiAudience,
  };
}

/**
 * Пакетна оцінка кількох відео з сортуванням по скору
 */
export async function evaluateBatch(
  inputs: VideoEvalInput[]
): Promise<EvalResult[]> {
  const results = await Promise.all(inputs.map(evaluateVideo));
  return results.sort((a, b) => b.score.total - a.score.total);
}
