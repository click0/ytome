/**
 * Тести генератора .nfo (Kodi XML для Jellyfin/Emby/Plex)
 */
import { describe, it, expect } from 'vitest';
import {
  escapeXml, sanitizeFilename, seasonOf, episodeOf, episodeCode,
  episodeBaseName, buildEpisodeNfo, buildShowNfo,
} from '../src/export/nfo';

const channel = { youtube_id: 'UCabc', name: 'Veritasium', description: 'Science & more' };
const video = {
  youtube_id: 'dQw4w9WgXcQ',
  title: 'Why <Physics> is "fun"',
  description: 'A & B',
  published_at: '2026-03-15T14:30:00Z',
  duration_sec: 754,
  tags: JSON.stringify(['physics', 'science']),
};

describe('escapeXml', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });

  it('strips control characters invalid in XML 1.0', () => {
    expect(escapeXml('ok\x01\x08text\ttab')).toBe('oktext\ttab');
  });
});

describe('sanitizeFilename', () => {
  it('removes characters forbidden on Windows', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij');
  });

  it('trims trailing dots and spaces', () => {
    expect(sanitizeFilename('title... ')).toBe('title');
  });

  it('collapses whitespace', () => {
    expect(sanitizeFilename('a   b\t c')).toBe('a b c');
  });

  it('falls back to "untitled" for empty result', () => {
    expect(sanitizeFilename('???')).toBe('untitled');
  });

  it('respects max length', () => {
    expect(sanitizeFilename('x'.repeat(300), 50)).toHaveLength(50);
  });
});

describe('episode numbering', () => {
  it('season is the UTC year', () => {
    expect(seasonOf('2026-03-15T14:30:00Z')).toBe(2026);
  });

  it('episode = MMDD * 100 + day index', () => {
    expect(episodeOf('2026-03-15T14:30:00Z', 1)).toBe(31501);
    expect(episodeOf('2026-12-31T23:00:00Z', 2)).toBe(123102);
  });

  it('episode code is zero-padded to 6 digits', () => {
    expect(episodeCode(2026, 31501)).toBe('S2026E031501');
  });

  it('base name is filesystem-safe', () => {
    expect(episodeBaseName('Veritasium', video, 1))
      .toBe('Veritasium - S2026E031501 - Why Physics is fun');
  });
});

describe('buildEpisodeNfo', () => {
  const nfo = buildEpisodeNfo(channel, video, 1);

  it('is a Kodi episodedetails document', () => {
    expect(nfo).toMatch(/^<\?xml version="1.0"/);
    expect(nfo).toContain('<episodedetails>');
    expect(nfo).toContain('</episodedetails>');
  });

  it('contains escaped title and plot', () => {
    expect(nfo).toContain('<title>Why &lt;Physics&gt; is &quot;fun&quot;</title>');
    expect(nfo).toContain('<plot>A &amp; B</plot>');
  });

  it('contains season, episode, aired date and runtime in minutes', () => {
    expect(nfo).toContain('<season>2026</season>');
    expect(nfo).toContain('<episode>31501</episode>');
    expect(nfo).toContain('<aired>2026-03-15</aired>');
    expect(nfo).toContain('<runtime>13</runtime>');
  });

  it('contains youtube uniqueid and tags', () => {
    expect(nfo).toContain('<uniqueid type="youtube" default="true">dQw4w9WgXcQ</uniqueid>');
    expect(nfo).toContain('<tag>physics</tag>');
    expect(nfo).toContain('<tag>science</tag>');
  });

  it('tolerates malformed tags JSON', () => {
    expect(() => buildEpisodeNfo(channel, { ...video, tags: '{not json' }, 1)).not.toThrow();
  });

  it('omits empty optional fields', () => {
    const minimal = buildEpisodeNfo(channel, { ...video, description: null, duration_sec: null, tags: null }, 1);
    expect(minimal).not.toContain('<plot>');
    expect(minimal).not.toContain('<runtime>');
    expect(minimal).not.toContain('<tag>');
  });
});

describe('buildShowNfo', () => {
  it('describes the channel as a TV show', () => {
    const nfo = buildShowNfo(channel);
    expect(nfo).toContain('<tvshow>');
    expect(nfo).toContain('<title>Veritasium</title>');
    expect(nfo).toContain('<plot>Science &amp; more</plot>');
    expect(nfo).toContain('<uniqueid type="youtube" default="true">UCabc</uniqueid>');
  });
});
