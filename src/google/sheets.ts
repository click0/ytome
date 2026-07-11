/**
 * Google Sheets: експорт підписок, watch later та статистики.
 */
import { getSheetsClient, getDriveClient } from './auth';
import { getDb } from '../db/init';
import { getChannels } from '../db/queries';
import { getWatchLater } from '../db/queries-v2';
import { getQuotaHistory, getQuotaBreakdown } from '../db/quota';
import { createLogger } from '../logger';

const log = createLogger('sheets');

export type SheetExportType = 'subscriptions' | 'watch_later' | 'stats';

interface SheetData {
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
}

/** Створити або оновити spreadsheet і записати дані */
async function writeSheet(data: SheetData, spreadsheetId?: string): Promise<{
  spreadsheetId: string; url: string; rowCount: number;
}> {
  const sheets = getSheetsClient();

  let id = spreadsheetId;
  if (!id) {
    const created = await sheets.spreadsheets.create({
      requestBody: { properties: { title: data.title } },
      fields: 'spreadsheetId',
    });
    id = created.data.spreadsheetId!;

    const shareWith = process.env.GOOGLE_SHEETS_SHARE_WITH;
    if (shareWith) {
      await getDriveClient().permissions.create({
        fileId: id,
        requestBody: { type: 'user', role: 'writer', emailAddress: shareWith },
      });
    }
  }

  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: 'A:Z' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: 'A1',
    valueInputOption: 'RAW',
    requestBody: { values: [data.headers, ...data.rows] },
  });

  const url = `https://docs.google.com/spreadsheets/d/${id}`;
  return { spreadsheetId: id, url, rowCount: data.rows.length };
}

/** Зберегти/оновити запис про експортовану таблицю */
function trackExport(spreadsheetId: string, type: SheetExportType, url: string, title: string): void {
  getDb().prepare(`
    INSERT INTO sheet_exports (spreadsheet_id, export_type, url, title)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(spreadsheet_id, export_type) DO UPDATE SET
      last_exported = CURRENT_TIMESTAMP
  `).run(spreadsheetId, type, url, title);
}

/** Останній spreadsheet цього типу (для повторного використання) */
function lastExportId(type: SheetExportType): string | undefined {
  const row = getDb().prepare(
    'SELECT spreadsheet_id FROM sheet_exports WHERE export_type = ? ORDER BY last_exported DESC LIMIT 1'
  ).get(type) as any;
  return row?.spreadsheet_id;
}

export async function exportSubscriptionsToSheet(opts: {
  visibility?: 'private' | 'public';
  spreadsheetId?: string;
} = {}) {
  const channels = getChannels(opts.visibility);
  const data: SheetData = {
    title: 'ytome — Subscriptions',
    headers: ['Name', 'Handle', 'YouTube ID', 'Subscribers', 'Videos', 'Visibility', 'Notes', 'Last Checked', 'URL'],
    rows: channels.map((c: any) => [
      c.name, c.handle, c.youtube_id, c.subscriber_count, c.video_count,
      c.visibility, c.notes, c.last_checked_at,
      `https://youtube.com/channel/${c.youtube_id}`,
    ]),
  };
  const result = await writeSheet(data, opts.spreadsheetId || lastExportId('subscriptions'));
  trackExport(result.spreadsheetId, 'subscriptions', result.url, data.title);
  log.info({ rows: result.rowCount }, 'subscriptions exported to Sheets');
  return result;
}

export async function exportWatchLaterToSheet(opts: {
  status?: 'pending' | 'done' | 'skipped' | 'all';
  spreadsheetId?: string;
} = {}) {
  const items = getWatchLater({ status: opts.status || 'all' });
  const data: SheetData = {
    title: 'ytome — Watch Later',
    headers: ['Title', 'Channel', 'Priority', 'Status', 'Duration (s)', 'Tags', 'Note', 'Added', 'URL'],
    rows: items.map(i => [
      i.title, i.channel_name, i.priority, i.status, i.duration_sec,
      i.tags?.join(', ') ?? null, i.note, i.added_at, i.url,
    ]),
  };
  const result = await writeSheet(data, opts.spreadsheetId || lastExportId('watch_later'));
  trackExport(result.spreadsheetId, 'watch_later', result.url, data.title);
  log.info({ rows: result.rowCount }, 'watch later exported to Sheets');
  return result;
}

export async function exportStatsToSheet(opts: {
  days?: number;
  spreadsheetId?: string;
} = {}) {
  const history = getQuotaHistory(opts.days || 30);
  const breakdown = getQuotaBreakdown();
  const data: SheetData = {
    title: 'ytome — API Usage Stats',
    headers: ['Date', 'Units Used', 'Percent of Limit', '', 'Operation (today)', 'Calls', 'Units'],
    rows: history.map((h, i) => [
      h.date, h.total_used, `${h.percent}%`, '',
      breakdown[i]?.operation ?? '', breakdown[i]?.calls ?? '', breakdown[i]?.total_units ?? '',
    ]),
  };
  const result = await writeSheet(data, opts.spreadsheetId || lastExportId('stats'));
  trackExport(result.spreadsheetId, 'stats', result.url, data.title);
  log.info({ rows: result.rowCount }, 'stats exported to Sheets');
  return result;
}

export function listSheetExports() {
  return getDb().prepare(
    'SELECT * FROM sheet_exports ORDER BY last_exported DESC'
  ).all() as any[];
}
