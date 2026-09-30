/**
 * Тести парсера RSS (Atom) фідів каналів YouTube
 */
import { describe, it, expect } from 'vitest';
import { parseFeed } from '../src/youtube/rss';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <title>Veritasium</title>
  <entry>
    <id>yt:video:AAAAAAAAAAA</id>
    <yt:videoId>AAAAAAAAAAA</yt:videoId>
    <yt:channelId>UCHnyfMqiRRG1u-2MsSQLbXA</yt:channelId>
    <title>Newest &amp; best &quot;video&quot; &#39;ever&#39;</title>
    <published>2026-09-20T10:00:00+00:00</published>
    <updated>2026-09-21T10:00:00+00:00</updated>
  </entry>
  <entry>
    <id>yt:video:BBBBBBBBBBB</id>
    <yt:videoId>BBBBBBBBBBB</yt:videoId>
    <yt:channelId>UCHnyfMqiRRG1u-2MsSQLbXA</yt:channelId>
    <title>Older video</title>
    <published>2026-09-10T10:00:00+00:00</published>
  </entry>
  <entry>
    <yt:videoId>CCCCCCCCCCC</yt:videoId>
    <title>Broken entry without channel and date</title>
  </entry>
</feed>`;

describe('parseFeed', () => {
  const entries = parseFeed(FEED);

  it('parses complete entries and skips broken ones', () => {
    expect(entries.map(e => e.video_id)).toEqual(['AAAAAAAAAAA', 'BBBBBBBBBBB']);
  });

  it('keeps feed order (newest first)', () => {
    expect(entries[0].published_at).toBe('2026-09-20T10:00:00+00:00');
  });

  it('extracts channel id', () => {
    expect(entries[0].channel_id).toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
  });

  it('decodes XML entities in titles', () => {
    expect(entries[0].title).toBe(`Newest & best "video" 'ever'`);
  });

  it('does not pick up the feed-level <title>', () => {
    expect(entries.every(e => e.title !== 'Veritasium')).toBe(true);
  });

  it('returns empty list for empty or non-feed input', () => {
    expect(parseFeed('')).toEqual([]);
    expect(parseFeed('<html>not a feed</html>')).toEqual([]);
  });
});
