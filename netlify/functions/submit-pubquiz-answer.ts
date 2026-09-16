import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { pubquizAcceptsAnswers } from '../lib/pubquiz';
import { wrap } from './_wrap';

/**
 * A player answers the pubquiz question that is currently live.
 *
 * The phone sends an option id, not an index, and the server checks the option belongs to
 * the question it names. Who the player is comes from the session and never from the
 * request — a phone holding a valid session still cannot answer as somebody else. Nothing
 * about whether the option is correct goes back.
 *
 * One answer per player, and it is final. Deliberately the same rule LIVE_QUIZ has: two
 * quiz types in one evening that disagree about whether you may change your mind would be
 * a rule players have to learn twice. The `(question_id, player_id)` unique constraint is
 * what enforces it — two taps arriving together would both pass any check written here.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const questionId = intValue(p.questionId, 'questionId', { min: 1 });
  const optionId = intValue(p.optionId, 'optionId', { min: 1 });
  const session = await requirePlayer(request, gameId);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');

    const found = await client.query(
      `SELECT q.id,q.round_id,q.hidden,st.status,r.status AS round_status,rt.current_pubquiz_question_id
       FROM pubquiz_questions q
       JOIN pubquiz_question_state st ON st.question_id=q.id
       JOIN rounds r ON r.id=q.round_id
       LEFT JOIN round_runtime rt ON rt.round_id=q.round_id
       WHERE q.id=$1 AND q.game_night_id=$2 FOR UPDATE OF st`,
      [questionId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const question = found.rows[0];

    if (question.round_status !== 'ACTIVE' || Number(question.round_id) !== Number(game.rows[0].current_round_id || 0)) {
      throw new HttpError(409, 'This question belongs to a round that is not being played');
    }
    // The round's own cursor decides which question is live, not the phone.
    if (Number(question.current_pubquiz_question_id || 0) !== questionId) {
      throw new HttpError(409, 'This question is no longer the current one');
    }
    if (question.hidden) throw new HttpError(409, 'This question is not part of the round');
    if (!pubquizAcceptsAnswers(question.status)) throw new HttpError(409, 'This question is not accepting answers');

    const option = await client.query(
      'SELECT id FROM pubquiz_question_options WHERE id=$1 AND question_id=$2',
      [optionId, questionId],
    );
    if (!option.rows[0]) throw new HttpError(400, 'That answer does not belong to this question');

    const inserted = await client.query(
      `INSERT INTO pubquiz_answers(game_night_id,round_id,question_id,option_id,player_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (question_id,player_id) DO NOTHING
       RETURNING id`,
      [gameId, question.round_id, questionId, optionId, session.playerId],
    );
    if (!inserted.rows[0]) throw new HttpError(409, 'Your answer is already locked');

    return { submitted: true, version: await incrementGameVersion(client, gameId) };
  }));
});
