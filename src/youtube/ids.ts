/**
 * ID відео YouTube: рівно 11 символів [A-Za-z0-9_-].
 *
 * Значення без перевірки потрапляло в https://www.youtube.com/watch?v=${id};
 * "&list=UU…" перетворювало це на завантаження всього плейлиста каналу
 * (yt-dlp ігнорує --no-playlist, коли v порожній).
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const IN_URL = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|\/v\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

export function isVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

/** ID з ID або URL відео; null — якщо це не відео YouTube */
export function extractVideoId(input: string): string | null {
  const v = input.trim();
  if (VIDEO_ID.test(v)) return v;
  const m = v.match(IN_URL);
  return m ? m[1] : null;
}

/** Для коду, що отримує ID ззовні: кидає, якщо ID некоректний */
export function assertVideoId(value: string): string {
  if (!VIDEO_ID.test(value)) throw new Error(`Invalid YouTube video ID: ${JSON.stringify(value.slice(0, 40))}`);
  return value;
}
