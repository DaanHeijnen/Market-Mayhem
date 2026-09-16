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
    const found = await client.query('SELECT round_id FROM pubquiz_questions WHERE id=$1 AND game_night_id=$2', [questionId, gameId]);
    if (!found.rows[0]) throw new HttpError(404, 'Question not found');
    const round = await lockRound(client, gameId, Number(found.rows[0].round_id));
    assertRoundEditable(round);

    await clearScreenIfReferences(client, gameId, admin.username, { pubquizQuestionId: questionId });
    await client.query('DELETE FROM pubquiz_questions WHERE id=$1', [questionId]);

    // Close the gap the delete left, in the two passes the deferrable unique constraint
    // needs so renumbering cannot collide with rows not yet reached.
    await client.query(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order,id) - 1 AS position
         FROM pubquiz_questions WHERE round_id=$1
       )
       UPDATE pubquiz_questions q SET sort_order=o.position+1000 FROM ordered o WHERE q.id=o.id`,
      [round.id],
    );
    await client.query('UPDATE pubquiz_questions SET sort_order=sort_order-1000 WHERE round_id=$1', [round.id]);

    await audit(client, gameId, admin.username, 'deleted pubquiz question', 'round', round.id, { questionId });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
