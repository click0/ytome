/**
 * Адаптер: провайдери з OpenAI-сумісним API
 * Ollama · Groq · OpenRouter · LM Studio
 */

import axios from 'axios';
import { axiosProxyConfig } from '../proxy/manager';

// =============================================
// Типи провайдерів
// =============================================

export type ProviderName = 'ollama' | 'groq' | 'openrouter' | 'lmstudio';

export interface ProviderConfig {
  name:     ProviderName;
  baseUrl:  string;
  apiKey?:  string;   // не потрібен для Ollama / LM Studio
  model:    string;   // модель за замовчуванням
  enabled:  boolean;
}

export interface ProviderRequest {
  provider: ProviderName;
  model?:   string;       // override дефолтної моделі
  system?:  string;
  prompt:   string;
  maxTokens?: number;
  json?:    boolean;
}

export interface ProviderResponse {
  text:         string;
  provider:     ProviderName;
  model:        string;
  inputTokens?: number;
  outputTokens?: number;
  latency_ms:   number;
}

// =============================================
// Конфіг провайдерів з .env
// =============================================

export function loadProviderConfigs(): Record<ProviderName, ProviderConfig> {
  return {
    ollama: {
      name:    'ollama',
      baseUrl: process.env.OLLAMA_URL    || 'http://localhost:11434',
      model:   process.env.OLLAMA_MODEL  || 'llama3.2:3b',
      enabled: process.env.OLLAMA_ENABLED !== 'false',
    },
    groq: {
      name:    'groq',
      baseUrl: 'https://api.groq.com/openai',
      apiKey:  process.env.GROQ_API_KEY,
      model:   process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      enabled: !!process.env.GROQ_API_KEY,
    },
    openrouter: {
      name:    'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      apiKey:  process.env.OPENROUTER_API_KEY,
      model:   process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
      enabled: !!process.env.OPENROUTER_API_KEY,
    },
    lmstudio: {
      name:    'lmstudio',
      baseUrl: process.env.LMSTUDIO_URL   || 'http://localhost:1234',
      model:   process.env.LMSTUDIO_MODEL || 'local-model',
      enabled: process.env.LMSTUDIO_ENABLED === 'true',
    },
  };
}

// =============================================
// Виклик провайдера
// =============================================

export async function askProvider(req: ProviderRequest): Promise<ProviderResponse> {
  const configs = loadProviderConfigs();
  const config  = configs[req.provider];

  if (!config.enabled) {
    throw new Error(`Provider "${req.provider}" is not enabled. Check .env`);
  }

  const model   = req.model || config.model;
  const start   = Date.now();

  const messages: Array<{role: string; content: string}> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });

  // Ollama має свій endpoint
  const isOllama = req.provider === 'ollama';
  const url      = isOllama
    ? `${config.baseUrl}/api/chat`
    : `${config.baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  // OpenRouter вимагає ці заголовки
  if (req.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/yt-vault';
    headers['X-Title']      = 'yt-vault';
  }

  const body = isOllama
    ? { model, messages, stream: false, options: { num_predict: req.maxTokens ?? 512 } }
    : {
        model,
        messages,
        max_tokens: req.maxTokens ?? 512,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      };

  const resp = await axios.post(url, body, {
    headers,
    timeout: 30_000,
    ...axiosProxyConfig(),
  });

  const latency_ms = Date.now() - start;

  // Витягуємо текст з різних форматів відповіді
  let text: string;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  if (isOllama) {
    text         = resp.data?.message?.content ?? '';
    inputTokens  = resp.data?.prompt_eval_count;
    outputTokens = resp.data?.eval_count;
  } else {
    text         = resp.data?.choices?.[0]?.message?.content ?? '';
    inputTokens  = resp.data?.usage?.prompt_tokens;
    outputTokens = resp.data?.usage?.completion_tokens;
  }

  return { text, provider: req.provider, model, inputTokens, outputTokens, latency_ms };
}

/**
 * Зручна обгортка — повертає розпарсений JSON або null
 */
export async function askProviderJSON<T>(req: ProviderRequest): Promise<T | null> {
  try {
    const res   = await askProvider({ ...req, json: true });
    const clean = res.text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as T;
  } catch (e) {
    console.error(`[${req.provider}] JSON parse error:`, e);
    return null;
  }
}

/**
 * Health check — перевірити чи провайдер відповідає
 */
export async function checkProvider(name: ProviderName): Promise<{
  ok: boolean; latency_ms?: number; error?: string;
}> {
  try {
    const start = Date.now();
    await askProvider({ provider: name, prompt: 'ping', maxTokens: 5 });
    return { ok: true, latency_ms: Date.now() - start };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function checkAllProviders(): Promise<
  Array<{ name: ProviderName; enabled: boolean; ok?: boolean; latency_ms?: number; error?: string }>
> {
  const configs = loadProviderConfigs();
  return Promise.all(
    (Object.keys(configs) as ProviderName[]).map(async name => {
      const cfg = configs[name];
      if (!cfg.enabled) return { name, enabled: false };
      const result = await checkProvider(name);
      return { name, enabled: true, ...result };
    })
  );
}
