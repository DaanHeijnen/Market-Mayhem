import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable, reorderRoundContent } from '../lib/rounds';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  if (!Array.isArray(p.questionIds)) throw new HttpError(400, 'questionIds must be an array');
  const questionIds = p.questionIds.map((id: unknown, index: number) => intValue(id, `questionIds[${index}]`, { min: 1 }));

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'PUBQUIZ');
    assertRoundEditable(round);

    await reorderRoundContent(client, 'pubquiz_questions', roundId, questionIds);
    await audit(client, gameId, admin.username, 'reordered pubquiz questions', 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
