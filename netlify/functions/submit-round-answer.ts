import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const selectedAnswer = intValue(p.selectedAnswer, 'selectedAnswer', { min: 0, max: 3 });
  const session = await requirePlayer(request, gameId);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (Number(game.rows[0].current_round_block_id || 0) !== blockId) throw new HttpError(409, 'This live question is no longer active');
    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');
    const block = await client.query(
      `SELECT b.round_id,b.type,b.interactive_status,r.status AS round_status
       FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.game_night_id=$2 FOR UPDATE OF b`, [blockId, gameId],
    );
    if (!block.rows[0]) throw new HttpError(404, 'Question not found');
    if (block.rows[0].type !== 'DUOLINGO_QUESTION') throw new HttpError(409, 'Active block is not a live question');
    if (block.rows[0].round_status !== 'ACTIVE' || Number(block.rows[0].round_id) !== Number(game.rows[0].current_round_id)) throw new HttpError(409, 'Question round is not active');
    if (block.rows[0].interactive_status !== 'OPEN') throw new HttpError(409, 'Question is not accepting answers');

    const existing = await client.query('SELECT selected_answer FROM round_question_answers WHERE round_block_id=$1 AND player_id=$2', [blockId, session.playerId]);
    if (existing.rows[0]) throw new HttpError(409, 'Your answer is already locked');
    await client.query(
      `INSERT INTO round_question_answers(game_night_id,round_id,round_block_id,player_id,selected_answer)
       VALUES($1,$2,$3,$4,$5)`,
      [gameId, block.rows[0].round_id, blockId, session.playerId, selectedAnswer],
    );
    return { submitted: true, version: await incrementGameVersion(client, gameId) };
  }));
});
