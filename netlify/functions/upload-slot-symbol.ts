import { createHash } from 'node:crypto';
import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { SLOT_MAX_SYMBOL_BYTES, slotPositionValue, slotReelValue, slotSymbolLetter } from '../lib/slot';
import { slotStatus } from '../lib/slot-store';
import { wrap } from './_wrap';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'image is required');
  const base64 = raw.startsWith('data:')
    ? (() => {
      const match = /^data:image\/png;base64,(.+)$/i.exec(raw.trim());
      if (!match) throw new HttpError(400, 'Only PNG images are accepted');
      return match[1];
    })()
    : raw.trim();
  // Reject before allocating: base64 inflates by 4/3, so this bounds the buffer.
  if (base64.length > Math.ceil(SLOT_MAX_SYMBOL_BYTES / 3) * 4 + 8) throw new HttpError(413, 'PNG is larger than 1 MB');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400, 'image must be base64 encoded PNG data');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw new HttpError(400, 'image is empty');
  if (buffer.length > SLOT_MAX_SYMBOL_BYTES) throw new HttpError(413, 'PNG is larger than 1 MB');
  if (!buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new HttpError(400, 'Only PNG images are accepted');
  return buffer;
}

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const reel = slotReelValue(p.reel, 'reel');
  const position = slotPositionValue(p.position, 'position');
  const filename = typeof p.filename === 'string' ? p.filename.trim().slice(0, 160) || null : null;
  const buffer = decodePng(p.image);
  const checksum = createHash('sha256').update(buffer).digest('hex').slice(0, 32);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const active = await client.query("SELECT id FROM slot_sessions WHERE game_night_id=$1 AND status='ACTIVE' FOR UPDATE", [gameId]);
    if (active.rows[0]) throw new HttpError(409, 'Finish or cancel the active slot series before changing reel symbols');
    await client.query(
      `INSERT INTO slot_symbols (game_night_id,reel,symbol_position,content_type,byte_size,checksum,image_data,original_filename,updated_by)
       VALUES ($1,$2,$3,'image/png',$4,$5,$6,$7,$8)
       ON CONFLICT (game_night_id,reel,symbol_position)
       DO UPDATE SET byte_size=EXCLUDED.byte_size,checksum=EXCLUDED.checksum,image_data=EXCLUDED.image_data,
                     original_filename=EXCLUDED.original_filename,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [gameId, reel, position, buffer.length, checksum, buffer, filename, admin.username],
    );
    await audit(client, gameId, admin.username, 'uploaded slot reel symbol', 'slot_symbol', gameId, { reel, position, letter: slotSymbolLetter(position), byteSize: buffer.length });
    const snapshot = await slotStatus(client, gameId);
    return { reel, position, checksum, byteSize: buffer.length, status: snapshot.status, version: await incrementGameVersion(client, gameId) };
  }));
});
