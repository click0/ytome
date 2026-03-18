/**
 * Тести Zod-валідації MCP-інструментів
 */
import { describe, it, expect } from 'vitest';
import { validateArgs } from '../src/mcp/validation';

describe('validateArgs', () => {
  // ── subscribe ──────────────────────────────────
  describe('subscribe', () => {
    it('accepts valid channel handle', () => {
      const result = validateArgs('subscribe', { channel: '@mkbhd' });
      expect(result.channel).toBe('@mkbhd');
    });

    it('accepts channel with visibility and notes', () => {
      const result = validateArgs('subscribe', {
        channel: 'UCxxxxxx',
        visibility: 'public',
        notes: 'Tech reviews',
      });
      expect(result.visibility).toBe('public');
      expect(result.notes).toBe('Tech reviews');
    });

    it('rejects empty channel', () => {
      expect(() => validateArgs('subscribe', { channel: '' }))
        .toThrow('Validation error');
    });

    it('rejects missing channel', () => {
      expect(() => validateArgs('subscribe', {}))
        .toThrow('Validation error');
    });

    it('rejects invalid visibility', () => {
      expect(() => validateArgs('subscribe', { channel: '@test', visibility: 'hidden' }))
        .toThrow('Validation error');
    });
  });

  // ── mark_seen ──────────────────────────────────
  describe('mark_seen', () => {
    it('accepts valid video_id', () => {
      const result = validateArgs('mark_seen', { video_id: 'dQw4w9WgXcQ' });
      expect(result.video_id).toBe('dQw4w9WgXcQ');
    });

    it('rejects empty video_id', () => {
      expect(() => validateArgs('mark_seen', { video_id: '' }))
        .toThrow('Validation error');
    });
  });

  // ── watch_later_add ────────────────────────────
  describe('watch_later_add', () => {
    it('accepts minimal input', () => {
      const result = validateArgs('watch_later_add', { video_id: 'abc123' });
      expect(result.video_id).toBe('abc123');
    });

    it('accepts full input', () => {
      const result = validateArgs('watch_later_add', {
        video_id: 'abc123',
        priority: 'high',
        remind_at: '2026-04-01',
        note: 'important',
        tags: ['tech', 'review'],
      });
      expect(result.priority).toBe('high');
      expect(result.tags).toEqual(['tech', 'review']);
    });

    it('rejects invalid priority', () => {
      expect(() => validateArgs('watch_later_add', { video_id: 'x', priority: 'urgent' }))
        .toThrow('Validation error');
    });
  });

  // ── watch_later_update ─────────────────────────
  describe('watch_later_update', () => {
    it('requires positive integer id', () => {
      expect(() => validateArgs('watch_later_update', { id: -1 }))
        .toThrow('Validation error');
    });

    it('rejects non-integer id', () => {
      expect(() => validateArgs('watch_later_update', { id: 1.5 }))
        .toThrow('Validation error');
    });

    it('accepts valid update', () => {
      const result = validateArgs('watch_later_update', { id: 42, status: 'done' });
      expect(result.id).toBe(42);
      expect(result.status).toBe('done');
    });
  });

  // ── get_comments ───────────────────────────────
  describe('get_comments', () => {
    it('accepts valid input', () => {
      const result = validateArgs('get_comments', {
        video_id: 'abc',
        limit: 50,
        owner_only: true,
      });
      expect(result.limit).toBe(50);
    });

    it('rejects limit > 100', () => {
      expect(() => validateArgs('get_comments', { video_id: 'x', limit: 200 }))
        .toThrow('Validation error');
    });

    it('rejects limit < 1', () => {
      expect(() => validateArgs('get_comments', { video_id: 'x', limit: 0 }))
        .toThrow('Validation error');
    });
  });

  // ── proxy_add ──────────────────────────────────
  describe('proxy_add', () => {
    it('accepts valid URL', () => {
      const result = validateArgs('proxy_add', {
        url: 'http://proxy.example.com:8080',
        label: 'My proxy',
      });
      expect(result.url).toBe('http://proxy.example.com:8080');
    });

    it('rejects invalid URL', () => {
      expect(() => validateArgs('proxy_add', { url: 'not-a-url' }))
        .toThrow('Validation error');
    });
  });

  // ── proxy_remove ───────────────────────────────
  describe('proxy_remove', () => {
    it('rejects negative id', () => {
      expect(() => validateArgs('proxy_remove', { id: -5 }))
        .toThrow('Validation error');
    });
  });

  // ── filter_add ─────────────────────────────────
  describe('filter_add', () => {
    it('accepts valid rule', () => {
      const result = validateArgs('filter_add', {
        type: 'blacklist',
        scope: 'description',
        value: 'spam',
      });
      expect(result.type).toBe('blacklist');
      expect(result.scope).toBe('description');
    });

    it('rejects missing value', () => {
      expect(() => validateArgs('filter_add', { type: 'whitelist', scope: 'channel', value: '' }))
        .toThrow('Validation error');
    });

    it('rejects invalid type', () => {
      expect(() => validateArgs('filter_add', { type: 'graylist', scope: 'channel', value: 'x' }))
        .toThrow('Validation error');
    });
  });

  // ── ai_set_mode ────────────────────────────────
  describe('ai_set_mode', () => {
    it('accepts valid mode', () => {
      const result = validateArgs('ai_set_mode', { mode: 'roundrobin' });
      expect(result.mode).toBe('roundrobin');
    });

    it('rejects invalid mode', () => {
      expect(() => validateArgs('ai_set_mode', { mode: 'random' }))
        .toThrow('Validation error');
    });
  });

  // ── evaluate_batch ─────────────────────────────
  describe('evaluate_batch', () => {
    it('requires at least 1 video id', () => {
      expect(() => validateArgs('evaluate_batch', { video_ids: [] }))
        .toThrow('Validation error');
    });

    it('accepts valid array', () => {
      const result = validateArgs('evaluate_batch', { video_ids: ['a', 'b', 'c'] });
      expect(result.video_ids).toHaveLength(3);
    });
  });

  // ── download ───────────────────────────────────
  describe('download', () => {
    it('defaults format to audio', () => {
      const result = validateArgs('download', { video_id: 'xyz' });
      expect(result.format).toBe('audio');
    });

    it('rejects invalid format', () => {
      expect(() => validateArgs('download', { video_id: 'x', format: 'mp3' }))
        .toThrow('Validation error');
    });
  });

  // ── quota_status ───────────────────────────────
  describe('quota_status', () => {
    it('accepts empty object', () => {
      const result = validateArgs('quota_status', {});
      expect(result).toBeDefined();
    });

    it('accepts valid history_days', () => {
      const result = validateArgs('quota_status', { history_days: 30 });
      expect(result.history_days).toBe(30);
    });
  });

  // ── unknown tool ───────────────────────────────
  describe('unknown tool', () => {
    it('passes args through for unknown tools', () => {
      const result = validateArgs('nonexistent_tool', { foo: 'bar' });
      expect(result).toEqual({ foo: 'bar' });
    });
  });
});
