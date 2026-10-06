/**
 * Google Drive (бекап БД, транскрипти, список) і Sheets (експорти) —
 * googleapis підмінено, БД справжня.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { useTempStorage, initTestDb, seedChannel, seedVideo, cleanup } from './helpers/temp-db';

const g = vi.hoisted(() => {
  const drive = {
    files: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
    permissions: { create: vi.fn() },
  };
  const sheets = {
    spreadsheets: { create: vi.fn(), values: { clear: vi.fn(), update: vi.fn() } },
  };
  return {
    drive, sheets,
    GoogleAuth: vi.fn(function (this: any, opts: any) { this.opts = opts; }),
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: g.GoogleAuth },
    drive: () => g.drive,
    sheets: () => g.sheets,
    youtube: () => ({}),
  },
}));

const { tmp } = useTempStorage('google');
const keyFile = path.join(tmp, 'sa.json');

let auth: typeof import('../src/google/auth');
let drive: typeof import('../src/google/drive');
let sheets: typeof import('../src/google/sheets');
let init: Awaited<ReturnType<typeof initTestDb>>;

/** Вміст завантаженого файлу (media.body — потік) */
async function bodyText(media: { body: NodeJS.ReadableStream }): Promise<string> {
  let s = '';
  for await (const chunk of media.body) s += chunk.toString();
  return s;
}

beforeAll(async () => {
  init = await initTestDb();
  auth = await import('../src/google/auth');
  drive = await import('../src/google/drive');
  sheets = await import('../src/google/sheets');

  const db = init.getDb();
  const ch = seedChannel(db, { youtube_id: 'UCg', name: 'Gee', handle: '@gee', visibility: 'public' });
  seedVideo(db, ch, { youtube_id: 'vidGoogle01', title: 'Drive video', published_at: '2026-10-01T00:00:00Z' });
  const q = await import('../src/db/queries');
  q.saveTranscriptForVideo('vidGoogle01', { text: 'Full text', segments: [{ start: 1, dur: 1, text: 'Full text' }], language: 'en' });
});

afterAll(() => cleanup(tmp, init.closeDb));

beforeEach(() => {
  for (const fn of [g.drive.files.list, g.drive.files.create, g.drive.files.update, g.drive.permissions.create,
    g.sheets.spreadsheets.create, g.sheets.spreadsheets.values.clear, g.sheets.spreadsheets.values.update]) fn.mockReset();
  delete process.env.GOOGLE_DRIVE_FOLDER_ID;
  delete process.env.GOOGLE_SHEETS_SHARE_WITH;
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
});

describe('auth', () => {
  it('is unavailable without a key file and explains how to set it up', () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    expect(auth.googleAuthAvailable()).toBe(false);
    expect(() => auth.getGoogleAuth()).toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY_FILE not set/);
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    expect(auth.googleAuthAvailable()).toBe(false);
    expect(() => auth.getGoogleAuth()).toThrow(/key file not found/);
  });

  it('creates one GoogleAuth with Drive + Sheets scopes', () => {
    fs.writeFileSync(keyFile, '{}');
    expect(auth.googleAuthAvailable()).toBe(true);
    const a = auth.getGoogleAuth();
    expect(auth.getGoogleAuth()).toBe(a);
    expect(g.GoogleAuth).toHaveBeenCalledTimes(1);
    expect((a as any).opts).toEqual({
      keyFile, scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets'],
    });
  });
});

describe('Drive', () => {
  it('requires a folder id', async () => {
    await expect(drive.listDriveFiles()).rejects.toThrow(/No Drive folder ID/);
  });

  it('backupDatabase uploads a checkpointed copy of the DB and removes the temp file', async () => {
    g.drive.files.list.mockResolvedValueOnce({ data: { files: [] } });
    let uploaded = '';
    g.drive.files.create.mockImplementationOnce(async (req: any) => {
      uploaded = await bodyText(req.media);
      return { data: { id: 'F1', webViewLink: 'https://drive/F1' } };
    });

    const r = await drive.backupDatabase('FOLDER');
    expect(r).toMatchObject({ fileId: 'F1', action: 'created', link: 'https://drive/F1' });
    expect(r.name).toMatch(/^archive-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/);
    expect(r.sizeBytes).toBe(fs.statSync(process.env.DB_PATH!).size);
    expect(uploaded.startsWith('SQLite format 3')).toBe(true);
    expect(g.drive.files.create.mock.calls[0][0].requestBody).toEqual({ name: r.name, parents: ['FOLDER'] });
  });

  it('exportTranscriptToDrive updates an existing file; the query is escaped', async () => {
    process.env.GOOGLE_DRIVE_FOLDER_ID = "it's";
    g.drive.files.list.mockResolvedValueOnce({ data: { files: [{ id: 'OLD' }] } });
    let uploaded = '';
    g.drive.files.update.mockImplementationOnce(async (req: any) => { uploaded = await bodyText(req.media); return {}; });

    expect(await drive.exportTranscriptToDrive('vidGoogle01'))
      .toEqual({ fileId: 'OLD', action: 'updated', name: 'vidGoogle01.txt' });
    expect(g.drive.files.list.mock.calls[0][0].q).toBe("name='vidGoogle01.txt' and 'it\\'s' in parents and trashed=false");
    expect(uploaded).toBe('Drive video\nGee\nhttps://youtube.com/watch?v=vidGoogle01\n\nFull text\n');
  });

  it('exportTranscriptToDrive needs a cached transcript', async () => {
    await expect(drive.exportTranscriptToDrive('noTranscr01', 'F')).rejects.toThrow(/No cached transcript/);
  });

  it('listDriveFiles maps file metadata', async () => {
    g.drive.files.list.mockResolvedValueOnce({ data: { files: [
      { id: 'a', name: 'archive.db', size: '1024', modifiedTime: '2026-10-01T00:00:00Z' }, { id: 'b', name: 'x.txt' },
    ] } });
    expect(await drive.listDriveFiles('F')).toEqual([
      { id: 'a', name: 'archive.db', size: '1024', modifiedTime: '2026-10-01T00:00:00Z' },
      { id: 'b', name: 'x.txt', size: undefined, modifiedTime: undefined },
    ]);
    expect(g.drive.files.list.mock.calls[0][0]).toMatchObject({ q: "'F' in parents and trashed=false", orderBy: 'modifiedTime desc' });
  });
});

describe('Sheets', () => {
  const written = () => g.sheets.spreadsheets.values.update.mock.calls.at(-1)![0].requestBody.values;

  it('creates a spreadsheet, shares it, writes rows and remembers it for next time', async () => {
    process.env.GOOGLE_SHEETS_SHARE_WITH = 'me@example.com';
    g.sheets.spreadsheets.create.mockResolvedValueOnce({ data: { spreadsheetId: 'S1' } });

    const r = await sheets.exportSubscriptionsToSheet();
    expect(r).toEqual({ spreadsheetId: 'S1', url: 'https://docs.google.com/spreadsheets/d/S1', rowCount: 1 });
    expect(g.drive.permissions.create).toHaveBeenCalledWith({
      fileId: 'S1', requestBody: { type: 'user', role: 'writer', emailAddress: 'me@example.com' },
    });
    expect(g.sheets.spreadsheets.values.clear).toHaveBeenCalledWith({ spreadsheetId: 'S1', range: 'A:Z' });
    expect(written()[0][0]).toBe('Name');
    expect(written()[1]).toEqual(['Gee', '@gee', 'UCg', null, null, 'public', null, null, 'https://youtube.com/channel/UCg']);

    await sheets.exportSubscriptionsToSheet({ visibility: 'private' });
    expect(g.sheets.spreadsheets.create).toHaveBeenCalledTimes(1); // повторно — той самий S1
    expect(written()).toHaveLength(1);                             // лише заголовок
    expect(sheets.listSheetExports()).toEqual([expect.objectContaining({ spreadsheet_id: 'S1', export_type: 'subscriptions' })]);
  });

  it('watch later export', async () => {
    const { addToWatchLater } = await import('../src/db/queries-v2');
    addToWatchLater('vidGoogle01', { tags: ['a', 'b'], note: 'n' });
    const r = await sheets.exportWatchLaterToSheet({ spreadsheetId: 'S2' });
    expect(r.spreadsheetId).toBe('S2');
    expect(g.sheets.spreadsheets.create).not.toHaveBeenCalled();
    expect(written()[1]).toEqual(expect.arrayContaining(['Drive video', 'Gee', 'medium', 'pending', 'a, b', 'n']));
  });

  it('stats export keeps every breakdown row even with a single day of history', async () => {
    const { trackQuota } = await import('../src/db/quota');
    trackQuota('search.list');
    trackQuota('videos.list');
    trackQuota('commentThreads.list');
    g.sheets.spreadsheets.create.mockResolvedValueOnce({ data: { spreadsheetId: 'S3' } });

    await sheets.exportStatsToSheet({ days: 7 });
    const rows = written().slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([expect.any(String), 102, '1%', '', 'search.list', 1, 100]);
    expect(rows.map((r: any[]) => r[4])).toEqual(['search.list', 'videos.list', 'commentThreads.list']);
    expect(rows[2].slice(0, 3)).toEqual(['', '', '']);
  });
});
