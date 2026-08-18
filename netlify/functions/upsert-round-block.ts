import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

const TYPES = ['TEXT', 'QUESTION', 'ROULETTE'] as const;

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const blockId = p.blockId == null ? null : intValue(p.blockId, 'blockId', { min: 1 });
  const type = String(p.type);
  if (!TYPES.includes(type as typeof TYPES[number])) throw new HttpError(400, 'Invalid block type');
  const title = typeof p.title === 'string' ? p.title.trim().slice(0, 200) : '';
  const bodyText = typeof p.body === 'string' ? p.body.trim().slice(0, 5000) : '';
  if (type === 'TEXT' && !bodyText) throw new HttpError(400, 'Text blocks require body/instructions');
  if (type === 'QUESTION' && !title) throw new HttpError(400, 'Question blocks require question text');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed round content is read-only');

    let id = blockId;
    if (blockId) {
      const b = await client.query('SELECT id,type FROM round_blocks WHERE id=$1 AND round_id=$2 AND game_night_id=$3 FOR UPDATE', [blockId, roundId, gameId]);
      if (!b.rows[0]) throw new HttpError(404, 'Round block not found');
      if (b.rows[0].type !== type) {
        if (Number(game.rows[0].current_round_block_id || 0) === blockId) throw new HttpError(409, 'Change to another content block before changing this block type');
        await client.query(
          `DELETE FROM roulette_games rg WHERE rg.round_block_id=$1
           AND (rg.status='DRAFT' OR (rg.status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM roulette_bets rb WHERE rb.roulette_game_id=rg.id)))`,
          [blockId],
        );
        const rouletteHistory = await client.query('SELECT id FROM roulette_games WHERE round_block_id=$1 LIMIT 1', [blockId]);
        if (rouletteHistory.rows[0]) throw new HttpError(409, 'A block with roulette history cannot change type');
      }
      await client.query(
        'UPDATE round_blocks SET type=$2,title=$3,payload=$4::jsonb,updated_at=NOW() WHERE id=$1',
        [blockId, type, title || null, JSON.stringify({ body: bodyText })],
      );
    } else {
      const next = await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM round_blocks WHERE round_id=$1', [roundId]);
      const q = await client.query(
        'INSERT INTO round_blocks(game_night_id,round_id,type,sort_order,title,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id',
        [gameId, roundId, type, Number(next.rows[0].n), title || null, JSON.stringify({ body: bodyText })],
      );
      id = Number(q.rows[0].id);
    }
    await audit(client, gameId, admin.username, blockId ? 'edited round block' : 'created round block', 'round_block', id || undefined, { roundId, type });
    return { blockId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
