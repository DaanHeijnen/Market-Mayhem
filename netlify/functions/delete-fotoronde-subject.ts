import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundEditable } from '../lib/rounds';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const subjectId = intValue(p.subjectId, 'subjectId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const found = await client.query(
      'SELECT round_id,subject_key FROM fotoronde_subjects WHERE id=$1 AND game_night_id=$2',
      [subjectId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Subject not found');
    const round = await lockRound(client, gameId, Number(found.rows[0].round_id));
    assertRoundEditable(round);

    // Photos are filed under the subject key, so a subject with photos cannot go without
    // orphaning them — and some of them may already have been paid for.
    const photos = await client.query(
      `SELECT COUNT(*)::int count FROM photo_submissions s
       JOIN photo_rounds r ON r.id=s.photo_round_id
       WHERE r.round_id=$1 AND s.subject_key=$2`,
      [round.id, found.rows[0].subject_key],
    );
    if (Number(photos.rows[0].count) > 0) throw new HttpError(409, 'Teams have already uploaded photos for this subject');

    await client.query('DELETE FROM fotoronde_subjects WHERE id=$1', [subjectId]);
    await client.query(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order,id) - 1 AS position
         FROM fotoronde_subjects WHERE round_id=$1
       )
       UPDATE fotoronde_subjects s SET sort_order=o.position+1000 FROM ordered o WHERE s.id=o.id`,
      [round.id],
    );
    await client.query('UPDATE fotoronde_subjects SET sort_order=sort_order-1000 WHERE round_id=$1', [round.id]);

    await audit(client, gameId, admin.username, 'deleted Fotoronde subject', 'round', round.id);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
