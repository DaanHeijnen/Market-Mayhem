import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, clearScreenIfReferences } from '../lib/game-state';
import { lockRound } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Delete an upcoming round.
 *
 * The guards are all of one kind: a round that produced history cannot be deleted, because
 * the history points at it. Authored content (questions, slides, subjects) cascades — it
 * has no meaning apart from the round — but anything that moved money or recorded what
 * happened refuses the delete instead.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const round = await lockRound(client, gameId, roundId);
    if (round.status !== 'UPCOMING') throw new HttpError(409, 'Only upcoming rounds can be deleted');

    const guards: Array<[string, string]> = [
      ['SELECT COUNT(*)::int count FROM predictions WHERE round_id=$1', 'Remove or reassign predictions linked to this round first'],
      ['SELECT COUNT(*)::int count FROM roulette_games WHERE round_id=$1', 'Round has roulette history and cannot be deleted'],
      ['SELECT COUNT(*)::int count FROM slot_series WHERE round_id=$1', 'Round has slotmachine history and cannot be deleted'],
      ['SELECT COUNT(*)::int count FROM pak_een_zes_draws WHERE round_id=$1', 'Round has Pak een Zes history and cannot be deleted'],
      ['SELECT COUNT(*)::int count FROM photo_submissions WHERE round_id=$1', 'Round has Fotoronde photos and cannot be deleted'],
      [
        `SELECT COUNT(*)::int count FROM quiz_answers a
         JOIN live_quiz_questions q ON q.id=a.question_id WHERE q.round_id=$1`,
        'Round has quiz answers and cannot be deleted',
      ],
      ['SELECT COUNT(*)::int count FROM ledger_entries WHERE attributed_round_id=$1', 'Round has ledger history and cannot be deleted'],
    ];
    for (const [sql, message] of guards) {
      const { rows } = await client.query(sql, [roundId]);
      if (Number(rows[0].count) > 0) throw new HttpError(409, message);
    }

    await clearScreenIfReferences(client, gameId, admin.username, { roundId });
    await client.query('DELETE FROM rounds WHERE id=$1', [roundId]);
    await audit(client, gameId, admin.username, `deleted round ${round.sortOrder} "${round.title}"`, 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
