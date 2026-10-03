/**
 * Тести скриптів CI/релізу: версії й опис релізу з CHANGELOG
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs без декларацій типів
import { normalizeVersion, findDocVersions, checkVersions } from '../scripts/check-version.mjs';
// @ts-expect-error — .mjs без декларацій типів
import { extractSection, isReplaceable, render, MARKER } from '../scripts/release-notes.mjs';

describe('normalizeVersion', () => {
  it('pads short tags to semver', () => {
    expect(normalizeVersion('v0.85')).toBe('0.85.0');
    expect(normalizeVersion('0.85.0')).toBe('0.85.0');
    expect(normalizeVersion('v1')).toBe('1.0.0');
  });
});

describe('findDocVersions', () => {
  it('finds project versions but ignores unrelated ones (nvm etc.)', () => {
    const text = '**License:** BSD 3-Clause · v0.85 · 2026\ncurl nvm/v0.40.3/install.sh\n*ytome v0.85 · BSD*';
    expect(findDocVersions(text)).toEqual(['0.85', '0.85']);
  });
});

describe('checkVersions', () => {
  const pkg = { version: '0.85.0' };
  const lock = { version: '0.85.0', packages: { '': { version: '0.85.0' } } };
  const docs = { 'README.md': '*ytome v0.85 ·*' };

  it('passes when everything agrees', () => {
    expect(checkVersions({ pkg, lock, docs })).toEqual([]);
  });

  it('accepts short and full tags', () => {
    expect(checkVersions({ pkg, lock, docs, tag: 'v0.85' })).toEqual([]);
    expect(checkVersions({ pkg, lock, docs, tag: 'v0.85.0' })).toEqual([]);
  });

  it('reports a stale lockfile, stale docs and a wrong tag', () => {
    const errors = checkVersions({
      pkg,
      lock: { version: '0.80.0', packages: { '': { version: '0.80.0' } } },
      docs: { 'README.md': '*ytome v0.80 ·*' },
      tag: 'v0.90',
    });
    expect(errors).toHaveLength(4);
    expect(errors.join('\n')).toMatch(/package-lock.*0\.80\.0/);
    expect(errors.join('\n')).toMatch(/README\.md mentions v0\.80/);
    expect(errors.join('\n')).toMatch(/tag v0\.90/);
  });
});

const CHANGELOG = `# Changelog

## [Unreleased]
- in progress

## [0.90.0] - 2026-10-10
### Added
- library export

## [0.85.0] - 2026-07-11
- profiles

[0.90.0]: https://github.com/click0/ytome/compare/v0.85...v0.90
[0.85.0]: https://github.com/click0/ytome/compare/v0.75...v0.85
`;

describe('extractSection', () => {
  it('returns only the requested version, without link references', () => {
    expect(extractSection(CHANGELOG, '0.90.0')).toBe('### Added\n- library export');
    expect(extractSection(CHANGELOG, '0.85.0')).toBe('- profiles');
  });

  it('returns empty for a version without a section', () => {
    expect(extractSection(CHANGELOG, '0.95.0')).toBe('');
  });

  it('does not mistake 0.9.0 for 0.90.0', () => {
    expect(extractSection(CHANGELOG, '0.9.0')).toBe('');
  });
});

describe('isReplaceable', () => {
  it('replaces empty and GitHub-generated descriptions', () => {
    expect(isReplaceable('')).toBe(true);
    expect(isReplaceable('**Full Changelog**: https://github.com/a/b/compare/v1...v2')).toBe(true);
    expect(isReplaceable("## What's Changed\n* x by @y in #1\n\n**Full Changelog**: https://x/compare/a...b")).toBe(true);
  });

  it('replaces its own previous output', () => {
    expect(isReplaceable(`${MARKER}\n\n- old notes`)).toBe(true);
  });

  it('keeps a description written by hand', () => {
    expect(isReplaceable('## Highlights\n\nHand-written text')).toBe(false);
  });
});

describe('render', () => {
  it('adds marker and compare link', () => {
    const out = render({ section: '- a', since: 'v0.85', tag: 'v0.90', repo: 'click0/ytome' });
    expect(out.startsWith(MARKER)).toBe(true);
    expect(out).toContain('https://github.com/click0/ytome/compare/v0.85...v0.90');
  });
});
