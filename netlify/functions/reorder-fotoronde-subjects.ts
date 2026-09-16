import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable, reorderRoundContent } from '../lib/rounds';
import { wrap } from './_wrap';

/** Reorder a FOTORONDE round's content. The whole list, so the result is what the host sees. */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const ids: number[] = Array.isArray(p.subjectIds)
    ? p.subjectIds.map((id: unknown, i: number) => intValue(id, `subjectIds[${i}]`, { min: 1 }))
    : [];
  if (!ids.length) throw new HttpError(400, 'subjectIds is required');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'FOTORONDE');
    assertRoundEditable(round);

    const count = await reorderRoundContent(client, 'fotoronde_subjects', roundId, ids);
    await audit(client, gameId, admin.username, `reordered ${count} items`, 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
