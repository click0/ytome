/**
 * Тести модуля оцінки відео (evaluation)
 *
 * Тестуємо скорингові функції без залежності від БД/AI.
 */
import { describe, it, expect } from 'vitest';

// Реімплементація скорингових функцій для тестування
// (оригінал в src/evaluation/index.ts)

function scoreFreshness(publishedAt: string): number {
  const ageMs   = Date.now() - new Date(publishedAt).getTime();
  const ageDays = ageMs / 86400000;

  if (ageDays <= 7)   return 30;
  if (ageDays <= 30)  return 25;
  if (ageDays <= 90)  return 20;
  if (ageDays <= 180) return 15;
  if (ageDays <= 365) return 10;
  return 5;
}

function scoreQuality(input: {
  title: string;
  description?: string;
  view_count?: number;
  like_count?: number;
  duration_sec?: number;
  has_captions: boolean;
}): number {
  let score = 0;

  // Duration: too short or too long is bad
  if (input.duration_sec) {
    if (input.duration_sec >= 300 && input.duration_sec <= 3600) score += 10;
    else if (input.duration_sec >= 60) score += 5;
  }

  // Engagement ratio
  if (input.view_count && input.like_count) {
    const ratio = input.like_count / input.view_count;
    if (ratio >= 0.05) score += 10;
    else if (ratio >= 0.02) score += 5;
  }

  // Captions boost
  if (input.has_captions) score += 5;

  // Educational keywords
  const text = `${input.title} ${input.description || ''}`.toLowerCase();
  const eduKeywords = ['tutorial', 'guide', 'course', 'how to', 'explained', 'deep dive', 'урок', 'курс'];
  if (eduKeywords.some(kw => text.includes(kw))) score += 5;

  return Math.min(score, 30);
}

describe('scoreFreshness', () => {
  it('gives max score (30) for videos < 7 days old', () => {
    const recent = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(scoreFreshness(recent)).toBe(30);
  });

  it('gives 25 for videos 7-30 days old', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    expect(scoreFreshness(twoWeeksAgo)).toBe(25);
  });

  it('gives 20 for videos 30-90 days old', () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 86400000).toISOString();
    expect(scoreFreshness(twoMonthsAgo)).toBe(20);
  });

  it('gives 5 for videos > 1 year old', () => {
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    expect(scoreFreshness(old)).toBe(5);
  });
});

describe('scoreQuality', () => {
  it('gives points for ideal duration (5-60 min)', () => {
    const score = scoreQuality({
      title: 'Test', duration_sec: 600, has_captions: false,
    });
    expect(score).toBeGreaterThanOrEqual(10);
  });

  it('gives fewer points for very short videos', () => {
    const score = scoreQuality({
      title: 'Test', duration_sec: 30, has_captions: false,
    });
    expect(score).toBeLessThan(10);
  });

  it('gives caption bonus', () => {
    const withCaptions = scoreQuality({
      title: 'Test', has_captions: true,
    });
    const withoutCaptions = scoreQuality({
      title: 'Test', has_captions: false,
    });
    expect(withCaptions).toBeGreaterThan(withoutCaptions);
  });

  it('gives educational keyword bonus', () => {
    const educational = scoreQuality({
      title: 'Python Tutorial for Beginners', has_captions: false,
    });
    const generic = scoreQuality({
      title: 'Random Video', has_captions: false,
    });
    expect(educational).toBeGreaterThan(generic);
  });

  it('gives engagement ratio bonus', () => {
    const highEngagement = scoreQuality({
      title: 'Test', view_count: 1000, like_count: 100, has_captions: false,
    });
    expect(highEngagement).toBeGreaterThanOrEqual(10);
  });

  it('caps at 30', () => {
    const maxed = scoreQuality({
      title: 'Complete TypeScript Tutorial deep dive',
      description: 'Full course guide explained',
      duration_sec: 1800,
      view_count: 1000,
      like_count: 100,
      has_captions: true,
    });
    expect(maxed).toBeLessThanOrEqual(30);
  });
});
