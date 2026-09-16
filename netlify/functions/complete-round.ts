import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound } from '../lib/rounds';
import { completeRound } from '../lib/round-lifecycle';
import { wrap } from './_wrap';

/**
 * Complete the active round.
 *
 * The round-type exit policy runs here, but it is not written here: `assertRoundMayBeLeft`
 * and `leaveRound` own it, and they are the same pair every other path that ends a round
 * calls. That is the point — a policy that exists in one place cannot be skipped by a
 * route that forgot about it.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (Number(game.rows[0].current_round_id || 0) !== roundId) {
      throw new HttpError(409, 'Only the current active round can be completed');
    }

    const round = await lockRound(client, gameId, roundId);
    if (round.status !== 'ACTIVE') throw new HttpError(409, 'Only the active round can be completed');

    // Markets are round-agnostic and settled by their own endpoints, so an unresolved one
    // blocks completion regardless of the round's type.
    const livePrediction = await client.query(
      `SELECT display_number,status FROM predictions
       WHERE round_id=$1 AND status IN ('OPEN','LOCKED','RESULT') ORDER BY display_number LIMIT 1`,
      [roundId],
    );
    if (livePrediction.rows[0]) {
      throw new HttpError(409, `Prediction #${livePrediction.rows[0].display_number} is still ${livePrediction.rows[0].status}`);
    }

    const { completed, outcome } = await completeRound(client, gameId, roundId, round.type, admin.username, 'round completed');
    if (!completed) return { duplicate: true };

    await audit(client, gameId, admin.username, `completed round ${round.sortOrder} (${round.type})`, 'round', roundId, outcome);
    return { ...outcome, version: await incrementGameVersion(client, gameId) };
  }));
});
