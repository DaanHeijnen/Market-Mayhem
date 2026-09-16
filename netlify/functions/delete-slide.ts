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
  const slideId = intValue(p.slideId, 'slideId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const found = await client.query('SELECT round_id FROM presentation_slides WHERE id=$1 AND game_night_id=$2', [slideId, gameId]);
    if (!found.rows[0]) throw new HttpError(404, 'Slide not found');
    const round = await lockRound(client, gameId, Number(found.rows[0].round_id));
    assertRoundEditable(round);

    await clearScreenIfReferences(client, gameId, admin.username, { slideId });
    await client.query('DELETE FROM presentation_slides WHERE id=$1', [slideId]);
    await client.query(
      `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order,id) - 1 AS position
         FROM presentation_slides WHERE round_id=$1
       )
       UPDATE presentation_slides s SET sort_order=o.position+1000 FROM ordered o WHERE s.id=o.id`,
      [round.id],
    );
    await client.query('UPDATE presentation_slides SET sort_order=sort_order-1000 WHERE round_id=$1', [round.id]);

    await audit(client, gameId, admin.username, 'deleted slide', 'round', round.id);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
