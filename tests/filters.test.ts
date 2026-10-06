/**
 * Фільтри whitelist/blacklist — справжній модуль src/filters на тимчасовій БД.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { useTempStorage, initTestDb, cleanup } from './helpers/temp-db';

const { tmp } = useTempStorage('filters');

let f: typeof import('../src/filters/index');
let closeDb: () => void;

beforeAll(async () => {
  closeDb = (await initTestDb()).closeDb;
  f = await import('../src/filters/index');
});

afterAll(() => cleanup(tmp, closeDb));

beforeEach(() => f.clearFilterRules());

const video = (extra: Partial<import('../src/filters/index').VideoCandidate> = {}) => ({
  youtube_id: 'vid00000001',
  channel_youtube_id: 'UCxyz',
  title: 'Learn React',
  description: 'A React tutorial with hooks',
  type: 'video' as const,
  ...extra,
});

describe('CRUD', () => {
  it('addFilterRule upserts by (type, scope, value) and re-enables the rule', () => {
    const a = f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'react', note: 'n1' });
    expect(a).toMatchObject({ type: 'blacklist', case_sensitive: false, enabled: true, note: 'n1', hit_count: 0 });
    f.setFilterEnabled(a.id, false);
    const b = f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'react', caseSensitive: true });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ enabled: true, case_sensitive: true });
    expect(f.listFilterRules()).toHaveLength(1);
  });

  it('listFilterRules filters by type and scope, removeFilterRule deletes', () => {
    const w = f.addFilterRule({ type: 'whitelist', scope: 'channel', value: 'UCxyz' });
    f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'spam' });
    expect(f.listFilterRules({ type: 'whitelist' }).map(r => r.value)).toEqual(['UCxyz']);
    expect(f.listFilterRules({ scope: 'description' }).map(r => r.value)).toEqual(['spam']);
    f.removeFilterRule(w.id);
    expect(f.listFilterRules().map(r => r.value)).toEqual(['spam']);
  });

  it('clearFilterRules by type or all', () => {
    f.addFilterRule({ type: 'whitelist', scope: 'channel', value: 'UCxyz' });
    f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'spam' });
    f.clearFilterRules('blacklist');
    expect(f.listFilterRules().map(r => r.type)).toEqual(['whitelist']);
    f.clearFilterRules();
    expect(f.listFilterRules()).toEqual([]);
  });
});

describe('applyFilters', () => {
  it('allows everything when there are no rules', () => {
    expect(f.applyFilters(video())).toEqual({ allowed: true });
  });

  it('blacklist keyword in description blocks and counts a hit', () => {
    const r = f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'REACT' });
    const res = f.applyFilters(video());
    expect(res).toMatchObject({ allowed: false, rule_id: r.id });
    expect(res.reason).toMatch(/blacklist \[description\]: "REACT"/);
    expect(f.listFilterRules()[0].hit_count).toBe(1);
  });

  it('case-sensitive blacklist ignores a different case', () => {
    f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'REACT', caseSensitive: true });
    expect(f.applyFilters(video()).allowed).toBe(true);
  });

  it('whitelist by channel ID matches with default (case-insensitive) rules', () => {
    f.addFilterRule({ type: 'whitelist', scope: 'channel', value: 'UCxyz' });
    expect(f.applyFilters(video()).allowed).toBe(true);
    expect(f.applyFilters(video({ channel_youtube_id: 'UCother' }))).toMatchObject({
      allowed: false, reason: expect.stringMatching(/whitelist \[channel\]: no matching rule for "UCother"/),
    });
  });

  it('case-sensitive channel rule requires the exact ID', () => {
    f.addFilterRule({ type: 'whitelist', scope: 'channel', value: 'UCxyz', caseSensitive: true });
    expect(f.applyFilters(video({ channel_youtube_id: 'ucxyz' })).allowed).toBe(false);
    expect(f.applyFilters(video()).allowed).toBe(true);
  });

  it('channel rules never match by substring', () => {
    f.addFilterRule({ type: 'blacklist', scope: 'channel', value: 'UCx' });
    expect(f.applyFilters(video()).allowed).toBe(true);
  });

  it('disabled rules are ignored', () => {
    const r = f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'react' });
    f.setFilterEnabled(r.id, false);
    expect(f.applyFilters(video()).allowed).toBe(true);
  });

  it('whitelist pass + blacklist match → blocked by blacklist', () => {
    f.addFilterRule({ type: 'whitelist', scope: 'channel', value: 'UCxyz' });
    f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'hooks' });
    expect(f.applyFilters(video()).reason).toMatch(/^blacklist/);
  });

  it('whitelist scopes are independent: every scope must match', () => {
    f.addFilterRule({ type: 'whitelist', scope: 'channel', value: 'UCxyz' });
    f.addFilterRule({ type: 'whitelist', scope: 'description', value: 'rust' });
    expect(f.applyFilters(video()).reason).toMatch(/whitelist \[description\]/);
    expect(f.applyFilters(video({ description: 'Rust book' })).allowed).toBe(true);
  });

  it('a video without description does not match description rules', () => {
    f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'react' });
    expect(f.applyFilters(video({ description: undefined })).allowed).toBe(true);
  });
});

describe('filterVideos', () => {
  it('splits a batch into allowed and blocked with reasons', () => {
    f.addFilterRule({ type: 'blacklist', scope: 'description', value: 'sponsored' });
    const ok = video({ youtube_id: 'ok000000001' });
    const bad = video({ youtube_id: 'bad00000001', description: 'Sponsored content' });
    const res = f.filterVideos([ok, bad]);
    expect(res.allowed).toEqual([ok]);
    expect(res.blocked).toEqual([{ video: bad, reason: expect.stringMatching(/sponsored/) }]);
  });
});
