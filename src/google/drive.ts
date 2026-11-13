/**
 * Google Drive: бекап архіву та експорт транскриптів.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { getDriveClient } from './auth';
import Database from 'better-sqlite3';
import { getDb } from '../db/init';
import { redactCredentials } from '../redact';
import { getTranscript } from '../db/queries';
import { formatTranscript, lookupVideoMeta } from '../export/transcript';
import { createLogger } from '../logger';

const log = createLogger('drive');


/** Значення в лапках для мови запитів Drive (q) */
function driveQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Папки, куди дозволено вивантажувати: GOOGLE_DRIVE_FOLDER_ID + GOOGLE_DRIVE_ALLOWED_FOLDERS */
function allowedFolders(): Set<string> {
  return new Set([process.env.GOOGLE_DRIVE_FOLDER_ID, ...(process.env.GOOGLE_DRIVE_ALLOWED_FOLDERS || '').split(',')]
    .map(f => f?.trim()).filter((f): f is string => !!f));
}

/**
 * Папка призначення. folder_id з виклику інструмента приймається лише зі списку
 * дозволених: інакше текст у відео/транскрипті міг би змусити модель вивантажити
 * архів у чужу папку.
 */
function requireFolderId(folderId?: string): string {
  const id = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!id) {
    throw new Error(
      'No Drive folder ID. Set GOOGLE_DRIVE_FOLDER_ID in .env. ' +
      'The folder must be shared with the service account email.'
    );
  }
  if (folderId && !allowedFolders().has(folderId)) {
    throw new Error(
      `Drive folder ${folderId} is not allowed. Use GOOGLE_DRIVE_FOLDER_ID or add it to GOOGLE_DRIVE_ALLOWED_FOLDERS in .env`
    );
  }
  return id;
}

/**
 * Копія БД для бекапу: консистентний знімок (backup API, не копіювання файла
 * під час запису) у приватній теці (0700/0600), без секретів — ключів API
 * профілів і паролів проксі; VACUUM прибирає їх і з вільних сторінок.
 */
async function snapshotWithoutSecrets(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await getDb().backup(file);
  fs.chmodSync(file, 0o600);
  const copy = new Database(file);
  try {
    const has = (t: string) => !!copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (has('profiles')) copy.prepare('UPDATE profiles SET youtube_api_key = NULL').run();
    if (has('proxies')) {
      const rows = copy.prepare('SELECT id, url FROM proxies').all() as Array<{ id: number; url: string }>;
      const upd = copy.prepare('UPDATE proxies SET username = NULL, password = NULL, url = ? WHERE id = ?');
      for (const r of rows) upd.run(redactCredentials(r.url), r.id);
    }
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
  return file;
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
    q: `name='${driveQuote(opts.name)}' and '${driveQuote(opts.folderId)}' in parents and trashed=false`,
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

/** Бекап archive.db на Drive — знімок без секретів */
export async function backupDatabase(folderId?: string): Promise<{
  fileId: string; action: string; name: string; sizeBytes: number; secrets_removed: boolean;
}> {
  const targetFolder = requireFolderId(folderId);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const name = `archive-${stamp}.db`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytome-backup-'));

  try {
    const tmpPath = await snapshotWithoutSecrets(dir, name);
    const result = await uploadFile({
      filePath: tmpPath,
      name,
      folderId: targetFolder,
      mimeType: 'application/x-sqlite3',
    });
    const sizeBytes = fs.statSync(tmpPath).size;
    log.info({ name, sizeBytes, action: result.action }, 'database backed up to Drive');
    return { ...result, name, sizeBytes, secrets_removed: true };
  } finally {
    // Windows: потік завантаження може ще тримати файл (EBUSY) — повторюємо
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Експорт транскрипту відео як .txt на Drive */
export async function exportTranscriptToDrive(videoYoutubeId: string, folderId?: string): Promise<{
  fileId: string; action: string; name: string;
}> {
  const targetFolder = requireFolderId(folderId);

  const transcript = getTranscript(videoYoutubeId);
  if (!transcript) throw new Error(`No cached transcript for ${videoYoutubeId}. Fetch it first.`);

  const segments = typeof transcript.segments === 'string' ? JSON.parse(transcript.segments) : [];
  const content = formatTranscript(
    videoYoutubeId, { text: transcript.text, segments }, await lookupVideoMeta(videoYoutubeId),
  );
  const name = `${videoYoutubeId}.txt`;

  const result = await uploadFile({
    content,
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
    q: `'${driveQuote(targetFolder)}' in parents and trashed=false`,
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
