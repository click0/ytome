/**
 * Балансер AI-запитів
 *
 * Режими (BALANCER_MODE в .env):
 *
 *   priority   — фіксований пріоритет за складністю
 *   cost       — найдешевший провайдер що здатен впоратись  ← за замовч.
 *   roundrobin — рівномірний розподіл між активними провайдерами
 *
 * Fallback завжди активний: якщо обраний провайдер не відповідає →
 * наступний у черзі.
 */

import axios from 'axios';
import { askClaude, claudeAvailable, ClaudeModel } from './claude';
import { askProvider, loadProviderConfigs, ProviderName } from './providers';
import { getDb } from '../db/init';
import { createLogger } from '../logger';

const log = createLogger('ai');

// =============================================
// Типи
// =============================================

export type TaskComplexity = 'simple' | 'medium' | 'complex' | 'critical';
export type BalancerMode   = 'priority' | 'cost' | 'roundrobin';

export interface AIRequest {
  complexity:  TaskComplexity;
  system?:     string;
  prompt:      string;
  maxTokens?:  number;
  json?:       boolean;
  tag?:        string;
}

export interface AIResponse {
  text:        string;
  provider:    string;
  latency_ms?: number;
  cost_usd?:   number;
}

type RouteStep =
  | { type: 'provider'; name: ProviderName }
  | { type: 'claude';   model: ClaudeModel };

// =============================================
// Вартість провайдерів (менше = дешевше)
// Використовується у режимі 'cost'
// =============================================

const COST_RANK: Record<string, number> = {
  'ollama':                           0,  // локально, безкоштовно
  'lmstudio':                         0,  // локально, безкоштовно
  'groq':                             1,  // безкоштовний хмарний tier
  'openrouter':                       2,  // є безкоштовні моделі
  'claude:claude-haiku-4-5-20251001': 3,  // дешевий Claude
  'claude:claude-sonnet-4-6':         4,
  'claude:claude-opus-4-6':           5,
};

/** Мінімальна складність яку провайдер здатен обробляти надійно */
const MIN_COMPLEXITY: Record<string, TaskComplexity> = {
  'ollama':                           'simple',
  'lmstudio':                         'simple',
  'groq':                             'simple',
  'openrouter':                       'simple',
  'claude:claude-haiku-4-5-20251001': 'simple',
  'claude:claude-sonnet-4-6':         'medium',
  'claude:claude-opus-4-6':           'complex',
};

const COMPLEXITY_LEVEL: Record<TaskComplexity, number> = {
  simple: 0, medium: 1, complex: 2, critical: 3,
};

// =============================================
// Утиліти
// =============================================

function stepKey(s: RouteStep): string {
  return s.type === 'claude' ? `claude:${s.model}` : s.name;
}

function stepAvailable(s: RouteStep): boolean {
  if (s.type === 'claude') return claudeAvailable();
  return loadProviderConfigs()[s.name]?.enabled ?? false;
}

function stepCanHandle(s: RouteStep, complexity: TaskComplexity): boolean {
  const minC = MIN_COMPLEXITY[stepKey(s)];
  if (!minC) return true;
  return COMPLEXITY_LEVEL[complexity] >= COMPLEXITY_LEVEL[minC];
}

function allSteps(): RouteStep[] {
  return [
    { type: 'provider', name: 'ollama'     },
    { type: 'provider', name: 'lmstudio'   },
    { type: 'provider', name: 'groq'       },
    { type: 'provider', name: 'openrouter' },
    { type: 'claude',   model: 'claude-haiku-4-5-20251001' },
    { type: 'claude',   model: 'claude-sonnet-4-6'         },
    { type: 'claude',   model: 'claude-opus-4-6'           },
  ];
}

function eligibleSteps(complexity: TaskComplexity): RouteStep[] {
  return allSteps().filter(s => stepAvailable(s) && stepCanHandle(s, complexity));
}

// =============================================
// Режим: priority
// =============================================

const PRIORITY_ROUTES: Record<TaskComplexity, RouteStep[]> = {
  simple: [
    { type: 'provider', name: 'ollama'     },
    { type: 'provider', name: 'lmstudio'   },
    { type: 'provider', name: 'groq'       },
    { type: 'provider', name: 'openrouter' },
    { type: 'claude',   model: 'claude-haiku-4-5-20251001' },
  ],
  medium: [
    { type: 'provider', name: 'groq'       },
    { type: 'provider', name: 'openrouter' },
    { type: 'provider', name: 'ollama'     },
    { type: 'claude',   model: 'claude-haiku-4-5-20251001' },
  ],
  complex: [
    { type: 'claude',   model: 'claude-haiku-4-5-20251001' },
    { type: 'provider', name: 'openrouter' },
    { type: 'provider', name: 'groq'       },
  ],
  critical: [
    { type: 'claude',   model: 'claude-sonnet-4-6'         },
    { type: 'claude',   model: 'claude-haiku-4-5-20251001' },
    { type: 'provider', name: 'openrouter' },
  ],
};

// =============================================
// Режим: cost
// =============================================

function buildCostQueue(complexity: TaskComplexity): RouteStep[] {
  return eligibleSteps(complexity)
    .sort((a, b) => (COST_RANK[stepKey(a)] ?? 99) - (COST_RANK[stepKey(b)] ?? 99));
}

// =============================================
// Режим: round-robin (індекс зберігається в SQLite)
// =============================================

function getRRIndex(): number {
  try {
    const db  = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key='rr_index'").get() as any;
    db.close();
    return parseInt(row?.value ?? '0', 10) || 0;
  } catch { return 0; }
}

function advanceRRIndex(total: number): void {
  try {
    const next = (getRRIndex() + 1) % total;
    const db   = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('rr_index',?)").run(String(next));
    db.close();
  } catch {}
}

function buildRoundRobinQueue(complexity: TaskComplexity): RouteStep[] {
  const eligible = eligibleSteps(complexity);
  if (eligible.length === 0) return [];

  const idx = getRRIndex() % eligible.length;
  advanceRRIndex(eligible.length);

  // Починаємо з поточного індексу, далі по колу — fallback природній
  return [...eligible.slice(idx), ...eligible.slice(0, idx)];
}

// =============================================
// Вибір черги за режимом
// =============================================

// =============================================
// Режим: AI_PROXY_URL — делегування зовнішньому роутеру
// =============================================

/**
 * Якщо AI_PROXY_URL встановлено — всі запити йдуть туди.
 * Сумісні: claude-code-router, olla, OmniRoute, NadirClaw,
 *          будь-який OpenAI-compatible endpoint.
 *
 * Приклади:
 *   http://localhost:3456      (claude-code-router)
 *   http://localhost:40114/olla/openai  (olla)
 *   http://localhost:8402      (OmniRoute / NadirClaw)
 *   http://192.168.1.50:11434  (Ollama на іншому ПК)
 *   https://ai.myserver.com    (зовнішній self-hosted)
 */
function getProxyUrl(): string | null {
  return process.env.AI_PROXY_URL?.trim() || null;
}

/** Модель яку просити у зовнішнього роутера (можна overrideнути) */
function getProxyModel(complexity: TaskComplexity): string {
  return process.env.AI_PROXY_MODEL
    || (complexity === 'critical' ? 'claude-sonnet-4-6'
      : complexity === 'complex'  ? 'claude-haiku-4-5-20251001'
      : 'auto');   // 'auto' — роутер сам вирішує (NadirClaw, claude-code-router)
}

async function askViaProxy(req: AIRequest): Promise<AIResponse> {
  const proxyUrl  = getProxyUrl()!;
  const baseUrl   = proxyUrl.replace(/\/+$/, '');
  const endpoint  = `${baseUrl}/v1/chat/completions`;
  const model     = getProxyModel(req.complexity);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.AI_PROXY_API_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Olla: передаємо complexity як hint у model name якщо model=auto
  // claude-code-router: розуміє контекст задачі сам
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });

  const body: any = { model, messages, max_tokens: req.maxTokens ?? 512 };
  if (req.json) body.response_format = { type: 'json_object' };

  const start = Date.now();
  const resp  = await axios.post(endpoint, body, { headers, timeout: 30_000 });

  const text     = resp.data?.choices?.[0]?.message?.content ?? '';
  const latency  = Date.now() - start;
  const provider = `proxy:${new URL(proxyUrl).hostname}:${model}`;

  logUsage(provider, req.tag ?? 'ai');
  log.info({ provider, latencyMs: latency, tag: req.tag }, 'proxy AI response');

  return { text, provider, latency_ms: latency };
}

export function getMode(): BalancerMode {
  const v = (process.env.BALANCER_MODE || 'cost').toLowerCase();
  return (['priority', 'cost', 'roundrobin'].includes(v) ? v : 'cost') as BalancerMode;
}

function buildQueue(complexity: TaskComplexity): RouteStep[] {
  switch (getMode()) {
    case 'priority':   return PRIORITY_ROUTES[complexity];
    case 'cost':       return buildCostQueue(complexity);
    case 'roundrobin': return buildRoundRobinQueue(complexity);
  }
}

// =============================================
// Логування в БД
// =============================================

function ensureUsageTable() {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        date          TEXT    NOT NULL,
        provider      TEXT    NOT NULL,
        tag           TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        cost_usd      REAL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_log(date);
    `);
    db.close();
  } catch {}
}

function logUsage(provider: string, tag: string, input?: number, output?: number, cost?: number) {
  try {
    ensureUsageTable();
    const db = getDb();
    db.prepare(`
      INSERT INTO ai_usage_log (date, provider, tag, input_tokens, output_tokens, cost_usd)
      VALUES (date('now'), ?, ?, ?, ?, ?)
    `).run(provider, tag || null, input ?? null, output ?? null, cost ?? null);
    db.close();
  } catch {}
}

// =============================================
// Головна функція виклику
// =============================================

export async function ask(req: AIRequest): Promise<AIResponse> {
  // Якщо налаштований зовнішній роутер — делегуємо повністю
  if (getProxyUrl()) {
    try {
      return await askViaProxy(req);
    } catch (e: any) {
      log.warn({ error: e.message, tag: req.tag }, 'proxy failed — falling back to internal balancer');
      // Fallback на внутрішній балансер якщо проксі недоступний
    }
  }

  const queue  = buildQueue(req.complexity);
  const errors: string[] = [];
  const tag    = req.tag ?? 'ai';
  const mode   = getMode();

  if (queue.length === 0) {
    throw new Error(`No available AI providers [complexity=${req.complexity}, mode=${mode}]`);
  }

  for (const step of queue) {
    if (!stepAvailable(step)) continue;

    try {
      if (step.type === 'claude') {
        const start    = Date.now();
        const res      = await askClaude({
          model: step.model, system: req.system,
          prompt: req.prompt, maxTokens: req.maxTokens, json: req.json,
        });
        const provider = `claude:${step.model}`;
        log.info({ provider, latencyMs: Date.now()-start, costUsd: res.cost_usd, mode, tag }, 'claude response');
        logUsage(provider, tag, res.inputTokens, res.outputTokens, res.cost_usd);
        return { text: res.text, provider, cost_usd: res.cost_usd };
      }

      const start    = Date.now();
      const res      = await askProvider({
        provider: step.name, system: req.system,
        prompt: req.prompt, maxTokens: req.maxTokens, json: req.json,
      });
      const provider = `${step.name}:${res.model}`;
      log.info({ provider, latencyMs: res.latency_ms, mode, tag }, 'provider response');
      logUsage(provider, tag, res.inputTokens, res.outputTokens);
      return { text: res.text, provider, latency_ms: res.latency_ms };

    } catch (e: any) {
      errors.push(`${stepKey(step)}: ${e.message}`);
      log.warn({ step: stepKey(step), error: e.message, tag }, 'AI step failed');
    }
  }

  throw new Error(
    `All providers failed [mode=${mode}, complexity=${req.complexity}]\n${errors.join('\n')}`
  );
}

export async function askJSON<T>(req: AIRequest): Promise<T | null> {
  try {
    const res   = await ask({ ...req, json: true });
    const clean = res.text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as T;
  } catch { return null; }
}

// =============================================
// Статус і статистика
// =============================================

export function getRoutingInfo(): { mode: BalancerMode; proxy: { url?: string; model?: string; status: string }; routes: Record<TaskComplexity, string[]> } {
  const mode         = getMode();
  const complexities: TaskComplexity[] = ['simple', 'medium', 'complex', 'critical'];
  const routes       = {} as Record<TaskComplexity, string[]>;

  for (const c of complexities) {
    const queue  = buildCostQueue(c); // завжди cost для відображення
    routes[c]    = queue.map(s => {
      const key  = stepKey(s);
      const rank = COST_RANK[key] ?? 99;
      const cost = ['0-free-local','1-free-cloud','2-paid-cheap','3-haiku','4-sonnet','5-opus'][rank] ?? 'paid';
      return `✅ ${key} [${cost}]`;
    });

    // Додаємо недоступні
    const unavailable = allSteps()
      .filter(s => !stepAvailable(s) && stepCanHandle(s, c))
      .map(s => `⬜ ${stepKey(s)} (disabled)`);
    routes[c].push(...unavailable);
  }

  const proxyUrl = getProxyUrl();
  return {
    mode,
    proxy: proxyUrl
      ? { url: proxyUrl, model: getProxyModel('simple'), status: '✅ active — internal balancer is fallback' }
      : { status: '⬜ not configured — using internal balancer' },
    routes,
  };
}

export function getAIUsageStats(days = 7): Array<{
  date: string; provider: string; tag: string;
  calls: number; total_tokens: number; total_cost_usd: number;
}> {
  try {
    ensureUsageTable();
    const db   = getDb();
    const rows = db.prepare(`
      SELECT date, provider, tag,
        COUNT(*) AS calls,
        SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS total_tokens,
        ROUND(SUM(COALESCE(cost_usd,0)),6) AS total_cost_usd
      FROM ai_usage_log
      WHERE date >= date('now', ?)
      GROUP BY date, provider, tag
      ORDER BY date DESC, total_cost_usd DESC
    `).all(`-${days} days`) as any[];
    db.close();
    return rows;
  } catch { return []; }
}
