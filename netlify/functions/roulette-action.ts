import { randomInt } from 'node:crypto';
import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { payoutForStake, rouletteBetWins } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const rouletteGameId = intValue(p.rouletteGameId, 'rouletteGameId', { min: 1 });
  const action = String(p.action || '').toUpperCase();
  if (!['OPEN','CLOSE','SPIN','SETTLE','CANCEL'].includes(action)) throw new HttpError(400, 'Invalid roulette action');
  const key = ['SETTLE','CANCEL'].includes(action) ? requestIdempotencyKey(request) : null;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const rgResult = await client.query('SELECT * FROM roulette_games WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [rouletteGameId, gameId]);
    if (!rgResult.rows[0]) throw new HttpError(404, 'Roulette game not found');
    const rg = rgResult.rows[0];
    const status = rg.status;

    if (action === 'OPEN') {
      if (status !== 'DRAFT') throw new HttpError(409, 'Roulette must be DRAFT to open');
      if (Number(game.rows[0].current_round_block_id) !== Number(rg.round_block_id)) throw new HttpError(409, 'Roulette block must be active');
      await client.query("UPDATE roulette_games SET status='OPEN',opened_at=NOW(),updated_at=NOW() WHERE id=$1", [rouletteGameId]);
      await setScreenMode(client, gameId, 'ROULETTE', admin.username, { roundId: Number(rg.round_id), blockId: Number(rg.round_block_id), payload: { rouletteGameId } });
    }
    if (action === 'CLOSE') {
      if (status !== 'OPEN') throw new HttpError(409, 'Roulette betting is not open');
      await client.query("UPDATE roulette_games SET status='LOCKED',closed_at=NOW(),updated_at=NOW() WHERE id=$1", [rouletteGameId]);
    }
    if (action === 'SPIN') {
      if (status !== 'LOCKED') throw new HttpError(409, 'Close roulette betting before spinning');
      const n = randomInt(0, 37);
      // The server selects the financial result before animation begins. Clients
      // only animate toward this stored number and never determine the outcome.
      await client.query("UPDATE roulette_games SET status='SPINNING',result_number=$2,spun_at=NOW(),updated_at=NOW() WHERE id=$1", [rouletteGameId, n]);
    }
    if (action === 'SETTLE') {
      if (status === 'SETTLED') return { duplicate: true };
      if (status !== 'RESULT' || rg.result_number == null) throw new HttpError(409, 'Roulette result must be revealed before settlement');
      const bets = await client.query("SELECT * FROM roulette_bets WHERE roulette_game_id=$1 AND status='ACTIVE' ORDER BY player_id,id FOR UPDATE", [rouletteGameId]);
      for (const bet of bets.rows) {
        const win = rouletteBetWins(bet.bet_type, bet.selection, Number(rg.result_number));
        const credit = win ? payoutForStake(Number(bet.stake), Number(bet.payout_multiplier)) : 0;
        if (credit > 0) {
          const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [bet.player_id, gameId]);
          if (!wallet.rows[0]) throw new HttpError(409, 'Roulette player wallet is missing');
          const ledger = await client.query(
            `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,roulette_game_id,roulette_bet_id,created_by,idempotency_key)
             VALUES($1,$2,$3,'ROULETTE_PAYOUT',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
            [gameId, bet.player_id, credit, `Roulette ${rg.result_number} payout`, rg.round_id, rouletteGameId, bet.id, admin.username, `${key}:bet:${bet.id}`],
          );
          if (ledger.rows[0]) {
            await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [credit, bet.player_id]);
          } else {
            const existing = await client.query(
              "SELECT player_id,amount,roulette_game_id FROM ledger_entries WHERE roulette_bet_id=$1 AND transaction_type='ROULETTE_PAYOUT'",
              [bet.id],
            );
            if (!existing.rows[0]
              || Number(existing.rows[0].player_id) !== Number(bet.player_id)
              || Number(existing.rows[0].amount) !== credit
              || Number(existing.rows[0].roulette_game_id) !== rouletteGameId) {
              throw new HttpError(409, 'Roulette settlement idempotency key conflicts with another transaction');
            }
          }
        }
        await client.query('UPDATE roulette_bets SET status=$2,settled_at=NOW() WHERE id=$1', [bet.id, win ? 'WON' : 'LOST']);
      }
      await client.query("UPDATE roulette_games SET status='SETTLED',settled_at=NOW(),updated_at=NOW() WHERE id=$1", [rouletteGameId]);
    }
    if (action === 'CANCEL') {
      if (status === 'CANCELLED') return { duplicate: true };
      if (!['DRAFT','OPEN','LOCKED'].includes(status)) throw new HttpError(409, 'Roulette cannot be cancelled after the spin starts');
      const bets = await client.query("SELECT * FROM roulette_bets WHERE roulette_game_id=$1 AND status='ACTIVE' ORDER BY player_id,id FOR UPDATE", [rouletteGameId]);
      for (const bet of bets.rows) {
        const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [bet.player_id, gameId]);
        if (!wallet.rows[0]) throw new HttpError(409, 'Roulette player wallet is missing');
        const ledger = await client.query(
          `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,roulette_game_id,roulette_bet_id,created_by,idempotency_key)
           VALUES($1,$2,$3,'ROULETTE_REFUND','Cancelled roulette refund',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
          [gameId, bet.player_id, bet.stake, rg.round_id, rouletteGameId, bet.id, admin.username, `${key}:bet:${bet.id}`],
        );
        if (ledger.rows[0]) {
          await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [bet.stake, bet.player_id]);
        } else {
          const existing = await client.query(
            "SELECT player_id,amount,roulette_game_id FROM ledger_entries WHERE roulette_bet_id=$1 AND transaction_type='ROULETTE_REFUND'",
            [bet.id],
          );
          if (!existing.rows[0]
            || Number(existing.rows[0].player_id) !== Number(bet.player_id)
            || Number(existing.rows[0].amount) !== Number(bet.stake)
            || Number(existing.rows[0].roulette_game_id) !== rouletteGameId) {
            throw new HttpError(409, 'Roulette cancellation idempotency key conflicts with another transaction');
          }
        }
        await client.query("UPDATE roulette_bets SET status='REFUNDED',settled_at=NOW() WHERE id=$1", [bet.id]);
      }
      await client.query("UPDATE roulette_games SET status='CANCELLED',settled_at=NOW(),updated_at=NOW() WHERE id=$1", [rouletteGameId]);
    }

    await audit(client, gameId, admin.username, `roulette ${action.toLowerCase()}`, 'roulette_game', rouletteGameId, { serverSelectedResult: action === 'SPIN' });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
