import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

// Reveal (or re-hide) the answer on a presentation-only round type.
//
// A music round's title IS the song title, and a picture round's title is what players
// are trying to guess, so both must stay off the projector until the host says so.
// These types have no phone-side flow, so they need a reveal without the full
// open/close/settle machinery that question-action drives for live quizzes.
const REVEALABLE = ['PICTURE', 'MUSIC', 'BUZZER', 'WAGER'];

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const revealed = p.revealed !== false;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const result = await client.query(
      'SELECT id,type,round_id,interactive_status FROM round_blocks WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [blockId, gameId],
    );
    const block = result.rows[0];
    if (!block) throw new HttpError(404, 'Round block not found');
    if (!REVEALABLE.includes(block.type)) throw new HttpError(409, 'That block type does not have a reveal');
    // Only the block actually on the projector can be revealed. Otherwise a block could
    // be pre-revealed and would expose its answer the moment it went live.
    if (Number(game.rows[0].current_round_block_id || 0) !== blockId) {
      throw new HttpError(409, 'Show this block before revealing its answer');
    }

    await client.query(
      `UPDATE round_blocks SET interactive_status=$2,revealed_at=$3,updated_at=NOW() WHERE id=$1`,
      [blockId, revealed ? 'REVEALED' : 'READY', revealed ? new Date().toISOString() : null],
    );
    await audit(client, gameId, admin.username, revealed ? 'revealed block' : 'hid block', 'round_block', blockId, { type: block.type });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
