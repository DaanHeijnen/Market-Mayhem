import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion, clearScreenIfReferences } from '../lib/game-state';
import { lockRound, assertRoundType } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Take a pubquiz question out of the run, or put it back in.
 *
 * The same concept a presentation page has, and the same rules: authored state, so it
 * survives a refresh and a Full Reset; allowed while the round is UPCOMING and while it is
 * ACTIVE, because the case this exists for is realising mid-round that the spare question
 * is needed; refused once the round is finished.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const questionId = intValue(p.questionId, 'questionId', { min: 1 });
  const hidden = booleanValue(p.hidden, 'hidden');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      'SELECT id,round_id,hidden FROM pubquiz_questions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [questionId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const round = await lockRound(client, gameId, Number(found.rows[0].round_id));
    assertRoundType(round, 'PUBQUIZ');
    if (round.status === 'COMPLETED') throw new HttpError(409, 'This round is finished — its questions can no longer be changed');

    if (Boolean(found.rows[0].hidden) === hidden) return { duplicate: true, hidden };

    const updated = await client.query(
      'UPDATE pubquiz_questions SET hidden=$2,updated_at=NOW() WHERE id=$1 AND hidden=$3 RETURNING id',
      [questionId, hidden, !hidden],
    );
    if (!updated.rows[0]) throw new HttpError(409, 'This question has changed since — refresh and try again');

    let clearedScreen = false;
    if (hidden) {
      const live = await client.query('SELECT pubquiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId]);
      clearedScreen = Number(live.rows[0]?.pubquiz_question_id || 0) === questionId;
      await clearScreenIfReferences(client, gameId, admin.username, { pubquizQuestionId: questionId });
    }

    await audit(client, gameId, admin.username, hidden ? 'hid pubquiz question' : 'made pubquiz question visible', 'round', round.id, { questionId });
    return { hidden, clearedScreen, version: await incrementGameVersion(client, gameId) };
  }));
});
