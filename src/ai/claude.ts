/**
 * Адаптер: Anthropic Claude API
 * Використовується для складних задач оцінки контенту.
 */

import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export type ClaudeModel =
  | 'claude-haiku-4-5-20251001'   // дешевий, швидкий
  | 'claude-sonnet-4-6'           // баланс
  | 'claude-opus-4-6';            // найсильніший

export interface ClaudeRequest {
  model:       ClaudeModel;
  system?:     string;
  prompt:      string;
  maxTokens?:  number;
  json?:       boolean;   // очікувати JSON-відповідь
}

export interface ClaudeResponse {
  text:           string;
  inputTokens:    number;
  outputTokens:   number;
  model:          ClaudeModel;
  cost_usd:       number;   // приблизна вартість
}

// Ціни за 1M токенів (вхід / вихід), USD
const PRICING: Record<ClaudeModel, [number, number]> = {
  'claude-haiku-4-5-20251001': [0.80,  4.00],
  'claude-sonnet-4-6':         [3.00, 15.00],
  'claude-opus-4-6':           [15.0, 75.00],
};

function calcCost(model: ClaudeModel, input: number, output: number): number {
  const [inPrice, outPrice] = PRICING[model];
  return (input * inPrice + output * outPrice) / 1_000_000;
}

export async function askClaude(req: ClaudeRequest): Promise<ClaudeResponse> {
  const client    = getClient();
  const model     = req.model;
  const maxTokens = req.maxTokens ?? 512;

  const systemPrompt = req.json
    ? (req.system ?? '') + '\nRespond ONLY with valid JSON. No markdown, no explanation.'
    : req.system;

  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: req.prompt }],
  });

  const text         = msg.content.map(b => (b as any).text ?? '').join('');
  const inputTokens  = msg.usage.input_tokens;
  const outputTokens = msg.usage.output_tokens;

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
    console.error('[claude] JSON parse error:', e);
    return null;
  }
}

export function claudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
