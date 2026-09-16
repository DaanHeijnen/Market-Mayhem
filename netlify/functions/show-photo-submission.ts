import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, patchScreenPayload } from '../lib/game-state';
import { wrap } from './_wrap';

/**
 * Enlarge one submitted photo on the projector while judging it.
 *
 * Which photo is showing is presentational rather than game state — it changes nothing
 * about the round — so it lives in `screen_state.payload` alongside the scene rather than
 * on the submission. Passing null clears the selection and the projector falls back to the
 * round's progress view.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const submissionId = p.submissionId == null ? null : intValue(p.submissionId, 'submissionId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    // The projector must already be on this Fotoronde. Enlarging a photo is a change to
    // the scene that is showing, not a way to switch scenes.
    const screen = await client.query('SELECT mode,round_id FROM screen_state WHERE game_night_id=$1', [gameId]);
    if (screen.rows[0]?.mode !== 'FOTORONDE' || Number(screen.rows[0]?.round_id || 0) !== roundId) {
      throw new HttpError(409, 'Show this Fotoronde on the projector first');
    }

    if (submissionId != null) {
      // The photo has to belong to this round, or the projector could be pointed at
      // another round's submission.
      const owns = await client.query(
        `SELECT s.id FROM photo_submissions s
         JOIN photo_rounds r ON r.id=s.photo_round_id
         WHERE s.id=$1 AND s.game_night_id=$2 AND r.round_id=$3`,
        [submissionId, gameId, roundId],
      );
      if (!owns.rows[0]) throw new HttpError(404, 'That photo is not part of this Fotoronde');
    }

    await patchScreenPayload(client, gameId, { photoSubmissionId: submissionId });
    await audit(
      client, gameId, admin.username,
      submissionId ? 'showed Fotoronde photo' : 'cleared Fotoronde photo',
      'round', roundId, { submissionId },
    );
    return { submissionId, version: await incrementGameVersion(client, gameId) };
  }));
});
