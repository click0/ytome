/**
 * Версія узгоджена всюди: package.json ↔ package-lock.json ↔ README/docs,
 * а з --tag — ще й тег релізу (v0.85 або v0.85.0 для версії 0.85.0).
 *
 *   node scripts/check-version.mjs
 *   node scripts/check-version.mjs --tag v0.90
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 0.85 → 0.85.0; v0.85.0 → 0.85.0 */
export function normalizeVersion(v) {
  const parts = String(v).replace(/^v/, '').split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

/** Версії, згадані в документації: «ytome v0.85» і «· v0.85 ·» (не nvm v0.40.3 тощо) */
export function findDocVersions(text) {
  const found = [];
  for (const re of [/\bytome v(\d+\.\d+(?:\.\d+)?)/g, /BSD 3-Clause · v(\d+\.\d+(?:\.\d+)?)/g]) {
    for (const m of text.matchAll(re)) found.push(m[1]);
  }
  return found;
}

export function checkVersions({ pkg, lock, docs, tag }) {
  const errors = [];
  const version = pkg.version;
  const majorMinor = version.split('.').slice(0, 2).join('.');

  if (lock.version !== version) errors.push(`package-lock.json version ${lock.version} != package.json ${version}`);
  const lockRoot = lock.packages?.['']?.version;
  if (lockRoot !== version) errors.push(`package-lock.json packages[""] ${lockRoot} != package.json ${version}`);

  for (const [file, text] of Object.entries(docs)) {
    for (const v of findDocVersions(text)) {
      if (normalizeVersion(v) !== normalizeVersion(majorMinor) && normalizeVersion(v) !== version) {
        errors.push(`${file} mentions v${v}, package.json is ${version}`);
      }
    }
  }

  if (tag && normalizeVersion(tag) !== version) {
    errors.push(`tag ${tag} != package.json ${version}`);
  }
  return errors;
}

function main() {
  const argv = process.argv.slice(2);
  const tagIdx = argv.indexOf('--tag');
  const tag = tagIdx >= 0 ? argv[tagIdx + 1] : undefined;

  const read = f => readFileSync(f, 'utf8');
  const docs = Object.fromEntries(
    ['README.md', 'docs/README.en.md', 'docs/README.uk.md'].map(f => [f, read(f)])
  );
  const pkg = JSON.parse(read('package.json'));
  const errors = checkVersions({ pkg, lock: JSON.parse(read('package-lock.json')), docs, tag });

  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(`version ${pkg.version} consistent${tag ? ` with tag ${tag}` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
