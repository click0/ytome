/**
 * Google Drive: бекап архіву та експорт транскриптів.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { getDriveClient } from './auth';
import { getDb } from '../db/init';
import { getTranscript } from '../db/queries';
import { createLogger } from '../logger';

const log = createLogger('drive');

const DB_PATH = process.env.DB_PATH || './storage/archive.db';

function requireFolderId(folderId?: string): string {
  const id = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!id) {
    throw new Error(
      'No Drive folder ID. Pass folder_id or set GOOGLE_DRIVE_FOLDER_ID in .env. ' +
      'The folder must be shared with the service account email.'
    );
  }
  return id;
}

async function uploadFile(opts: {
  filePath?: string;
  content?: string;
  name: string;
  folderId: string;
  mimeType: string;
}): Promise<{ fileId: string; action: 'created' | 'updated'; link?: string }> {
  const drive = getDriveClient();
  const body = opts.filePath ? fs.createReadStream(opts.filePath) : Readable.from(opts.content!);
  const media = { mimeType: opts.mimeType, body };

  const existing = await drive.files.list({
    q: `name='${opts.name.replace(/'/g, "\\'")}' and '${opts.folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  });

  if (existing.data.files?.length) {
    const fileId = existing.data.files[0].id!;
    await drive.files.update({ fileId, media });
    return { fileId, action: 'updated' };
  }

  const res = await drive.files.create({
    requestBody: { name: opts.name, parents: [opts.folderId] },
    media,
    fields: 'id, webViewLink',
  });
  return { fileId: res.data.id!, action: 'created', link: res.data.webViewLink ?? undefined };
}

/** Бекап archive.db на Drive (з WAL checkpoint перед копіюванням) */
export async function backupDatabase(folderId?: string): Promise<{
  fileId: string; action: string; name: string; sizeBytes: number;
}> {
  const targetFolder = requireFolderId(folderId);

  // Скидаємо WAL у основний файл, потім копіюємо в temp — не вантажимо файл під час запису
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const name = `archive-${stamp}.db`;
  const tmpPath = path.join(os.tmpdir(), name);
  fs.copyFileSync(DB_PATH, tmpPath);

  try {
    const result = await uploadFile({
      filePath: tmpPath,
      name,
      folderId: targetFolder,
      mimeType: 'application/x-sqlite3',
    });
    const sizeBytes = fs.statSync(tmpPath).size;
    log.info({ name, sizeBytes, action: result.action }, 'database backed up to Drive');
    return { ...result, name, sizeBytes };
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

/** Експорт транскрипту відео як .txt на Drive */
export async function exportTranscriptToDrive(videoYoutubeId: string, folderId?: string): Promise<{
  fileId: string; action: string; name: string;
}> {
  const targetFolder = requireFolderId(folderId);

  const transcript = getTranscript(videoYoutubeId);
  if (!transcript) throw new Error(`No cached transcript for ${videoYoutubeId}. Fetch it first.`);

  const video = getDb().prepare(`
    SELECT v.title, c.name AS channel_name FROM videos v
    JOIN channels c ON c.id = v.channel_id WHERE v.youtube_id = ?
  `).get(videoYoutubeId) as any;

  const title = video?.title || videoYoutubeId;
  const header = `${title}\n${video?.channel_name || ''}\nhttps://youtube.com/watch?v=${videoYoutubeId}\n\n`;
  const name = `${videoYoutubeId}.txt`;

  const result = await uploadFile({
    content: header + transcript.text,
    name,
    folderId: targetFolder,
    mimeType: 'text/plain',
  });
  log.info({ videoYoutubeId, action: result.action }, 'transcript exported to Drive');
  return { ...result, name };
}

/** Список файлів у папці бекапів */
export async function listDriveFiles(folderId?: string): Promise<Array<{
  id: string; name: string; size?: string; modifiedTime?: string;
}>> {
  const targetFolder = requireFolderId(folderId);
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: `'${targetFolder}' in parents and trashed=false`,
    fields: 'files(id, name, size, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 50,
  });
  return (res.data.files || []).map(f => ({
    id: f.id!, name: f.name!,
    size: f.size ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
  }));
}
