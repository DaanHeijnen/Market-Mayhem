import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, clearScreenIfReferences } from '../lib/game-state';
import { lockRound, assertRoundEditable } from '../lib/rounds';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const questionId = intValue(p.questionId, 'questionId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      'SELECT round_id FROM live_quiz_questions WHERE id=$1 AND game_night_id=$2',
      [questionId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const round = await lockRound(client, gameId, Number(found.rows[0].round_id));
    assertRoundEditable(round);

    // Answers and the reward paid for them are what happened in the room; deleting the
    // question would leave a ledger row nothing explains.
    const answered = await client.query('SELECT COUNT(*)::int count FROM quiz_answers WHERE question_id=$1', [questionId]);
    if (Number(answered.rows[0].count) > 0) throw new HttpError(409, 'This question has answers and cannot be deleted');
    const paid = await client.query('SELECT COUNT(*)::int count FROM ledger_entries WHERE quiz_question_id=$1', [questionId]);
    if (Number(paid.rows[0].count) > 0) throw new HttpError(409, 'This question has paid rewards and cannot be deleted');

    await clearScreenIfReferences(client, gameId, admin.username, { questionId });
    await client.query('DELETE FROM live_quiz_questions WHERE id=$1', [questionId]);

    // Close the gap the delete left, so sort_order stays a dense 0..n-1 run.
    await client.query(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order,id) - 1 AS position
         FROM live_quiz_questions WHERE round_id=$1
       )
       UPDATE live_quiz_questions q SET sort_order=o.position+1000 FROM ordered o WHERE q.id=o.id`,
      [round.id],
    );
    await client.query('UPDATE live_quiz_questions SET sort_order=sort_order-1000 WHERE round_id=$1', [round.id]);

    await audit(client, gameId, admin.username, 'deleted quiz question', 'round', round.id);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
