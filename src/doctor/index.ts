/**
 * Діагностика: що працює, що ні і як виправити.
 *
 * Перевірки справді запускають залежності (yt-dlp, ffmpeg), а не лише шукають
 * файли. Мережеві (ключ YouTube API, проксі, AI-провайдери) — тільки з network: true.
 *
 * MCP-інструмент doctor або з терміналу: npm run doctor [-- --network]
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getDb } from '../db/init';
import { getQuotaStatus, trackQuota } from '../db/quota';
import { checkYtDlp, jsRuntimeArgs, findExecutable, parseYtDlpVersion, JS_RUNTIMES_SINCE } from '../youtube/ytdlp';
import { whisperProvider } from '../youtube/whisper';
import { getYoutube } from '../youtube/api';
import { listProfiles } from '../profiles/manager';
import { parseCookiesFile, validateCookiesFile } from '../profiles/cookies';
import { getProxyMode, listProxies, checkAllProxies } from '../proxy/manager';
import { loadProviderConfigs, checkAllProviders } from '../ai/providers';
import { claudeAvailable, checkClaudeModels } from '../ai/claude';
import { googleAuthAvailable } from '../google/auth';
import { ensureSummarySchema } from '../db/migrate-007';
import { safeErrorMessage } from '../redact';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'error' | 'off';

export interface DoctorCheck {
  area: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  summary: Record<CheckStatus, number>;
  checks: DoctorCheck[];
  network: boolean;
  generated_at: string;
}

const YTDLP_UPGRADE = 'yt-dlp -U   (або: python -m pip install -U "yt-dlp[default]")';
/** yt-dlp старший за стільки днів — YouTube часто вже змінив щось, що він не вміє */
const YTDLP_MAX_AGE_DAYS = 120;

type Check = (network: boolean) => Promise<DoctorCheck | DoctorCheck[]>;

const check = (area: string, status: CheckStatus, message: string, fix?: string): DoctorCheck =>
  ({ area, status, message, ...(fix ? { fix } : {}) });

// =============================================
// Перевірки
// =============================================

const checkNode: Check = async () => {
  const major = parseInt(process.versions.node.split('.')[0]);
  return major >= 20
    ? check('node', 'ok', `Node.js ${process.versions.node}`)
    : check('node', 'error', `Node.js ${process.versions.node} — потрібен 20 або новіший`, 'Онови Node.js до 20+');
};

const checkYtdlp: Check = async () => {
  const yt = await checkYtDlp();
  if (!yt.available) {
    return [
      check('yt-dlp', 'error', 'yt-dlp не знайдено або не запускається — завантаження, субтитри, пошук і Whisper не працюють',
        `Встанови: python -m pip install -U "yt-dlp[default]" (або YTDLP_BIN=<шлях> у .env)`),
    ];
  }
  const out: DoctorCheck[] = [];
  const v = parseYtDlpVersion(yt.version);
  if (!v) {
    out.push(check('yt-dlp', 'warn', `yt-dlp ${yt.version}: не вдалось розібрати версію`, YTDLP_UPGRADE));
  } else {
    const ageDays = Math.floor((Date.now() - Date.UTC(v[0], v[1] - 1, v[2])) / 86_400_000);
    out.push(ageDays > YTDLP_MAX_AGE_DAYS
      ? check('yt-dlp', 'warn', `yt-dlp ${yt.version} — ${ageDays} днів; YouTube регулярно ламає старі версії`, YTDLP_UPGRADE)
      : check('yt-dlp', 'ok', `yt-dlp ${yt.version}`));
  }

  // JS-середовище: без нього YouTube в yt-dlp працює лише частково
  const setting = (process.env.YTDLP_JS_RUNTIME || 'auto').trim();
  const args = jsRuntimeArgs(yt.version);
  const tooOld = !v || v[0] * 10000 + v[1] * 100 + v[2] <
    JS_RUNTIMES_SINCE[0] * 10000 + JS_RUNTIMES_SINCE[1] * 100 + JS_RUNTIMES_SINCE[2];
  if (setting === 'none') {
    out.push(check('js-runtime', 'warn', 'YTDLP_JS_RUNTIME=none — yt-dlp без JS-середовища, частина відео YouTube не завантажиться',
      'Прибери YTDLP_JS_RUNTIME або постав auto'));
  } else if (tooOld) {
    out.push(check('js-runtime', 'warn', `yt-dlp ${yt.version} ще не вміє зовнішні JS-середовища, яких тепер вимагає YouTube`,
      YTDLP_UPGRADE));
  } else if (args.length === 0) {
    out.push(check('js-runtime', 'ok', `deno (${findExecutable('deno')})`));
  } else {
    out.push(check('js-runtime', 'ok', `${args[1]}${setting === 'auto' ? ` (Node ${process.versions.node}, на якому працює ytome)` : ''}`));
  }
  return out;
};

const checkFfmpeg: Check = async () => {
  const bin = process.env.FFMPEG_BIN || 'ffmpeg';
  try {
    const { stdout } = await execFileAsync(bin, ['-version'], { timeout: 15_000 });
    return check('ffmpeg', 'ok', stdout.split('\n')[0].trim());
  } catch {
    return check('ffmpeg', 'warn', 'ffmpeg не знайдено — не працюють аудіо в mp3, злиття відео HD і розпізнавання Whisper',
      'Встанови ffmpeg (apt/brew/pkg install ffmpeg) або вкажи FFMPEG_BIN');
  }
};

const checkYoutubeApi: Check = async (network) => {
  const out: DoctorCheck[] = [];
  if (!process.env.YOUTUBE_API_KEY) {
    out.push(check('youtube-api', 'error', 'YOUTUBE_API_KEY не задано — підписки й синхронізація каналів не працюють',
      'console.cloud.google.com → YouTube Data API v3 → API key → YOUTUBE_API_KEY у .env'));
  } else if (!network) {
    out.push(check('youtube-api', 'ok', 'YOUTUBE_API_KEY задано (перевірка ключа — з network: true)'));
  } else {
    try {
      const yt = await getYoutube();
      await yt.channels.list({ part: ['id'], id: ['UC_x5XG1OV2P6uZZ5FSM9Ttw'] });
      trackQuota('channels.list', 'doctor');
      out.push(check('youtube-api', 'ok', 'Ключ YouTube API працює (1 одиниця квоти)'));
    } catch (e) {
      out.push(check('youtube-api', 'error', `Ключ YouTube API не працює: ${safeErrorMessage(e)}`,
        'Перевір ключ і що YouTube Data API v3 увімкнено в проєкті Google Cloud'));
    }
  }

  const q = getQuotaStatus();
  out.push(q.critical
    ? check('quota', 'error', `Квота сьогодні: ${q.used}/${q.limit} (${q.percent}%) — синхронізація зупиниться`, 'Скидається опівночі UTC')
    : q.warning
      ? check('quota', 'warn', `Квота сьогодні: ${q.used}/${q.limit} (${q.percent}%)`)
      : check('quota', 'ok', `Квота сьогодні: ${q.used}/${q.limit} (${q.percent}%)`));
  return out;
};

const checkStorage: Check = async () => {
  const out: DoctorCheck[] = [];
  const dbPath = process.env.DB_PATH || './storage/archive.db';
  try {
    const db = getDb();
    ensureSummarySchema();
    const version = (db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as any)?.value;
    const channels = (db.prepare('SELECT COUNT(*) AS n FROM channels').get() as any).n;
    const videos = (db.prepare('SELECT COUNT(*) AS n FROM videos').get() as any).n;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('doctor_last_run', datetime('now'))").run();
    const size = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    out.push(check('database', 'ok',
      `${path.resolve(dbPath)}: схема ${version}, ${channels} каналів, ${videos} відео, ${(size / 1024 / 1024).toFixed(1)} МБ`));
  } catch (e) {
    out.push(check('database', 'error', `База даних недоступна: ${safeErrorMessage(e)}`,
      `Перевір DB_PATH і права на запис; ініціалізація: node dist/db/init.js`));
  }

  const storage = process.env.STORAGE_PATH || './storage';
  try {
    fs.mkdirSync(storage, { recursive: true });
    fs.accessSync(storage, fs.constants.W_OK);
    const st = fs.statfsSync(storage);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    out.push(freeGb < 1
      ? check('storage', 'warn', `${path.resolve(storage)}: вільно ${freeGb.toFixed(2)} ГБ — завантаження відео можуть не вміститись`)
      : check('storage', 'ok', `${path.resolve(storage)}: вільно ${freeGb.toFixed(1)} ГБ`));
  } catch (e) {
    out.push(check('storage', 'error', `${path.resolve(storage)} недоступний для запису: ${safeErrorMessage(e)}`,
      'Перевір STORAGE_PATH і права'));
  }
  return out;
};

const checkProfiles: Check = async () => {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    return check('profiles', 'off', 'Профілів немає — транскрипти й завантаження без cookies',
      'Якщо YouTube блокує IP: profile_add з cookies.txt (див. docs, розділ «Профілі»)');
  }
  const now = Date.now() / 1000;
  return profiles.filter(p => p.cookie_path).map(p => {
    const v = validateCookiesFile(p.cookie_path!);
    if (!v.valid) {
      return check(`profile:${p.name}`, 'error', `cookies.txt профілю «${p.name}»: ${v.error}`,
        'Експортуй cookies.txt заново й онови профіль (profile_add з тим самим name)');
    }
    const yt = parseCookiesFile(p.cookie_path!)
      .filter(c => c.domain.includes('youtube.com') || c.domain.includes('google.com'));
    const persistent = yt.filter(c => c.expires > 0);
    const alive = persistent.filter(c => c.expires > now);
    if (persistent.length > 0 && alive.length === 0) {
      return check(`profile:${p.name}`, 'warn', `Усі cookies YouTube профілю «${p.name}» прострочені`,
        'Увійди в YouTube у браузері, експортуй cookies.txt заново й онови профіль');
    }
    const soonest = alive.length ? Math.min(...alive.map(c => c.expires)) : null;
    const days = soonest ? Math.floor((soonest - now) / 86400) : null;
    return days !== null && days < 7
      ? check(`profile:${p.name}`, 'warn', `Частина cookies профілю «${p.name}» спливає за ${days} дн.`, 'Скоро знадобиться новий cookies.txt')
      : check(`profile:${p.name}`, 'ok', `«${p.name}»${p.is_default ? ' (за замовчуванням)' : ''}: ${yt.length} cookies YouTube/Google`);
  });
};

const checkProxies: Check = async (network) => {
  const mode = getProxyMode();
  const proxies = listProxies().filter(p => p.enabled);
  if (mode === 'disabled') return check('proxy', 'off', `Проксі вимкнено (${proxies.length} налаштовано)`);
  if (proxies.length === 0) {
    return check('proxy', mode === 'fallback' ? 'warn' : 'error', `Режим ${mode}, але жодного увімкненого проксі`,
      'proxy_add або proxy_set_mode disabled');
  }
  if (!network) {
    const healthy = proxies.filter(p => p.healthy).length;
    return check('proxy', healthy ? 'ok' : 'error', `Режим ${mode}: ${healthy}/${proxies.length} здорових за останньою перевіркою`,
      healthy ? undefined : 'proxy_test або doctor з network: true');
  }
  const results = await checkAllProxies();
  const ok = results.filter(r => r.ok).length;
  return check('proxy', ok === results.length ? 'ok' : ok ? 'warn' : 'error',
    `Режим ${mode}: відповідають ${ok}/${results.length}`, ok < results.length ? 'Подробиці — proxy_test' : undefined);
};

const checkAi: Check = async (network) => {
  const configs = loadProviderConfigs();
  const enabled = Object.values(configs).filter(c => c.enabled).map(c => c.name as string);
  if (claudeAvailable()) enabled.push('claude');
  const out: DoctorCheck[] = [];
  if (enabled.length === 0) {
    out.push(check('ai', 'warn', 'Жодного AI-провайдера — підсумки й AI-частина оцінки не працюють',
      'Ollama (локально, безкоштовно), GROQ_API_KEY (безкоштовно) або ANTHROPIC_API_KEY'));
  } else if (!network) {
    out.push(check('ai', 'ok', `Налаштовано: ${enabled.join(', ')} (режим ${process.env.BALANCER_MODE || 'cost'}; чи відповідають — network: true)`));
  } else {
    const [providers, claude] = await Promise.all([checkAllProviders(), checkClaudeModels()]);
    const working = [
      ...providers.filter(p => p.ok).map(p => p.name as string),
      ...claude.filter(c => c.ok).map(c => `claude:${c.model}`),
    ];
    const broken = [
      ...providers.filter(p => p.enabled && !p.ok).map(p => `${p.name}: ${p.error}`),
      ...claude.filter(c => !c.ok).map(c => `claude:${c.model}: ${c.error}`),
    ];
    out.push(check('ai', working.length ? (broken.length ? 'warn' : 'ok') : 'error',
      working.length ? `Відповідають: ${working.join(', ')}` : 'Жоден AI-провайдер не відповідає',
      broken.length ? `Не відповідають — ${broken.join('; ')}` : undefined));
  }

  const auto = (getDb().prepare('SELECT COUNT(*) AS n FROM channels WHERE auto_summary = 1').get() as any).n;
  if (auto > 0) {
    out.push(enabled.length && process.env.AUTO_SUMMARY !== 'false'
      ? check('auto-summary', 'ok', `Автопідсумки для ${auto} каналів`)
      : check('auto-summary', 'warn', `Автопідсумки позначені для ${auto} каналів, але ${enabled.length ? 'AUTO_SUMMARY=false' : 'немає AI-провайдера'}`));
  }
  return out;
};

const checkWhisper: Check = async () => {
  const setting = (process.env.WHISPER_PROVIDER || 'off').toLowerCase();
  if (setting === 'groq' || setting === 'openai') {
    const key = setting === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    return process.env[key]
      ? check('whisper', 'ok', `Автоматично для відео без субтитрів: ${setting}`)
      : check('whisper', 'warn', `WHISPER_PROVIDER=${setting}, але ${key} не задано — аудіо не розпізнається`,
        `Додай ${key} або зміни WHISPER_PROVIDER`);
  }
  const explicit = whisperProvider({ explicit: true });
  if (!explicit) {
    return check('whisper', 'off', 'Розпізнавання аудіо недоступне — немає GROQ_API_KEY чи OPENAI_API_KEY',
      'Для відео без субтитрів: GROQ_API_KEY (безкоштовно) у .env');
  }
  return setting === 'auto'
    ? check('whisper', 'ok', `Автоматично для відео без субтитрів: ${explicit}`)
    : check('whisper', 'ok', `Через transcribe_audio (${explicit}); автоматично — WHISPER_PROVIDER=auto`);
};

const checkGoogle: Check = async () => {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile) return check('google', 'off', 'Google Drive / Sheets не налаштовано');
  return googleAuthAvailable()
    ? check('google', 'ok', `Service account: ${keyFile}${process.env.GOOGLE_DRIVE_FOLDER_ID ? '' : ' (без GOOGLE_DRIVE_FOLDER_ID — folder_id у кожному виклику)'}`)
    : check('google', 'error', `Файл ключа не знайдено: ${keyFile}`, 'Перевір GOOGLE_SERVICE_ACCOUNT_KEY_FILE');
};

const CHECKS: Array<[string, Check]> = [
  ['node', checkNode], ['yt-dlp', checkYtdlp], ['ffmpeg', checkFfmpeg], ['youtube-api', checkYoutubeApi],
  ['database', checkStorage], ['profiles', checkProfiles], ['proxy', checkProxies], ['ai', checkAi],
  ['whisper', checkWhisper], ['google', checkGoogle],
];

export async function runDoctor(opts: { network?: boolean } = {}): Promise<DoctorReport> {
  const network = !!opts.network;
  const results = await Promise.all(CHECKS.map(async ([area, fn]) => {
    try {
      const r = await fn(network);
      return Array.isArray(r) ? r : [r];
    } catch (e) {
      return [check(area, 'error', `Перевірка впала: ${safeErrorMessage(e)}`)];
    }
  }));
  const checks = results.flat();
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, error: 0, off: 0 };
  for (const c of checks) summary[c.status]++;
  return { summary, checks, network, generated_at: new Date().toISOString() };
}

const ICON: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️ ', error: '❌', off: '⬜' };

/** Звіт для терміналу */
export function formatReport(r: DoctorReport): string {
  const lines = r.checks.map(c =>
    `${ICON[c.status]} ${c.area.padEnd(18)} ${c.message}${c.fix ? `\n   ${''.padEnd(18)} → ${c.fix}` : ''}`);
  return [...lines, '',
    `ok ${r.summary.ok} · warn ${r.summary.warn} · error ${r.summary.error} · off ${r.summary.off}` +
    (r.network ? '' : '   (мережеві перевірки: --network)')].join('\n');
}

if (require.main === module) {
  runDoctor({ network: process.argv.includes('--network') })
    .then(r => {
      process.stdout.write(formatReport(r) + '\n');
      process.exitCode = r.summary.error > 0 ? 1 : 0;
    })
    .catch(e => {
      process.stderr.write(`doctor failed: ${safeErrorMessage(e)}\n`);
      process.exitCode = 2;
    });
}
