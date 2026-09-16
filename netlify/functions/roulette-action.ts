import { randomInt } from 'node:crypto';
import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion, setScreen } from '../lib/game-state';
import { openNextRouletteRun } from '../lib/roulette';
import { wrap } from './_wrap';

/**
 * Drive one roulette round.
 *
 * A round holds as many runs of the wheel as the host wants:
 *
 *   OPEN → players place chips → CLOSE → SPIN → (the result becomes final, and the
 *   server pays everybody in that same moment) → OPEN_AGAIN → …
 *
 * There is deliberately no SETTLE action. Settlement happens where the result becomes
 * final, in `syncTimedState`, because a payout that waits for someone to press a button is
 * a payout that can be forgotten. What used to be SETTLE is now nothing at all, and
 * OPEN_AGAIN is what the host presses once they have shown the room the result.
 */
const ACTIONS = ['OPEN', 'CLOSE', 'SPIN', 'OPEN_AGAIN', 'CANCEL'] as const;

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const rouletteGameId = intValue(p.rouletteGameId, 'rouletteGameId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as typeof ACTIONS[number];
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Invalid roulette action');
  const key = action === 'CANCEL' ? requestIdempotencyKey(request) : null;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const rgResult = await client.query('SELECT * FROM roulette_games WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [rouletteGameId, gameId]);
    if (!rgResult.rows[0]) throw new HttpError(404, 'Roulette run not found');
    const rg = rgResult.rows[0];
    const status = rg.status;
    const roundId = Number(rg.round_id || 0);
    let result: Record<string, unknown> = {};

    if (action === 'OPEN') {
      if (status !== 'DRAFT') throw new HttpError(409, 'This roulette run is not waiting to be opened');
      if (Number(game.rows[0].current_round_id) !== roundId) throw new HttpError(409, 'The roulette round must be the active round');
      await client.query("UPDATE roulette_games SET status='OPEN',opened_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='DRAFT'", [rouletteGameId]);
      // The table claims the projector: phones are about to fill with chips and the room
      // has to be able to see the board they are betting on.
      await setScreen(client, gameId, { kind: 'roundGame', roundId }, admin.username);
    }

    if (action === 'CLOSE') {
      if (status !== 'OPEN') throw new HttpError(409, 'Roulette betting is not open');
      await client.query("UPDATE roulette_games SET status='LOCKED',closed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='OPEN'", [rouletteGameId]);
    }

    if (action === 'SPIN') {
      if (status !== 'LOCKED') throw new HttpError(409, 'Close roulette betting before spinning');
      const n = randomInt(0, 37);
      // The financial result is chosen here, before any animation begins, and the guard
      // on the status is what makes a double-clicked SPIN impossible: the second request
      // finds the row already SPINNING and changes nothing, so the number cannot be
      // re-rolled out from under a wheel that is already turning.
      const spun = await client.query(
        "UPDATE roulette_games SET status='SPINNING',result_number=$2,spun_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='LOCKED' RETURNING id",
        [rouletteGameId, n],
      );
      if (!spun.rows[0]) throw new HttpError(409, 'This wheel is already spinning');
      // Everyone is paid when the spin window elapses; the host presses nothing.
      result = { settlesAutomatically: true };
    }

    if (action === 'OPEN_AGAIN') {
      if (!roundId) throw new HttpError(409, 'This roulette run is not attached to a round');
      if (Number(game.rows[0].current_round_id) !== roundId) throw new HttpError(409, 'The roulette round must be the active round');
      // A run that has not finished is not something to start another beside. Settling
      // one is not the host's job, so the only case that lands here is pressing too early.
      if (!['SETTLED', 'CANCELLED'].includes(status)) {
        throw new HttpError(409, `This run is still ${status} — wait for the result before opening betting again`);
      }
      const next = await openNextRouletteRun(client, gameId, roundId);
      await client.query("UPDATE roulette_games SET status='OPEN',opened_at=NOW(),updated_at=NOW() WHERE id=$1", [next.rouletteGameId]);
      // The board comes back on screen: the result summary the room was reading belongs
      // to the run that just finished, and betting is open again now.
      await setScreen(client, gameId, { kind: 'roundGame', roundId }, admin.username);
      result = { rouletteGameId: next.rouletteGameId, runNumber: next.runNumber };
    }

    if (action === 'CANCEL') {
      if (status === 'CANCELLED') return { duplicate: true };
      if (!['DRAFT', 'OPEN', 'LOCKED'].includes(status)) throw new HttpError(409, 'Roulette cannot be cancelled once the wheel is turning');
      const bets = await client.query(
        "SELECT id,player_id,stake FROM roulette_bets WHERE roulette_game_id=$1 AND status='ACTIVE' ORDER BY player_id,id FOR UPDATE",
        [rouletteGameId],
      );
      for (const bet of bets.rows) {
        const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [bet.player_id, gameId]);
        if (!wallet.rows[0]) throw new HttpError(409, 'Roulette player wallet is missing');
        const ledger = await client.query(
          `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,roulette_game_id,roulette_bet_id,created_by,idempotency_key)
           VALUES($1,$2,$3,'ROULETTE_REFUND','Cancelled roulette refund',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
          [gameId, bet.player_id, Number(bet.stake), roundId || null, rouletteGameId, bet.id, admin.username, `roulette:refund:bet:${bet.id}`],
        );
        if (ledger.rows[0]) {
          await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [Number(bet.stake), bet.player_id]);
        }
        await client.query("UPDATE roulette_bets SET status='REFUNDED',settled_at=NOW() WHERE id=$1 AND status='ACTIVE'", [bet.id]);
      }
      await client.query("UPDATE roulette_games SET status='CANCELLED',settled_at=NOW(),updated_at=NOW() WHERE id=$1", [rouletteGameId]);
      result = { refunded: bets.rowCount ?? 0, idempotencyKey: key ? 'accepted' : 'none' };
    }

    await audit(client, gameId, admin.username, `roulette ${action.toLowerCase()}`, 'roulette_game', rouletteGameId, {
      runNumber: Number(rg.run_number),
      serverSelectedResult: action === 'SPIN',
    });
    return { ...result, version: await incrementGameVersion(client, gameId) };
  }));
});
