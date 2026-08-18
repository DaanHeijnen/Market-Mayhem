import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { MIN_BET, MAX_BET, payoutForStake } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(payload.predictionId, 'predictionId', { min: 1 });
  const stake = intValue(payload.stake, 'stake', { min: MIN_BET, max: MAX_BET });
  const side = String(payload.side);
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);
  if (!['YES', 'NO'].includes(side)) throw new HttpError(400, 'side must be YES or NO');

  return ok(await withTransaction(async (client) => {
    const duplicate = await client.query('SELECT id FROM ledger_entries WHERE game_night_id=$1 AND idempotency_key=$2', [gameId, key]);
    if (duplicate.rows[0]) return { duplicate: true };
    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!wallet.rows[0] || Number(wallet.rows[0].current_balance) < stake) throw new HttpError(409, 'Insufficient balance');
    const prediction = await client.query(
      'SELECT status,visible_to_players,display_number,yes_odds,no_odds FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictionId, gameId],
    );
    if (prediction.rows[0]?.status !== 'BETTING') throw new HttpError(409, 'Market is not open');
    if (!prediction.rows[0].visible_to_players) throw new HttpError(409, 'This prediction is hidden from players');
    const odds = Number(side === 'YES' ? prediction.rows[0].yes_odds : prediction.rows[0].no_odds);
    const bet = await client.query(
      `INSERT INTO bets(prediction_id,player_id,side,stake,odds_snapshot,potential_return,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [predictionId, session.playerId, side, stake, odds, payoutForStake(stake, odds), key],
    ).catch(() => { throw new HttpError(409, 'You already placed a bet'); });
    await client.query('UPDATE wallets SET current_balance=current_balance-$1,updated_at=NOW() WHERE player_id=$2', [stake, session.playerId]);
    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,prediction_id,bet_id,created_by,idempotency_key)
       VALUES($1,$2,$3,'BET_STAKE',$4,$5,$6,'player',$7)`,
      [gameId, session.playerId, -stake, `Prediction #${prediction.rows[0].display_number} stake`, predictionId, bet.rows[0].id, key],
    );
    return { betId: Number(bet.rows[0].id), version: await incrementGameVersion(client, gameId) };
  }));
});
