import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const action = String(p.action || '').toUpperCase();
  if (!['OPEN','CLOSE','REVEAL','SETTLE'].includes(action)) throw new HttpError(400, 'Invalid question action');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const blockResult = await client.query(
      `SELECT b.id,b.round_id,b.type,b.title,b.interactive_status,b.payload,r.status AS round_status
       FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.game_night_id=$2 FOR UPDATE OF b`, [blockId, gameId],
    );
    const block = blockResult.rows[0];
    if (!block) throw new HttpError(404, 'Live question not found');
    if (block.type !== 'DUOLINGO_QUESTION') throw new HttpError(409, 'Block is not a live question');

    if (action === 'OPEN') {
      if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== Number(block.round_id)) throw new HttpError(409, 'Question round must be active');
      if (Number(game.rows[0].current_round_block_id || 0) !== blockId) throw new HttpError(409, 'Show this question block before opening answers');
      if (block.interactive_status !== 'READY') throw new HttpError(409, 'Question must be READY to open');
      await client.query("UPDATE round_blocks SET interactive_status='OPEN',opened_at=NOW(),updated_at=NOW() WHERE id=$1", [blockId]);
    }

    if (action === 'CLOSE') {
      if (block.interactive_status !== 'OPEN') throw new HttpError(409, 'Question is not open');
      await client.query("UPDATE round_blocks SET interactive_status='CLOSED',closed_at=NOW(),updated_at=NOW() WHERE id=$1", [blockId]);
    }

    if (action === 'REVEAL') {
      if (block.interactive_status === 'REVEALED' || block.interactive_status === 'SETTLED') return { duplicate: true };
      if (block.interactive_status !== 'CLOSED') throw new HttpError(409, 'Close the question before revealing the answer');
      const correctAnswerIndex = Number(block.payload?.correctAnswerIndex);
      const rewardCoins = Number(block.payload?.rewardCoins || 0);
      if (!Number.isInteger(correctAnswerIndex) || correctAnswerIndex < 0 || correctAnswerIndex > 3) throw new HttpError(409, 'Correct answer configuration is invalid');
      const winners = await client.query(
        `SELECT a.player_id,p.display_name,w.current_balance
         FROM round_question_answers a JOIN players p ON p.id=a.player_id JOIN wallets w ON w.player_id=a.player_id
         WHERE a.round_block_id=$1 AND a.selected_answer=$2 ORDER BY a.player_id FOR UPDATE OF p,w`,
        [blockId, correctAnswerIndex],
      );
      if (rewardCoins > 0) {
        for (const winner of winners.rows) {
          const ledger = await client.query(
            `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,round_block_id,created_by,idempotency_key,metadata)
             VALUES($1,$2,$3,'QUESTION_REWARD',$4,$5,$6,$7,$8,$9::jsonb)
             ON CONFLICT DO NOTHING RETURNING id`,
            [gameId, winner.player_id, rewardCoins, `Live question reward: ${block.title || `Question ${blockId}`}`, block.round_id, blockId, admin.username, `question:${blockId}:reward:${winner.player_id}`, JSON.stringify({ selectedAnswer: correctAnswerIndex })],
          );
          if (ledger.rows[0]) {
            await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [rewardCoins, winner.player_id]);
          } else {
            const existing = await client.query(
              `SELECT id,amount FROM ledger_entries
               WHERE game_night_id=$1 AND player_id=$2 AND round_block_id=$3 AND transaction_type='QUESTION_REWARD'`,
              [gameId, winner.player_id, blockId],
            );
            if (!existing.rows[0] || Number(existing.rows[0].amount) !== rewardCoins) {
              throw new HttpError(409, 'Question reward idempotency conflict');
            }
          }
        }
      }
      await client.query("UPDATE round_blocks SET interactive_status='REVEALED',revealed_at=NOW(),updated_at=NOW() WHERE id=$1", [blockId]);
    }

    if (action === 'SETTLE') {
      if (block.interactive_status === 'SETTLED') return { duplicate: true };
      if (block.interactive_status !== 'REVEALED') throw new HttpError(409, 'Reveal the answer before settling the question');
      await client.query("UPDATE round_blocks SET interactive_status='SETTLED',settled_at=NOW(),updated_at=NOW() WHERE id=$1", [blockId]);
    }

    await audit(client, gameId, admin.username, `live question ${action.toLowerCase()}`, 'round_block', blockId, { roundId: Number(block.round_id) });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
