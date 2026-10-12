/**
 * Підсумок транскрипту через AI-балансувальник.
 *
 * Короткий транскрипт — один запит (TL;DR, тези, розділи).
 * Довгий — map-reduce: кожен шматок дає короткий підсумок і розділи
 * з таймкодами, потім зведення підсумків шматків дає TL;DR і тези.
 * Транскрипт подається з мітками [mm:ss], тож розділи мають справжній час.
 */
import { ask, type TaskComplexity } from '../ai/balancer';
import { formatTimestamp } from '../export/transcript';

/** Змінився промпт → старі підсумки вважаються застарілими */
export const PROMPT_VERSION = 1;

export interface Chapter {
  start: number | null;   // секунди; null — транскрипт без таймкодів (yt-dlp)
  title: string;
}

export interface VideoSummary {
  tldr: string;
  key_points: string[];
  chapters: Chapter[];
  language: string;
  provider: string;
}

export interface SummaryInput {
  videoId: string;
  title?: string;
  channel?: string;
  description?: string;
  text: string;
  segments: Array<{ start: number; dur: number; text: string }>;
}

export interface SummaryOptions {
  language?: string;        // мова підсумку (ISO 639-1)
  chunkChars?: number;      // розмір шматка для map-reduce
  complexity?: TaskComplexity;
}

const LANGUAGE_NAMES: Record<string, string> = {
  uk: 'Ukrainian', en: 'English', ru: 'Russian', pl: 'Polish', de: 'German',
  fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', cs: 'Czech',
};

export function summaryLanguage(lang?: string): string {
  return (lang || process.env.SUMMARY_LANGUAGE || 'uk').toLowerCase();
}

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

// =============================================
// Шматки транскрипту
// =============================================

export interface TranscriptChunk {
  start: number | null;
  text: string;             // з мітками [mm:ss], якщо є сегменти
}

/**
 * Ділить транскрипт на шматки ~maxChars. Сегменти групуються в рядки
 * по ~30 с з міткою часу — модель бачить, де що сказано.
 */
export function chunkTranscript(
  t: { text: string; segments: SummaryInput['segments'] },
  maxChars: number,
): TranscriptChunk[] {
  if (t.segments.length === 0) {
    const chunks: TranscriptChunk[] = [];
    let rest = t.text.trim();
    while (rest.length > maxChars) {
      // ріжемо по межі речення або слова, щоб не рвати слова
      let cut = rest.lastIndexOf('. ', maxChars);
      if (cut < maxChars / 2) cut = rest.lastIndexOf(' ', maxChars);
      if (cut <= 0) cut = maxChars;
      chunks.push({ start: null, text: rest.slice(0, cut + 1).trim() });
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push({ start: null, text: rest });
    return chunks;
  }

  // рядки по ~30 секунд
  const lines: Array<{ start: number; text: string }> = [];
  for (const s of t.segments) {
    const last = lines[lines.length - 1];
    if (last && s.start - last.start < 30) last.text += ' ' + s.text.trim();
    else lines.push({ start: s.start, text: s.text.trim() });
  }

  const chunks: TranscriptChunk[] = [];
  let current: TranscriptChunk | null = null;
  for (const line of lines) {
    const rendered = `[${formatTimestamp(line.start)}] ${line.text}`;
    if (current && current.text.length + rendered.length + 1 > maxChars) {
      chunks.push(current);
      current = null;
    }
    if (!current) current = { start: line.start, text: rendered };
    else current.text += '\n' + rendered;
  }
  if (current) chunks.push(current);
  return chunks;
}

// =============================================
// Розбір відповіді моделі
// =============================================

/** JSON з відповіді: прибирає ```json, бере перший {...} */
export function parseJsonReply(text: string): any {
  const clean = text.replace(/```(?:json)?/gi, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI reply contains no JSON object');
  return JSON.parse(clean.slice(start, end + 1));
}

/** "1:02:03" / "02:03" / 123 → секунди */
export function parseTimecode(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/^\[|\]$/g, '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (parseInt(m[1] || '0') * 3600) + parseInt(m[2]) * 60 + parseInt(m[3]);
}

function cleanStrings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string' && x.trim()).map(x => (x as string).trim()).slice(0, max);
}

function cleanChapters(v: unknown, timed: boolean): Chapter[] {
  if (!Array.isArray(v)) return [];
  const out: Chapter[] = [];
  for (const c of v) {
    const title = typeof c?.title === 'string' ? c.title.trim() : '';
    if (!title) continue;
    const start = timed ? parseTimecode(c.time ?? c.start) : null;
    if (timed && start === null) continue;
    out.push({ start, title });
  }
  return out;
}

/** Розділи впорядковані за часом, без дублікатів моментів */
function mergeChapters(chapters: Chapter[]): Chapter[] {
  const seen = new Set<number>();
  return chapters
    .filter(c => c.start === null || (!seen.has(c.start) && seen.add(c.start)))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

// =============================================
// Промпти
// =============================================

function context(input: SummaryInput): string {
  return [
    input.title ? `Title: ${input.title}` : '',
    input.channel ? `Channel: ${input.channel}` : '',
    input.description ? `Description: ${input.description.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');
}

function systemPrompt(lang: string): string {
  return [
    'You summarize YouTube video transcripts.',
    'Use only what is said in the transcript; the title and description are context for names and terms.',
    'Auto-generated captions may lack punctuation and misspell names — infer the meaning, do not invent facts.',
    'Skip sponsor reads, ads and calls to subscribe.',
    `Write all text in ${languageName(lang)}.`,
    'Return ONLY a JSON object, no markdown.',
  ].join(' ');
}

const CHAPTERS_SPEC = (timed: boolean) => timed
  ? '"chapters": [{"time": "mm:ss", "title": "..."}] — where each topic starts, time copied from the [mm:ss] marks'
  : '"chapters": [{"title": "..."}] — main topics in order';

// JSON Schema відповідей — Claude дотримується їх гарантовано (structured outputs)
const str = { type: 'string' };
const strList = { type: 'array', items: str };
const obj = (properties: Record<string, unknown>) =>
  ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const chaptersSchema = (timed: boolean) => ({
  type: 'array', items: timed ? obj({ time: str, title: str }) : obj({ title: str }),
});
const SCHEMAS = {
  full:   (timed: boolean) => obj({ tldr: str, key_points: strList, chapters: chaptersSchema(timed) }),
  chunk:  (timed: boolean) => obj({ summary: str, chapters: chaptersSchema(timed) }),
  reduce: () => obj({ tldr: str, key_points: strList }),
};

async function askSummaryJSON(req: {
  system: string; prompt: string; maxTokens: number; complexity: TaskComplexity; tag: string;
  schema: Record<string, unknown>;
}): Promise<{ data: any; provider: string }> {
  const res = await ask({ ...req, json: true });
  return { data: parseJsonReply(res.text), provider: res.provider };
}

// =============================================
// Головна функція
// =============================================

export async function summarizeTranscript(input: SummaryInput, opts: SummaryOptions = {}): Promise<VideoSummary> {
  const lang = summaryLanguage(opts.language);
  const complexity = opts.complexity || (process.env.SUMMARY_COMPLEXITY as TaskComplexity) || 'medium';
  const chunkChars = opts.chunkChars || parseInt(process.env.SUMMARY_CHUNK_CHARS || '6000');
  const timed = input.segments.length > 0;
  const chunks = chunkTranscript(input, chunkChars);
  if (chunks.length === 0) throw new Error('Transcript is empty');

  const system = systemPrompt(lang);
  const ctx = context(input);

  if (chunks.length === 1) {
    const { data, provider } = await askSummaryJSON({
      system, complexity, tag: 'summary', maxTokens: 900, schema: SCHEMAS.full(timed),
      prompt: `${ctx}\n\nTranscript:\n${chunks[0].text}\n\n` +
        'Return JSON: {"tldr": "2-3 sentences", "key_points": ["5-7 key points"], ' +
        `${CHAPTERS_SPEC(timed)}}`,
    });
    return finish(data, cleanChapters(data.chapters, timed), lang, provider);
  }

  // map: кожен шматок окремо
  const parts: Array<{ summary: string; chapters: Chapter[] }> = [];
  let provider = '';
  for (const [i, chunk] of chunks.entries()) {
    const r = await askSummaryJSON({
      system, complexity, tag: 'summary_chunk', maxTokens: 500, schema: SCHEMAS.chunk(timed),
      prompt: `${ctx}\n\nPart ${i + 1} of ${chunks.length} of the transcript:\n${chunk.text}\n\n` +
        `Return JSON: {"summary": "3-5 sentences about this part", ${CHAPTERS_SPEC(timed)}}`,
    });
    provider = r.provider;
    parts.push({
      summary: typeof r.data.summary === 'string' ? r.data.summary.trim() : '',
      chapters: cleanChapters(r.data.chapters, timed),
    });
  }

  // reduce: TL;DR і тези з підсумків частин
  const { data, provider: reduceProvider } = await askSummaryJSON({
    system, complexity, tag: 'summary', maxTokens: 700, schema: SCHEMAS.reduce(),
    prompt: `${ctx}\n\nSummaries of consecutive parts of the video:\n` +
      parts.map((p, i) => `${i + 1}. ${p.summary}`).join('\n') +
      '\n\nReturn JSON: {"tldr": "2-3 sentences about the whole video", "key_points": ["5-7 key points"]}',
  });
  const chapters = parts.flatMap((p, i) =>
    // без таймкодів розділ частини прив'язуємо до її порядку
    p.chapters.length ? p.chapters : (p.summary ? [{ start: chunks[i].start, title: p.summary.split(/(?<=[.!?])\s/)[0] }] : []));
  return finish(data, chapters, lang, reduceProvider || provider);
}

function finish(data: any, chapters: Chapter[], language: string, provider: string): VideoSummary {
  const tldr = typeof data?.tldr === 'string' ? data.tldr.trim() : '';
  if (!tldr) throw new Error('AI reply has no tldr');
  return {
    tldr,
    key_points: cleanStrings(data.key_points, 10),
    chapters: mergeChapters(chapters).slice(0, 30),
    language,
    provider,
  };
}
