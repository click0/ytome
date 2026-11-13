/**
 * Облікові дані не потрапляють у відповіді й логи.
 */
import { describe, it, expect } from 'vitest';
import { redactCredentials, safeErrorMessage } from '../src/redact';

describe('redactCredentials', () => {
  it('hides user:password in any scheme, keeps the rest', () => {
    expect(redactCredentials('socks5://user:p%40ss@10.0.0.1:1080')).toBe('socks5://***@10.0.0.1:1080');
    expect(redactCredentials('http://token@proxy.example:3128/path')).toBe('http://***@proxy.example:3128/path');
    expect(redactCredentials('Command failed: yt-dlp URL --proxy http://a:b@h:1 --quiet'))
      .toBe('Command failed: yt-dlp URL --proxy http://***@h:1 --quiet');
  });

  it('passwords with @, quotes or other symbols are hidden completely', () => {
    expect(redactCredentials('http://user:p@ssw0rd@h:1')).toBe('http://***@h:1');
    expect(redactCredentials("http://user:pa'ss@h")).toBe('http://***@h');
    expect(redactCredentials('http://user:pa"ss@h/x')).toBe('http://***@h/x');
    expect(redactCredentials('see https://example.com/a@b and http://u:p@h')).toBe('see https://example.com/a@b and http://***@h');
  });

  it('API keys and tokens in query strings (googleapis error messages)', () => {
    expect(redactCredentials('request to https://youtube.googleapis.com/youtube/v3/search?part=id&key=AIzaSy123&maxResults=5 failed'))
      .toBe('request to https://youtube.googleapis.com/youtube/v3/search?part=id&key=***&maxResults=5 failed');
    expect(redactCredentials('https://x/y?access_token=abc#f')).toBe('https://x/y?access_token=***#f');
    expect(redactCredentials('https://youtube.com/watch?v=abc&t=1s')).toBe('https://youtube.com/watch?v=abc&t=1s');
  });

  it('leaves URLs without credentials and e-mail addresses alone', () => {
    expect(redactCredentials('https://www.youtube.com/watch?v=x&t=1s')).toBe('https://www.youtube.com/watch?v=x&t=1s');
    expect(redactCredentials('mail me@example.com')).toBe('mail me@example.com');
  });

  it('safeErrorMessage works for errors and non-errors', () => {
    expect(safeErrorMessage(new Error('via https://u:p@h failed'))).toBe('via https://***@h failed');
    expect(safeErrorMessage('plain')).toBe('plain');
    expect(safeErrorMessage(new Error(''))).toBe('Unknown error');
  });
});
