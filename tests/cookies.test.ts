/**
 * Тести парсера cookies.txt (Netscape format)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseCookiesFile, buildCookieHeader, validateCookiesFile } from '../src/profiles/cookies';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ytome-cookies-'));

const FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
const PAST   = Math.floor(Date.now() / 1000) - 86400;

const VALID_COOKIES = `# Netscape HTTP Cookie File
# https://curl.se/docs/http-cookies.html

.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tSID\tabc123
.youtube.com\tTRUE\t/\tTRUE\t${FUTURE}\tHSID\tdef456
.google.com\tTRUE\t/\tTRUE\t${FUTURE}\tNID\tggg789
.youtube.com\tTRUE\t/\tTRUE\t${PAST}\tEXPIRED\told
.example.com\tTRUE\t/\tFALSE\t${FUTURE}\tOTHER\txyz
`;

let validPath: string;
let emptyPath: string;
let noYtPath: string;

beforeAll(() => {
  validPath = path.join(TMP_DIR, 'valid.txt');
  emptyPath = path.join(TMP_DIR, 'empty.txt');
  noYtPath  = path.join(TMP_DIR, 'noyt.txt');
  fs.writeFileSync(validPath, VALID_COOKIES);
  fs.writeFileSync(emptyPath, '# just comments\n');
  fs.writeFileSync(noYtPath, `.example.com\tTRUE\t/\tFALSE\t${FUTURE}\tFOO\tbar\n`);
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('parseCookiesFile', () => {
  it('parses all valid cookie lines', () => {
    const cookies = parseCookiesFile(validPath);
    expect(cookies).toHaveLength(5);
  });

  it('skips comments and empty lines', () => {
    const cookies = parseCookiesFile(validPath);
    expect(cookies.every(c => c.name && c.value)).toBe(true);
  });

  it('parses fields correctly', () => {
    const sid = parseCookiesFile(validPath).find(c => c.name === 'SID');
    expect(sid).toMatchObject({
      domain: '.youtube.com',
      path: '/',
      secure: true,
      value: 'abc123',
    });
  });
});

describe('buildCookieHeader', () => {
  it('includes only youtube.com cookies by default', () => {
    const header = buildCookieHeader(validPath);
    expect(header).toContain('SID=abc123');
    expect(header).toContain('HSID=def456');
    expect(header).not.toContain('NID');
    expect(header).not.toContain('OTHER');
  });

  it('excludes expired cookies', () => {
    const header = buildCookieHeader(validPath);
    expect(header).not.toContain('EXPIRED');
  });

  it('formats as name=value pairs joined by semicolons', () => {
    const header = buildCookieHeader(validPath);
    expect(header).toBe('SID=abc123; HSID=def456');
  });

  it('supports custom domain', () => {
    const header = buildCookieHeader(validPath, 'google.com');
    expect(header).toBe('NID=ggg789');
  });
});

describe('validateCookiesFile', () => {
  it('accepts a valid file', () => {
    const result = validateCookiesFile(validPath);
    expect(result.valid).toBe(true);
    expect(result.cookieCount).toBe(5);
  });

  it('rejects a missing file', () => {
    const result = validateCookiesFile('/nonexistent/cookies.txt');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects a file without cookies', () => {
    const result = validateCookiesFile(emptyPath);
    expect(result.valid).toBe(false);
  });

  it('rejects a file without youtube/google cookies', () => {
    const result = validateCookiesFile(noYtPath);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('youtube');
  });
});
