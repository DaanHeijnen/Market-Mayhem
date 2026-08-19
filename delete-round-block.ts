import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { clearScreenIfReferences, incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const b = await client.query(
      'SELECT b.round_id,r.status FROM round_blocks b JOIN rounds r ON r.id=b.round_id WHERE b.id=$1 AND b.game_night_id=$2 FOR UPDATE OF b',
      [blockId, gameId],
    );
    if (!b.rows[0]) throw new HttpError(404, 'Round block not found');
    if (b.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed round content is read-only');
    const questionHistory = await client.query('SELECT 1 FROM round_question_answers WHERE round_block_id=$1 LIMIT 1', [blockId]);
    if (questionHistory.rows[0]) throw new HttpError(409, 'Live-question history must be preserved; keep this block');
    await client.query(
      `DELETE FROM roulette_games rg WHERE rg.round_block_id=$1
       AND (rg.status='DRAFT' OR (rg.status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM roulette_bets rb WHERE rb.roulette_game_id=rg.id)))`, [blockId],
    );
    const rouletteHistory = await client.query('SELECT 1 FROM roulette_games WHERE round_block_id=$1 LIMIT 1', [blockId]);
    if (rouletteHistory.rows[0]) throw new HttpError(409, 'Roulette history must be preserved; keep this block');
    await clearScreenIfReferences(client, gameId, admin.username, { blockId });
    await client.query('UPDATE game_nights SET current_round_block_id=NULL WHERE id=$1 AND current_round_block_id=$2', [gameId, blockId]);
    await client.query('DELETE FROM round_blocks WHERE id=$1', [blockId]);
    await client.query(
      `WITH ordered AS (SELECT id,ROW_NUMBER() OVER(ORDER BY sort_order,id)-1 AS n FROM round_blocks WHERE round_id=$1)
       UPDATE round_blocks b SET sort_order=o.n,updated_at=NOW() FROM ordered o WHERE b.id=o.id`,
      [b.rows[0].round_id],
    );
    await audit(client, gameId, admin.username, 'deleted round block', 'round_block', blockId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
