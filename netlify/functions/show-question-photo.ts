import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { mayShowContextPhoto } from '../lib/live-quiz';
import { wrap } from './_wrap';

/**
 * Put a quiz question's context photo on the projector, as the beat after the reveal.
 *
 * Not a phase of the question: the answers are closed and the reward is paid by the time
 * this can be called, so showing the photo changes nothing about the game. It is runtime
 * state on the question rather than a flag in the screen payload, so it resets with the
 * question and can never be left over from the previous one.
 *
 * Two independent locks keep it from landing early — this endpoint refuses before the
 * reveal, and the projector serialiser withholds the media key entirely until then, so an
 * early render has no file to name.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const questionId = intValue(p.questionId, 'questionId', { min: 1 });
  const show = p.show == null ? true : Boolean(p.show);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      `SELECT q.id,q.round_id,q.context_media_key,st.status
       FROM live_quiz_questions q
       JOIN live_quiz_question_state st ON st.question_id=q.id
       WHERE q.id=$1 AND q.game_night_id=$2 FOR UPDATE OF st`,
      [questionId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const question = found.rows[0];

    if (show) {
      if (!mayShowContextPhoto(question.status)) {
        throw new HttpError(409, 'Reveal the correct answer before showing the context photo');
      }
      if (!question.context_media_key) throw new HttpError(409, 'This question has no context photo');
    }

    await client.query(
      'UPDATE live_quiz_question_state SET context_photo_shown=$2,updated_at=NOW() WHERE question_id=$1',
      [questionId, show],
    );
    await audit(
      client, gameId, admin.username,
      show ? 'showed question context photo' : 'hid question context photo',
      'round', Number(question.round_id), { questionId },
    );
    return { showing: show, version: await incrementGameVersion(client, gameId) };
  }));
});
