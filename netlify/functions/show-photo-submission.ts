import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { wrap } from './_wrap';

/**
 * Put one submitted photo on the projector while judging it.
 *
 * Reuses the existing presentation model rather than adding a second one: the chosen
 * submission id rides in `screen_state.payload` exactly as the roulette game id does, so
 * the Big Screen reads it from the snapshot it already polls. Passing null clears the
 * selection and the projector falls back to the round's progress view.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const submissionId = p.submissionId == null ? null : intValue(p.submissionId, 'submissionId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const roundId = Number(game.rows[0].current_round_id || 0);
    if (!roundId) throw new HttpError(409, 'No round is active');

    if (submissionId != null) {
      // The photo has to belong to this block, or the projector could be pointed at
      // another round's submission.
      const owns = await client.query(
        'SELECT id FROM photo_submissions WHERE id=$1 AND game_night_id=$2 AND round_block_id=$3',
        [submissionId, gameId, blockId],
      );
      if (!owns.rows[0]) throw new HttpError(404, 'That photo is not part of this Fotoronde');
    }

    await setScreenMode(client, gameId, 'FOTORONDE', admin.username, {
      roundId,
      blockId,
      payload: { photoSubmissionId: submissionId },
    });
    await audit(client, gameId, admin.username, submissionId ? 'showed Fotoronde photo' : 'cleared Fotoronde photo', 'round_block', blockId, { submissionId });
    return { submissionId, version: await incrementGameVersion(client, gameId) };
  }));
});
