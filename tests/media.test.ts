import { describe, expect, it } from 'vitest';
import { MEDIA_LIMITS, assertAcceptableMedia, buildMediaKey, mediaKeyValue, mediaKindValue } from '../netlify/lib/media';

describe('round media validation', () => {
  it('accepts the common image and audio types', () => {
    expect(assertAcceptableMedia('image', 'image/png', 1000)).toBe('image/png');
    expect(assertAcceptableMedia('image', 'image/jpeg', 1000)).toBe('image/jpeg');
    expect(assertAcceptableMedia('audio', 'audio/mpeg', 1000)).toBe('audio/mpeg');
    expect(assertAcceptableMedia('audio', 'audio/x-m4a', 1000)).toBe('audio/x-m4a');
  });

  it('ignores charset parameters and casing the browser may add', () => {
    expect(assertAcceptableMedia('image', 'IMAGE/PNG; charset=binary', 1000)).toBe('image/png');
  });

  it('refuses a type that does not belong to the kind', () => {
    expect(() => assertAcceptableMedia('image', 'audio/mpeg', 1000)).toThrow(/not supported for images/);
    expect(() => assertAcceptableMedia('audio', 'image/png', 1000)).toThrow(/not supported for audio/);
    expect(() => assertAcceptableMedia('image', 'application/pdf', 1000)).toThrow(/not supported/);
    expect(() => assertAcceptableMedia('image', '', 1000)).toThrow(/not supported/);
  });

  it('refuses an empty file', () => {
    expect(() => assertAcceptableMedia('image', 'image/png', 0)).toThrow(/empty/);
  });

  // The ceiling exists because a Netlify Function request body is capped around 6 MB;
  // exceeding it fails in the platform with a far worse error than this one.
  it('refuses a file over the limit and says how big it was', () => {
    expect(() => assertAcceptableMedia('image', 'image/png', MEDIA_LIMITS.image.maxBytes + 1)).toThrow(/under 4\.0 MB/);
    expect(() => assertAcceptableMedia('audio', 'audio/mpeg', 10 * 1024 * 1024)).toThrow(/this one is 10\.0 MB/);
    expect(() => assertAcceptableMedia('audio', 'audio/mpeg', MEDIA_LIMITS.audio.maxBytes)).not.toThrow();
  });

  it('stays under the platform body limit', () => {
    expect(MEDIA_LIMITS.image.maxBytes).toBeLessThan(6 * 1024 * 1024);
    expect(MEDIA_LIMITS.audio.maxBytes).toBeLessThan(6 * 1024 * 1024);
  });

  it('only accepts the two kinds', () => {
    expect(mediaKindValue('image')).toBe('image');
    expect(mediaKindValue('audio')).toBe('audio');
    expect(() => mediaKindValue('video')).toThrow(/image or audio/);
    expect(() => mediaKindValue(undefined)).toThrow();
  });
});

describe('round media keys', () => {
  it('namespaces by game and kind, and picks an extension from the type', () => {
    expect(buildMediaKey(7, 'image', 'image/png', 'abcd1234')).toBe('7/image/abcd1234.png');
    expect(buildMediaKey(7, 'audio', 'audio/mpeg', 'abcd1234')).toBe('7/audio/abcd1234.mp3');
    expect(buildMediaKey(7, 'audio', 'audio/x-m4a', 'abcd1234')).toBe('7/audio/abcd1234.m4a');
  });

  it('falls back to a generic extension for an unmapped type', () => {
    expect(buildMediaKey(1, 'image', 'image/tiff', 'abcd1234')).toBe('1/image/abcd1234.bin');
  });

  it('round-trips its own keys', () => {
    expect(mediaKeyValue(buildMediaKey(12, 'image', 'image/webp', 'Ab_9-xYz'))).toBe('12/image/Ab_9-xYz.webp');
  });

  // Keys arrive from the client on read, so the shape is validated rather than trusted.
  it('rejects traversal and malformed keys', () => {
    expect(() => mediaKeyValue('../secrets/key.png')).toThrow(/Invalid media key/);
    expect(() => mediaKeyValue('1/image/../../x.png')).toThrow(/Invalid media key/);
    expect(() => mediaKeyValue('1/video/abcd1234.mp4')).toThrow(/Invalid media key/);
    expect(() => mediaKeyValue('abc/image/abcd1234.png')).toThrow(/Invalid media key/);
    expect(() => mediaKeyValue('1/image/short.png')).toThrow(/Invalid media key/);
    expect(() => mediaKeyValue('')).toThrow(/Invalid media key/);
    expect(() => mediaKeyValue(null)).toThrow(/Invalid media key/);
  });
});
