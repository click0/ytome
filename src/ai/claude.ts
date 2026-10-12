/**
 * Адаптер: Anthropic Claude API
 *
 * Три рівні моделей (змінюються через .env):
 *   fast     — CLAUDE_MODEL_FAST,     за замовчуванням Claude Haiku 5.5  (прості задачі)
 *   balanced — CLAUDE_MODEL_BALANCED, за замовчуванням Claude Sonnet 5.5 (середні)
 *   top      — CLAUDE_MODEL_TOP,      за замовчуванням Claude Opus 5.5   (складні / критичні)
 *
 * Поточні моделі думають завжди (adaptive thinking), глибину задає effort.
 * Відмова моделі (stop_reason "refusal") — помилка, тож балансувальник
 * перейде до наступного провайдера; для Opus / Sonnet / Fable додатково
 * ввімкнено серверний fallback Anthropic (fallbacks: "default").
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger';

const log = createLogger('ai');

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export type ClaudeTier = 'fast' | 'balanced' | 'top';
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Будь-який ID моделі Claude: поточні — у MODEL_INFO, інші передаються як є */
export type ClaudeModel = string;

interface ModelInfo {
  input: number;          // $ за 1M вхідних токенів
  output: number;         // $ за 1M вихідних (включно з thinking)
  effort: boolean;        // підтримує output_config.effort
  fallbacks: boolean;     // підтримує серверний fallback "default"
}

/** Поточні моделі (ціни Anthropic API, жовтень 2026) */
export const MODEL_INFO: Record<string, ModelInfo> = {
  'claude-haiku-5-5':  { input: 0.10, output: 0.50, effort: true, fallbacks: false },
  'claude-sonnet-5-5': { input: 2.00, output: 10.0, effort: true, fallbacks: true },
  'claude-opus-5-5':   { input: 4.00, output: 20.0, effort: true, fallbacks: true },
  'claude-fable-5-1':  { input: 10.0, output: 50.0, effort: true, fallbacks: true },
};

const DEFAULT_MODELS: Record<ClaudeTier, string> = {
  fast:     'claude-haiku-5-5',
  balanced: 'claude-sonnet-5-5',
  top:      'claude-opus-5-5',
};

const TIER_ENV: Record<ClaudeTier, string> = {
  fast: 'CLAUDE_MODEL_FAST', balanced: 'CLAUDE_MODEL_BALANCED', top: 'CLAUDE_MODEL_TOP',
};

/** Модель рівня: з .env або поточна за замовчуванням */
export function claudeModel(tier: ClaudeTier): string {
  return process.env[TIER_ENV[tier]]?.trim() || DEFAULT_MODELS[tier];
}

export interface ClaudeRequest {
  model:       ClaudeModel;
  system?:     string;
  prompt:      string;
  maxTokens?:  number;      // ліміт самої відповіді (без роздумів)
  json?:       boolean;     // очікувати JSON-відповідь
  schema?:     Record<string, unknown>;  // JSON Schema → structured outputs (гарантований формат)
  effort?:     ClaudeEffort;
}

export interface ClaudeResponse {
  text:           string;
  inputTokens:    number;
  outputTokens:   number;
  model:          ClaudeModel;   // хто відповів (після серверного fallback може відрізнятись)
  cost_usd:       number;        // приблизна вартість
}

/**
 * Поточні моделі думають перед відповіддю, і роздуми входять у max_tokens.
 * Запас, щоб коротка відповідь (JSON на 500 токенів) не обрізалась роздумами.
 */
const THINKING_HEADROOM = 8000;

export function calcCost(model: ClaudeModel, input: number, output: number): number {
  const info = MODEL_INFO[model];
  if (!info) return 0;
  return (input * info.input + output * info.output) / 1_000_000;
}

export async function askClaude(req: ClaudeRequest): Promise<ClaudeResponse> {
  const client = getClient();
  const info = MODEL_INFO[req.model];

  const system = req.json && !req.schema
    ? (req.system ?? '') + '\nRespond ONLY with valid JSON. No markdown, no explanation.'
    : req.system;

  const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
  if (info?.effort && req.effort) outputConfig.effort = req.effort;
  if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };

  const msg = await client.beta.messages.create({
    model: req.model,
    max_tokens: (req.maxTokens ?? 512) + (info ? THINKING_HEADROOM : 0),
    ...(system ? { system } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    // Серверний fallback: відмову класифікатора безпеки перехоплює інша модель
    ...(info?.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    messages: [{ role: 'user', content: req.prompt }],
  });

  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${msg.stop_details?.category ?? 'refusal'})`);
  }

  // Лише текст: thinking- і fallback-блоки пропускаємо
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  if (msg.stop_reason === 'max_tokens' && !text.trim()) {
    throw new Error('Claude hit max_tokens before answering');
  }

  const inputTokens  = msg.usage.input_tokens;
  const outputTokens = msg.usage.output_tokens;
  const model        = msg.model || req.model;

  return {
    text,
    inputTokens,
    outputTokens,
    model,
    cost_usd: calcCost(model, inputTokens, outputTokens),
  };
}

/**
 * Зручна обгортка — повертає розпарсений JSON або null
 */
export async function askClaudeJSON<T>(req: Omit<ClaudeRequest, 'json'>): Promise<T | null> {
  try {
    const res  = await askClaude({ ...req, json: true });
    const clean = res.text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as T;
  } catch (e) {
    log.warn({ provider: 'claude', error: (e as Error).message }, 'JSON parse error');
    return null;
  }
}

export function claudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Перевірка моделей без витрат: Models API (ключ дійсний, модель доступна).
 */
export async function checkClaudeModels(): Promise<Array<{
  tier: ClaudeTier; model: string; ok: boolean; error?: string;
}>> {
  if (!claudeAvailable()) return [];
  const client = getClient();
  return Promise.all((Object.keys(DEFAULT_MODELS) as ClaudeTier[]).map(async tier => {
    const model = claudeModel(tier);
    try {
      await client.models.retrieve(model);
      return { tier, model, ok: true };
    } catch (e: any) {
      return { tier, model, ok: false, error: e.message };
    }
  }));
}
