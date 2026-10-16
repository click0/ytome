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
