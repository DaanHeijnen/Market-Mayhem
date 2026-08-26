import { HttpError } from './http';

/**
 * Round-block media: the picture round's image and the music round's audio.
 *
 * Files live in Netlify Blobs and only the key is stored in the block payload. The
 * payload travels inside every admin-state snapshot, so embedding bytes would inflate
 * every poll response for the whole evening.
 *
 * The size ceiling is not arbitrary: a Netlify Function request body is capped around
 * 6 MB, so anything larger fails in the platform rather than in our code, with a much
 * worse error. A music round is a snippet — at 128 kbps, 4.5 MB is roughly four
 * minutes, which is far more than a round needs.
 */

export const BLOB_STORE = 'round-media';

export const MEDIA_LIMITS = {
  image: { maxBytes: 4 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'] },
  audio: { maxBytes: 4.5 * 1024 * 1024, types: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/flac'] },
} as const;

export type MediaKind = keyof typeof MEDIA_LIMITS;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav', 'audio/flac': 'flac',
};

export function mediaKindValue(value: unknown): MediaKind {
  if (value !== 'image' && value !== 'audio') throw new HttpError(400, 'kind must be image or audio');
  return value;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Extension → type, for when the upload does not declare a usable one. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', weba: 'audio/webm',
  m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
};

// Browsers do not always label a file usefully — audio picked on some systems arrives
// as application/octet-stream or with no type at all. Trusting the declared type alone
// rejects perfectly good MP3s, so fall back to the filename before giving up.
const GENERIC_TYPES = ['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown'];

export function resolveContentType(declaredType: string, filename: string) {
  const declared = (declaredType || '').split(';')[0].trim().toLowerCase();
  if (!GENERIC_TYPES.includes(declared)) return declared;
  const extension = (filename || '').toLowerCase().split('.').pop() || '';
  return TYPE_BY_EXTENSION[extension] || declared;
}

export function assertAcceptableMedia(kind: MediaKind, contentType: string, size: number, filename = '') {
  const limit = MEDIA_LIMITS[kind];
  const type = resolveContentType(contentType, filename);
  if (!(limit.types as readonly string[]).includes(type)) {
    throw new HttpError(415, `${type || 'That file type'} is not supported for ${kind === 'image' ? 'images' : 'audio'}`);
  }
  if (!size) throw new HttpError(400, 'That file is empty');
  if (size > limit.maxBytes) {
    throw new HttpError(413, `Keep ${kind} files under ${mb(limit.maxBytes)} — this one is ${mb(size)}`);
  }
  return type;
}

/**
 * Blob keys are namespaced by game so one game's media is never mistaken for
 * another's, and carry a random segment so a key cannot be guessed from a block id.
 */
export function buildMediaKey(gameId: number, kind: MediaKind, contentType: string, random: string) {
  const extension = EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()] || 'bin';
  return `${gameId}/${kind}/${random}.${extension}`;
}

const KEY_PATTERN = /^\d+\/(image|audio)\/[A-Za-z0-9_-]{6,64}\.[a-z0-9]{1,5}$/;

/** Keys arrive from the client on read, so the shape is validated rather than trusted. */
export function mediaKeyValue(value: unknown): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) throw new HttpError(400, 'Invalid media key');
  return value;
}
