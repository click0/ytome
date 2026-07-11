/**
 * Профілі — браузерні сесії / Google-акаунти.
 *
 * Кожен профіль може мати власний cookies.txt (для транскриптів
 * та yt-dlp) і власний YouTube API key (окрема квота).
 * Канал прив'язується до профілю через channels.profile_id.
 */
import { getDb } from '../db/init';
import { validateCookiesFile, buildCookieHeader } from './cookies';

export interface Profile {
  id: number;
  name: string;
  youtube_api_key: string | null;
  cookie_path: string | null;
  is_default: boolean;
  enabled: boolean;
  created_at: string;
  last_used_at: string | null;
  notes: string | null;
}

function rowToProfile(r: any): Profile {
  return {
    ...r,
    is_default: !!r.is_default,
    enabled: !!r.enabled,
  };
}

export function addProfile(input: {
  name: string;
  youtubeApiKey?: string;
  cookiePath?: string;
  notes?: string;
}): Profile {
  if (input.cookiePath) {
    const check = validateCookiesFile(input.cookiePath);
    if (!check.valid) throw new Error(`Invalid cookies file: ${check.error}`);
  }

  const row = getDb().prepare(`
    INSERT INTO profiles (name, youtube_api_key, cookie_path, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      youtube_api_key = excluded.youtube_api_key,
      cookie_path     = excluded.cookie_path,
      notes           = excluded.notes
    RETURNING *
  `).get(
    input.name,
    input.youtubeApiKey || null,
    input.cookiePath || null,
    input.notes || null,
  ) as any;

  return rowToProfile(row);
}

export function removeProfile(id: number): void {
  const db = getDb();
  db.prepare('UPDATE channels SET profile_id = NULL WHERE profile_id = ?').run(id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

export function listProfiles(): Profile[] {
  return (getDb().prepare('SELECT * FROM profiles ORDER BY is_default DESC, name').all() as any[])
    .map(rowToProfile);
}

export function getProfile(idOrName: number | string): Profile | null {
  const row = typeof idOrName === 'number'
    ? getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(idOrName)
    : getDb().prepare('SELECT * FROM profiles WHERE name = ?').get(idOrName);
  return row ? rowToProfile(row) : null;
}

export function getDefaultProfile(): Profile | null {
  const row = getDb().prepare('SELECT * FROM profiles WHERE is_default = 1 AND enabled = 1').get();
  return row ? rowToProfile(row) : null;
}

export function setDefaultProfile(id: number): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('UPDATE profiles SET is_default = 0').run();
    db.prepare('UPDATE profiles SET is_default = 1 WHERE id = ?').run(id);
  });
  tx();
}

export function markProfileUsed(id: number): void {
  getDb().prepare('UPDATE profiles SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

/** Профіль каналу (через channels.profile_id), або default, або null */
export function resolveProfileForChannel(channelYoutubeId: string): Profile | null {
  const row = getDb().prepare(`
    SELECT p.* FROM profiles p
    JOIN channels c ON c.profile_id = p.id
    WHERE c.youtube_id = ? AND p.enabled = 1
  `).get(channelYoutubeId) as any;
  return row ? rowToProfile(row) : getDefaultProfile();
}

/** Cookie-заголовок профілю, або порожній рядок */
export function getProfileCookieHeader(profile: Profile | null): string {
  if (!profile?.cookie_path) return '';
  try {
    return buildCookieHeader(profile.cookie_path);
  } catch {
    return '';
  }
}

export function assignChannelProfile(channelYoutubeId: string, profileId: number | null): boolean {
  const res = getDb().prepare('UPDATE channels SET profile_id = ? WHERE youtube_id = ?')
    .run(profileId, channelYoutubeId);
  return res.changes > 0;
}
