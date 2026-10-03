/**
 * Опис релізу з CHANGELOG.md — розділ «## [X.Y.Z]» поточної версії.
 *
 *   node scripts/release-notes.mjs --version 0.90.0 [--since v0.85] [--repo owner/repo] \
 *        [--tag v0.90] --output release-notes.md
 *   node scripts/release-notes.mjs --check-replaceable body.md   # exit 0 = можна замінити
 *
 * Релізи створюються й через веб-форму GitHub. Пайплайн замінює опис лише
 * якщо він порожній або згенерований (GitHub чи цим скриптом) — текст,
 * написаний вручну, лишається.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- release-notes: generated from CHANGELOG.md -->';

/** Розділ версії: від «## [version]» до наступного «## [», без рядків-посилань «[x]: url» */
export function extractSection(changelog, version) {
  const short = version.replace(/\.0$/, '');            // 0.90.0 → 0.90 (теги у форматі vX.Y)
  const heads = [`## [${version}]`, `## [${short}]`];
  const out = [];
  let inside = false;
  for (const line of changelog.split('\n')) {
    if (line.startsWith('## [')) {
      if (inside) break;
      inside = heads.some(h => line.startsWith(h));
      continue;
    }
    if (inside && !/^\[[^\]]+\]:\s+\S+/.test(line)) out.push(line);
  }
  return out.join('\n').trim();
}

/** Порожній опис, згенерований GitHub («What's Changed» / «Full Changelog») або цим скриптом */
export function isReplaceable(body) {
  const text = (body || '').replace(/\r\n/g, '\n').trim();
  if (!text || text.includes(MARKER)) return true;
  return /^(## What's Changed\n[\s\S]*?)?(\*\*Full Changelog\*\*: \S+)?$/.test(text);
}

export function render({ section, since, tag, repo }) {
  const parts = [MARKER, section];
  if (since && tag && repo) {
    parts.push(`**Full Changelog**: https://github.com/${repo}/compare/${since}...${tag}`);
  }
  return parts.join('\n\n') + '\n';
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);

  const bodyFile = arg(argv, '--check-replaceable');
  if (bodyFile) process.exit(isReplaceable(readFileSync(bodyFile, 'utf8')) ? 0 : 3);

  const version = arg(argv, '--version');
  const output = arg(argv, '--output');
  if (!version || !output) {
    console.error('usage: release-notes.mjs --version X.Y.Z --output FILE [--since TAG --tag TAG --repo OWNER/REPO]');
    process.exit(2);
  }

  const section = extractSection(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (!section) {
    // Реліз без опису гірший за впалий пайплайн
    console.error(`::error::CHANGELOG.md has no '## [${version}]' section`);
    process.exit(1);
  }
  writeFileSync(output, render({
    section, since: arg(argv, '--since'), tag: arg(argv, '--tag'), repo: arg(argv, '--repo'),
  }));
  console.log(`release notes for ${version} → ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
