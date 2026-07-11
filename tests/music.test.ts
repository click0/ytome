/**
 * Тести YouTube Music хелперів
 */
import { describe, it, expect } from 'vitest';
import { extractPlaylistId } from '../src/youtube/music';

describe('extractPlaylistId', () => {
  it('extracts from music.youtube.com URL', () => {
    expect(extractPlaylistId('https://music.youtube.com/playlist?list=PLabc123_-XYZ'))
      .toBe('PLabc123_-XYZ');
  });

  it('extracts from regular youtube.com URL', () => {
    expect(extractPlaylistId('https://www.youtube.com/playlist?list=PLdef456'))
      .toBe('PLdef456');
  });

  it('extracts from watch URL with list param', () => {
    expect(extractPlaylistId('https://music.youtube.com/watch?v=abc&list=RDAMVMxyz'))
      .toBe('RDAMVMxyz');
  });

  it('extracts album playlist (OLAK prefix)', () => {
    expect(extractPlaylistId('https://music.youtube.com/playlist?list=OLAK5uy_abc'))
      .toBe('OLAK5uy_abc');
  });

  it('returns raw playlist ID as-is', () => {
    expect(extractPlaylistId('PLabc123')).toBe('PLabc123');
  });

  it('handles list param not first in query', () => {
    expect(extractPlaylistId('https://youtube.com/watch?v=vid123&list=PLxyz&index=5'))
      .toBe('PLxyz');
  });
});
