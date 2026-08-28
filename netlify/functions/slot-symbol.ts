import { database } from '../lib/db';
import { errorResponse, HttpError, intValue } from '../lib/http';
import { slotPositionValue, slotReelValue } from '../lib/slot';

/**
 * Serves reel artwork as raw PNG bytes. Keeping images out of the polled state
 * snapshots is what allows 36 symbols to exist without inflating every poll.
 * The Big Screen is unauthenticated, so this endpoint is public like the other
 * presentation data it renders.
 */
export default async (request: Request) => {
  try {
    if (request.method.toUpperCase() !== 'GET') throw new HttpError(405, `Method ${request.method} not allowed`);
    const url = new URL(request.url);
    const gameId = intValue(url.searchParams.get('gameId'), 'gameId', { min: 1 });
    const reel = slotReelValue(url.searchParams.get('reel'), 'reel');
    const position = slotPositionValue(url.searchParams.get('position'), 'position');
    const pinned = url.searchParams.get('v');

    const { rows } = await database().pool.query(
      'SELECT image_data,content_type,byte_size,checksum FROM slot_symbols WHERE game_night_id=$1 AND reel=$2 AND symbol_position=$3',
      [gameId, reel, position],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Reel symbol not found');

    const etag = `"${row.checksum}"`;
    const headers = new Headers({
      'content-type': row.content_type || 'image/png',
      etag,
      'x-content-type-options': 'nosniff',
      // Only a checksum-pinned URL may be cached forever; it changes when the
      // Admin replaces the image.
      'cache-control': pinned && pinned === row.checksum ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });

    const bytes = new Uint8Array(row.image_data);
    headers.set('content-length', String(bytes.byteLength));
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
};
