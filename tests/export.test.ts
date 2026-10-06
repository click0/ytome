/**
 * Експорт підписок (OPML з групами, JSON) та імпорт OPML — справжня БД.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, seedChannel, cleanup } from './helpers/temp-db';

const { tmp, storage } = useTempStorage('export');

let ex: typeof import('../src/youtube/export');
let init: Awaited<ReturnType<typeof initTestDb>>;

beforeAll(async () => {
  init = await initTestDb();
  ex = await import('../src/youtube/export');
  const q = await import('../src/db/queries');
  const db = init.getDb();

  const tech = seedChannel(db, { youtube_id: 'UCtech', name: 'Tech & "Code"', handle: '@tech', visibility: 'public' });
  seedChannel(db, { youtube_id: 'UCsolo', name: 'Solo <one>', visibility: 'public' });
  seedChannel(db, { youtube_id: 'UCpriv', name: 'Private', visibility: 'private' });
  db.prepare("UPDATE channels SET notes = 'likes \"Rust\" & Go', tags = '[\"dev\"]' WHERE id = ?").run(tech);

  const g = q.createGroup('Dev & Ops', 'public');
  q.addChannelToGroup(g, tech);
  q.createGroup('Empty', 'public');
});

afterAll(() => cleanup(tmp, init.closeDb));

describe('exportOPML', () => {
  it('nests grouped channels under their group, the rest at the root', () => {
    const r = ex.exportOPML({ visibility: 'public', filename: 'subs.opml' });
    expect(r.path).toBe(path.join(storage, 'exports', 'subs.opml'));
    expect(r.count).toBe(2);
    expect(fs.readFileSync(r.path, 'utf-8')).toBe(r.content);

    const group = r.content.match(/<outline text="Dev &amp; Ops" title="Dev &amp; Ops">([\s\S]*?)<\/outline>\n/);
    expect(group).not.toBeNull();
    expect(group![1]).toContain('youtubeId="UCtech"');
    expect(group![1]).not.toContain('UCsolo');
    expect(r.content).not.toContain('text="Empty"');           // порожні групи пропускаємо
    expect(r.content).not.toContain('UCpriv');                 // лише public
    expect(r.content).toContain('xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCsolo"');
    expect(r.content).toContain('htmlUrl="https://www.youtube.com/@tech"');
    expect(r.content).toContain('htmlUrl="https://www.youtube.com/channel/UCsolo"');
    expect(r.content).toContain('text="Solo &lt;one&gt;"');
  });

  it('without groups every channel is at the root', () => {
    const r = ex.exportOPML({ visibility: 'all', includeGroups: false });
    expect(r.count).toBe(3);
    expect(r.content).not.toContain('Dev &amp; Ops');
  });

  it('round-trips through parseOPML with entities decoded', () => {
    const parsed = ex.parseOPML(ex.exportOPML({ visibility: 'all' }).content);
    expect(parsed).toHaveLength(3);
    expect(parsed.find(c => c.youtube_id === 'UCtech')).toEqual({
      youtube_id: 'UCtech', handle: '@tech', name: 'Tech & "Code"', visibility: 'public', notes: 'likes "Rust" & Go',
    });
    expect(parsed.find(c => c.youtube_id === 'UCpriv')).toMatchObject({ visibility: 'private', handle: undefined });
  });
});

describe('parseOPML', () => {
  it('reads only outlines with youtubeId; defaults name and visibility', () => {
    expect(ex.parseOPML('<outline text="Folder"><outline youtubeId="UCa"/><outline xmlUrl="x"/></outline>'))
      .toEqual([{ youtube_id: 'UCa', handle: undefined, name: 'Unknown', visibility: 'private', notes: undefined }]);
  });
});

describe('exportJSON', () => {
  it('writes channels with parsed tags and groups', () => {
    const r = ex.exportJSON({ visibility: 'public', filename: 'subs.json' });
    const data = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(r.count).toBe(2);
    expect(data.total_channels).toBe(2);
    expect(data.channels.find((c: any) => c.youtube_id === 'UCtech').tags).toEqual(['dev']);
    expect(data.groups.map((g: any) => g.name)).toEqual(['Dev & Ops', 'Empty']);
  });
});
