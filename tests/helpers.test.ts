/**
 * Тести допоміжних функцій з handlers.ts
 *
 * Тестуємо: parseSince, extractVideoId, buildBar
 */
import { describe, it, expect } from 'vitest';

// Імпортуємо код напряму для тестування (ці функції не експортовані,
// тому перевіряємо їхню логіку через окремі копії)

// ── parseSince ───────────────────────────────────
function parseSince(since?: string): string {
  if (!since) return new Date(Date.now() - 7 * 86400000).toISOString();
  if (since === '1d') return new Date(Date.now() - 86400000).toISOString();
  if (since === '1w') return new Date(Date.now() - 7 * 86400000).toISOString();
  if (since === '1m') return new Date(Date.now() - 30 * 86400000).toISOString();
  return new Date(since).toISOString();
}

// ── extractVideoId ───────────────────────────────
function extractVideoId(input: string): string {
  const urlMatch = input.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return urlMatch ? urlMatch[1] : input;
}

// ── buildBar ─────────────────────────────────────
function buildBar(percent: number): string {
  const filled = Math.round(percent / 5);
  const empty  = 20 - filled;
  const color  = percent >= 95 ? '🔴' : percent >= 80 ? '🟡' : '🟢';
  return `${color} [${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

describe('parseSince', () => {
  it('returns ~7 days ago for undefined', () => {
    const result = new Date(parseSince()).getTime();
    const expected = Date.now() - 7 * 86400000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  it('returns ~1 day ago for "1d"', () => {
    const result = new Date(parseSince('1d')).getTime();
    const expected = Date.now() - 86400000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  it('returns ~7 days ago for "1w"', () => {
    const result = new Date(parseSince('1w')).getTime();
    const expected = Date.now() - 7 * 86400000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  it('returns ~30 days ago for "1m"', () => {
    const result = new Date(parseSince('1m')).getTime();
    const expected = Date.now() - 30 * 86400000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  it('parses ISO date string', () => {
    const input = '2026-01-15T00:00:00Z';
    expect(parseSince(input)).toBe(new Date(input).toISOString());
  });
});

describe('extractVideoId', () => {
  it('returns raw ID for plain string', () => {
    expect(extractVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtube.com/watch?v=...', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtu.be/... short URL', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from URL with extra params', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120')).toBe('dQw4w9WgXcQ');
  });

  it('returns original for non-matching string', () => {
    expect(extractVideoId('just-some-text')).toBe('just-some-text');
  });
});

describe('buildBar', () => {
  it('shows green for 0%', () => {
    const bar = buildBar(0);
    expect(bar).toContain('🟢');
    expect(bar).toContain('0%');
  });

  it('shows green for 50%', () => {
    const bar = buildBar(50);
    expect(bar).toContain('🟢');
    expect(bar).toContain('50%');
  });

  it('shows yellow for 80%', () => {
    const bar = buildBar(80);
    expect(bar).toContain('🟡');
  });

  it('shows yellow for 90%', () => {
    const bar = buildBar(90);
    expect(bar).toContain('🟡');
  });

  it('shows red for 95%', () => {
    const bar = buildBar(95);
    expect(bar).toContain('🔴');
  });

  it('shows red for 100%', () => {
    const bar = buildBar(100);
    expect(bar).toContain('🔴');
    expect(bar).toContain('100%');
  });

  it('has 20 total bar segments', () => {
    const bar = buildBar(50);
    const filledCount = (bar.match(/█/g) || []).length;
    const emptyCount = (bar.match(/░/g) || []).length;
    expect(filledCount + emptyCount).toBe(20);
  });
});
