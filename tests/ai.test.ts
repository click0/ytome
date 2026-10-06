/**
 * AI: OpenAI-сумісні провайдери, адаптер Claude і балансувальник
 * (режими cost / priority / roundrobin, fallback, зовнішній роутер, облік).
 * HTTP і Anthropic SDK підмінено, БД справжня (журнал використання, індекс RR).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const net = vi.hoisted(() => ({ post: vi.fn(), create: vi.fn(), sdkOpts: [] as any[] }));

vi.mock('axios', () => ({ default: { post: net.post, get: vi.fn() } }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: net.create };
    constructor(opts: any) { net.sdkOpts.push(opts); }
  },
}));

const { tmp } = useTempStorage('ai');

let providers: typeof import('../src/ai/providers');
let claude: typeof import('../src/ai/claude');
let balancer: typeof import('../src/ai/balancer');
let init: Awaited<ReturnType<typeof initTestDb>>;

const ENV_KEYS = ['OLLAMA_ENABLED', 'LMSTUDIO_ENABLED', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY', 'BALANCER_MODE', 'AI_PROXY_URL', 'AI_PROXY_MODEL', 'AI_PROXY_API_KEY', 'OLLAMA_URL'];

/** Лише вказані провайдери увімкнені */
function enable(...names: Array<'ollama' | 'lmstudio' | 'groq' | 'openrouter' | 'claude'>) {
  process.env.OLLAMA_ENABLED = names.includes('ollama') ? 'true' : 'false';
  process.env.LMSTUDIO_ENABLED = names.includes('lmstudio') ? 'true' : 'false';
  if (names.includes('groq')) process.env.GROQ_API_KEY = 'gsk';
  if (names.includes('openrouter')) process.env.OPENROUTER_API_KEY = 'ork';
  if (names.includes('claude')) process.env.ANTHROPIC_API_KEY = 'sk-ant';
}

const openaiReply = (content: string) => ({ data: { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4 } } });
const claudeReply = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } });
/** Хто відповідав: URL-и HTTP-провайдерів і моделі Claude у порядку викликів */
const tried = () => [
  ...net.post.mock.calls.map(([url]) => url as string),
  ...net.create.mock.calls.map(([req]) => `claude:${req.model}`),
];

beforeAll(async () => {
  init = await initTestDb();
  providers = await import('../src/ai/providers');
  claude = await import('../src/ai/claude');
  balancer = await import('../src/ai/balancer');
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  net.post.mockReset();
  net.create.mockReset();
});

describe('providers', () => {
  it('config comes from env; Ollama is on unless disabled, LM Studio is opt-in', () => {
    const c = providers.loadProviderConfigs();
    expect(c.ollama).toMatchObject({ enabled: true, baseUrl: 'http://localhost:11434', model: 'llama3.2:3b' });
    expect(c.lmstudio.enabled).toBe(false);
    expect(c.groq.enabled).toBe(false);
    enable('groq', 'lmstudio');
    expect(providers.loadProviderConfigs().groq).toMatchObject({ enabled: true, apiKey: 'gsk' });
    expect(providers.loadProviderConfigs().lmstudio.enabled).toBe(true);
  });

  it('Ollama: native /api/chat endpoint, token counts from eval fields', async () => {
    process.env.OLLAMA_URL = 'http://box:11434';
    net.post.mockResolvedValueOnce({ data: { message: { content: 'hi' }, prompt_eval_count: 5, eval_count: 2 } });
    const r = await providers.askProvider({ provider: 'ollama', system: 'sys', prompt: 'p', maxTokens: 9 });
    expect(r).toMatchObject({ text: 'hi', provider: 'ollama', model: 'llama3.2:3b', inputTokens: 5, outputTokens: 2 });
    const [url, body, opts] = net.post.mock.calls[0];
    expect(url).toBe('http://box:11434/api/chat');
    expect(body).toEqual({ model: 'llama3.2:3b', stream: false, options: { num_predict: 9 },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'p' }] });
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('Groq / OpenRouter: OpenAI format, bearer key, JSON mode, OpenRouter headers', async () => {
    enable('groq', 'openrouter');
    net.post.mockResolvedValue(openaiReply('{"a":1}'));
    const r = await providers.askProvider({ provider: 'groq', prompt: 'p', json: true, model: 'custom' });
    expect(r).toMatchObject({ text: '{"a":1}', model: 'custom', inputTokens: 3, outputTokens: 4 });
    expect(net.post.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(net.post.mock.calls[0][1]).toMatchObject({ max_tokens: 512, response_format: { type: 'json_object' } });
    expect(net.post.mock.calls[0][2].headers.Authorization).toBe('Bearer gsk');

    await providers.askProvider({ provider: 'openrouter', prompt: 'p' });
    expect(net.post.mock.calls[1][2].headers).toMatchObject({ Authorization: 'Bearer ork', 'X-Title': expect.any(String) });
    expect(net.post.mock.calls[1][1].response_format).toBeUndefined();
  });

  it('disabled provider throws; JSON helper strips fences and returns null on garbage', async () => {
    await expect(providers.askProvider({ provider: 'groq', prompt: 'p' })).rejects.toThrow(/not enabled/);
    net.post.mockResolvedValueOnce({ data: { message: { content: '```json\n{"ok":true}\n```' } } });
    expect(await providers.askProviderJSON({ provider: 'ollama', prompt: 'p' })).toEqual({ ok: true });
    net.post.mockResolvedValueOnce({ data: { message: { content: 'not json' } } });
    expect(await providers.askProviderJSON({ provider: 'ollama', prompt: 'p' })).toBeNull();
  });

  it('health checks report each enabled provider', async () => {
    enable('ollama', 'groq');
    net.post.mockImplementation(async (url: string) => {
      if (url.includes('groq')) throw new Error('401');
      return { data: { message: { content: 'pong' } } };
    });
    const all = await providers.checkAllProviders();
    expect(all.find(p => p.name === 'ollama')).toMatchObject({ enabled: true, ok: true });
    expect(all.find(p => p.name === 'groq')).toEqual({ name: 'groq', enabled: true, ok: false, error: '401' });
    expect(all.find(p => p.name === 'openrouter')).toEqual({ name: 'openrouter', enabled: false });
  });
});

describe('claude adapter', () => {
  it('needs an API key', async () => {
    expect(claude.claudeAvailable()).toBe(false);
    await expect(claude.askClaude({ model: 'claude-haiku-4-5-20251001', prompt: 'p' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('sends the request, appends the JSON instruction and estimates cost', async () => {
    enable('claude');
    net.create.mockResolvedValueOnce(claudeReply('ok'));
    const r = await claude.askClaude({ model: 'claude-haiku-4-5-20251001', system: 'S', prompt: 'p', json: true });
    expect(net.sdkOpts.at(-1)).toEqual({ apiKey: 'sk-ant' });
    expect(net.create.mock.calls[0][0]).toEqual({
      model: 'claude-haiku-4-5-20251001', max_tokens: 512,
      system: 'S\nRespond ONLY with valid JSON. No markdown, no explanation.',
      messages: [{ role: 'user', content: 'p' }],
    });
    // 1000 × $0.80/M + 100 × $4/M
    expect(r).toMatchObject({ text: 'ok', inputTokens: 1000, outputTokens: 100, cost_usd: 0.0012 });

    net.create.mockResolvedValueOnce(claudeReply('plain'));
    await claude.askClaude({ model: 'claude-sonnet-4-6', prompt: 'p' });
    expect(net.create.mock.calls[1][0].system).toBeUndefined();
  });

  it('askClaudeJSON parses or returns null', async () => {
    enable('claude');
    net.create.mockResolvedValueOnce(claudeReply('```json{"x":2}```'));
    expect(await claude.askClaudeJSON({ model: 'claude-sonnet-4-6', prompt: 'p' })).toEqual({ x: 2 });
    net.create.mockResolvedValueOnce(claudeReply('nope'));
    expect(await claude.askClaudeJSON({ model: 'claude-sonnet-4-6', prompt: 'p' })).toBeNull();
  });
});

describe('balancer', () => {
  it('mode defaults to cost; unknown values fall back to cost', () => {
    expect(balancer.getMode()).toBe('cost');
    process.env.BALANCER_MODE = 'RoundRobin';
    expect(balancer.getMode()).toBe('roundrobin');
    process.env.BALANCER_MODE = 'fastest';
    expect(balancer.getMode()).toBe('cost');
  });

  it('no enabled providers → clear error', async () => {
    enable();
    await expect(balancer.ask({ complexity: 'simple', prompt: 'p' })).rejects.toThrow(/No available AI providers/);
  });

  it('cost mode: cheapest first, falls back on failure and reports every error', async () => {
    enable('ollama', 'groq', 'claude');
    net.post.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(openaiReply('from groq'));
    const r = await balancer.ask({ complexity: 'simple', prompt: 'p', tag: 't1' });
    expect(r).toMatchObject({ text: 'from groq', provider: 'groq:llama-3.1-8b-instant' });
    expect(tried()).toEqual(['http://localhost:11434/api/chat', 'https://api.groq.com/openai/v1/chat/completions']);

    net.post.mockReset().mockRejectedValue(new Error('down'));
    net.create.mockRejectedValueOnce(new Error('overloaded'));
    await expect(balancer.ask({ complexity: 'simple', prompt: 'p' }))
      .rejects.toThrow(/All providers failed[\s\S]*ollama: down[\s\S]*groq: down[\s\S]*claude:claude-haiku-4-5-20251001: overloaded/);
  });

  it('cost mode keeps expensive models for harder tasks', async () => {
    enable('claude');
    net.create.mockResolvedValue(claudeReply('ok'));
    await balancer.ask({ complexity: 'simple', prompt: 'p' });
    expect(tried()).toEqual(['claude:claude-haiku-4-5-20251001']); // sonnet/opus — не для simple

    net.create.mockReset()
      .mockRejectedValueOnce(new Error('e1')).mockRejectedValueOnce(new Error('e2')).mockResolvedValueOnce(claudeReply('deep'));
    const r = await balancer.ask({ complexity: 'complex', prompt: 'p' });
    expect(tried()).toEqual(['claude:claude-haiku-4-5-20251001', 'claude:claude-sonnet-4-6', 'claude:claude-opus-4-6']);
    expect(r).toMatchObject({ text: 'deep', provider: 'claude:claude-opus-4-6', cost_usd: expect.any(Number) });
  });

  it('priority mode follows the fixed route, skipping disabled steps', async () => {
    process.env.BALANCER_MODE = 'priority';
    enable('groq', 'claude');
    net.create.mockResolvedValueOnce(claudeReply('crit'));
    await balancer.ask({ complexity: 'critical', prompt: 'p' });
    expect(tried()).toEqual(['claude:claude-sonnet-4-6']);

    net.post.mockResolvedValueOnce(openaiReply('med'));
    await balancer.ask({ complexity: 'medium', prompt: 'p' });
    expect(tried().at(0)).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('roundrobin rotates the starting provider (index persisted in settings)', async () => {
    process.env.BALANCER_MODE = 'roundrobin';
    enable('groq', 'openrouter');
    net.post.mockResolvedValue(openaiReply('x'));
    const first = (await balancer.ask({ complexity: 'simple', prompt: 'p' })).provider.split(':')[0];
    const second = (await balancer.ask({ complexity: 'simple', prompt: 'p' })).provider.split(':')[0];
    const third = (await balancer.ask({ complexity: 'simple', prompt: 'p' })).provider.split(':')[0];
    expect(new Set([first, second])).toEqual(new Set(['groq', 'openrouter']));
    expect(third).toBe(first);
    expect((init.getDb().prepare("SELECT value FROM settings WHERE key = 'rr_index'").get() as any).value).toMatch(/^[01]$/);
  });

  it('AI_PROXY_URL routes everything to the external router, internal balancer is the fallback', async () => {
    process.env.AI_PROXY_URL = 'http://router.local:3456/';
    process.env.AI_PROXY_API_KEY = 'rk';
    enable('groq');
    net.post.mockResolvedValueOnce(openaiReply('via proxy'));
    const r = await balancer.ask({ complexity: 'critical', system: 's', prompt: 'p', json: true });
    expect(r).toMatchObject({ text: 'via proxy', provider: 'proxy:router.local:claude-sonnet-4-6' });
    const [url, body, opts] = net.post.mock.calls[0];
    expect(url).toBe('http://router.local:3456/v1/chat/completions');
    expect(body).toMatchObject({ model: 'claude-sonnet-4-6', response_format: { type: 'json_object' } });
    expect(opts.headers.Authorization).toBe('Bearer rk');

    process.env.AI_PROXY_MODEL = 'fixed';
    net.post.mockRejectedValueOnce(new Error('router down')).mockResolvedValueOnce(openaiReply('local'));
    expect((await balancer.ask({ complexity: 'simple', prompt: 'p' })).provider).toBe('groq:llama-3.1-8b-instant');
    expect(net.post.mock.calls[1][1].model).toBe('fixed');
  });

  it('askJSON parses fenced JSON, null when unparseable or nothing answers', async () => {
    enable('groq');
    net.post.mockResolvedValueOnce(openaiReply('```json\n{"score": 7}\n```'));
    expect(await balancer.askJSON({ complexity: 'simple', prompt: 'p' })).toEqual({ score: 7 });
    net.post.mockResolvedValueOnce(openaiReply('seven'));
    expect(await balancer.askJSON({ complexity: 'simple', prompt: 'p' })).toBeNull();
    enable();
    delete process.env.GROQ_API_KEY;
    expect(await balancer.askJSON({ complexity: 'simple', prompt: 'p' })).toBeNull();
  });

  it('routing info lists available and disabled steps; proxy status', () => {
    enable('groq');
    const info = balancer.getRoutingInfo();
    expect(info.mode).toBe('cost');
    expect(info.routes.simple[0]).toBe('✅ groq [1-free-cloud]');
    expect(info.routes.simple).toContain('⬜ ollama (disabled)');
    expect(info.routes.critical).toContain('⬜ claude:claude-opus-4-6 (disabled)');
    expect(info.proxy.status).toMatch(/not configured/);
    process.env.AI_PROXY_URL = 'http://r:1';
    expect(balancer.getRoutingInfo().proxy).toMatchObject({ url: 'http://r:1', model: 'auto' });
  });

  it('usage stats aggregate logged calls per provider and tag', () => {
    const stats = balancer.getAIUsageStats(1);
    const claudeRows = stats.filter(s => s.provider.startsWith('claude:'));
    expect(stats.find(s => s.provider === 'groq:llama-3.1-8b-instant' && s.tag === 't1'))
      .toMatchObject({ calls: 1, total_tokens: 7 });
    expect(claudeRows.reduce((sum, r) => sum + r.total_cost_usd, 0)).toBeGreaterThan(0);
    expect(stats.some(s => s.provider.startsWith('proxy:router.local'))).toBe(true);
  });
});
