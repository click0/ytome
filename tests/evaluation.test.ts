/**
 * Оцінка відео — справжній src/evaluation, AI-балансувальник підмінено.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ai = vi.hoisted(() => ({
  json: {} as Record<string, unknown>,
  askJSON: vi.fn(),
  ask: vi.fn(),
}));

vi.mock('../src/ai/balancer', () => ({
  askJSON: ai.askJSON,
  ask: ai.ask,
}));

import { evaluateVideo, evaluateBatch } from '../src/evaluation/index';

const NOW = new Date('2026-10-06T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ai.json = {};
  ai.askJSON.mockReset().mockImplementation(async (req: { tag: string }) => ai.json[req.tag] ?? null);
  ai.ask.mockReset().mockResolvedValue({ text: '  Short summary.  ' });
});

afterEach(() => vi.useRealTimers());

describe('evaluateVideo', () => {
  it('fresh, popular tutorial on a fast-moving topic → high', async () => {
    ai.json = {
      relevance: { score: 18, reason: 'r' }, tech_currency: { score: 20 },
      topics: { topics: ['react', 'hooks'] }, audience: { audience: 'frontend devs' },
    };
    const r = await evaluateVideo({
      youtube_id: 'vid00000001', title: 'React tutorial 2026', published_at: daysAgo(10),
      view_count: 200_000, like_count: 12_000, has_captions: true, caption_type: 'manual',
      duration_sec: 1800,
    });
    expect(r.volatility).toBe('high');
    expect(r.age_days).toBe(10);
    expect(r.score).toEqual({ total: 96, freshness: 30, quality: 28, relevance: 18, tech_currency: 20 });
    expect(r.recommendation).toBe('high');
    expect(r.label).toMatch(/РЕКОМЕНДОВАНО/);
    expect(r.reasons).toEqual(expect.arrayContaining([
      'Свіжий контент (10 днів)', 'Висока якість (перегляди, лайки, субтитри)', 'Ручні субтитри — краща транскрипція',
    ]));
    expect(r.warnings).toEqual([]);
    expect(r.ai_summary).toBe('Short summary.');
    expect(r.ai_topics).toEqual(['react', 'hooks']);
    expect(r.ai_audience).toBe('frontend devs');
    expect(r.evaluated_at).toBe(NOW.toISOString());
  });

  it('old, short, uncaptioned video on a stable topic → skip with warnings and fallbacks', async () => {
    ai.ask.mockResolvedValue({ text: '   ' });
    const r = await evaluateVideo({
      youtube_id: 'vid00000002', title: 'Sorting algorithms', published_at: '2000-01-01T00:00:00Z',
      duration_sec: 60, has_captions: false, tags: ['algo', 'cs', 'a', 'b', 'c', 'd'],
      contains_synthetic_media: true,
    });
    expect(r.volatility).toBe('low');
    // Немає AI-відповіді: релевантність 10 за замовчуванням, техактуальність без сигналів 0
    expect(r.score).toEqual({ total: 10, freshness: 0, quality: 0, relevance: 10, tech_currency: 0 });
    expect(r.recommendation).toBe('skip');
    expect(r.warnings).toEqual([
      expect.stringMatching(/^Старий контент для low-volatile теми/),
      'Низькі показники якості',
      'Немає субтитрів',
      'Відео містить синтетичний/AI-генерований контент',
    ]);
    expect(r.ai_summary).toBeUndefined();
    expect(r.ai_topics).toEqual(['algo', 'cs', 'a', 'b', 'c']);
    expect(r.ai_audience).toBeUndefined();
    // Без сигналів свіжості AI для техактуальності не викликається
    expect(ai.askJSON.mock.calls.map(([req]) => req.tag)).not.toContain('tech_currency');
  });

  it('freshness decays linearly between ideal and critical age (medium volatility)', async () => {
    ai.json = { relevance: { score: 20 } };
    const r = await evaluateVideo({
      youtube_id: 'vid00000003', title: 'Python course', published_at: daysAgo(410),
      view_count: 20_000, like_count: 300, has_captions: true, caption_type: 'auto',
    });
    expect(r.volatility).toBe('medium');
    // (410-90)/(730-90) = 0.5 → 15; якість: 6 + 2 + 3 + 4 = 15
    expect(r.score).toMatchObject({ freshness: 15, quality: 15, relevance: 20, tech_currency: 0, total: 50 });
    expect(r.recommendation).toBe('medium');
  });

  it('25–49 points → low', async () => {
    ai.json = { relevance: { score: 15 } };
    const r = await evaluateVideo({
      youtube_id: 'vid00000004', title: 'Python basics', published_at: daysAgo(410),
      view_count: 20_000, like_count: 300, has_captions: true, caption_type: 'auto',
    });
    expect(r.score.total).toBe(41);
    expect(r.recommendation).toBe('low');
  });

  it('negative signals cost quality points', async () => {
    const base = { youtube_id: 'vid00000005', published_at: daysAgo(1), view_count: 1_500, has_captions: true };
    const plain = await evaluateVideo({ ...base, title: 'Cooking pasta' });
    const meme  = await evaluateVideo({ ...base, title: 'Cooking pasta #shorts' });
    expect(plain.score.quality).toBe(3);
    expect(meme.score.quality).toBe(0);
  });

  it('ambiguous freshness signals ask AI, falling back to the signal score', async () => {
    const r = await evaluateVideo({
      youtube_id: 'vid00000006', title: 'Latest updated guide', published_at: daysAgo(1), has_captions: true,
    });
    // 'latest' + 'updated' = 10 → AI не відповів → 10
    expect(r.score.tech_currency).toBe(10);
    expect(ai.askJSON.mock.calls.map(([req]) => req.tag)).toContain('tech_currency');

    const many = await evaluateVideo({
      youtube_id: 'vid00000007', title: 'New latest updated 2026 v2 guide', published_at: daysAgo(1), has_captions: true,
    });
    expect(many.score.tech_currency).toBe(20); // ≥15 — без AI
  });
});

describe('evaluateBatch', () => {
  it('evaluates all inputs and sorts by total score', async () => {
    ai.json = { relevance: { score: 20 } };
    const res = await evaluateBatch([
      { youtube_id: 'old00000001', title: 'Old', published_at: '2000-01-01T00:00:00Z', has_captions: false },
      { youtube_id: 'new00000001', title: 'Fresh', published_at: daysAgo(1), has_captions: true, caption_type: 'manual' },
    ]);
    expect(res.map(r => r.video_id)).toEqual(['new00000001', 'old00000001']);
    expect(res[0].score.total).toBeGreaterThan(res[1].score.total);
  });
});
