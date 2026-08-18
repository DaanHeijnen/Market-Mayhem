import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { maxPredictionStake, payoutForStake } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const predictionId = intValue(p.predictionId, 'predictionId', { min: 1 });
  const stake = intValue(p.stake, 'stake', { min: 1 });
  const side = typeof p.side === 'string' ? p.side : '';
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);
  if (!['YES','NO'].includes(side)) throw new HttpError(400, 'side must be YES or NO');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT maximum_wallet_percentage FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const priorKey = await client.query(
      `SELECT b.id,b.prediction_id,b.player_id,b.side,b.stake FROM bets b WHERE b.idempotency_key=$1`, [key],
    );
    if (priorKey.rows[0]) {
      const prior = priorKey.rows[0];
      if (Number(prior.player_id) === session.playerId && Number(prior.prediction_id) === predictionId && prior.side === side && Number(prior.stake) === stake) {
        return { duplicate: true, betId: Number(prior.id) };
      }
      throw new HttpError(409, 'Idempotency key was already used for a different prediction deposit');
    }

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');
    const pred = await client.query(
      `SELECT status,display_number,yes_odds,no_odds,closes_at,round_id,minimum_stake,maximum_stake,
              (closes_at IS NOT NULL AND closes_at<=NOW()) AS expired
       FROM predictions WHERE id=$1 AND game_night_id=$2 FOR UPDATE`,
      [predictionId, gameId],
    );
    if (!pred.rows[0]) throw new HttpError(404, 'Prediction not found');
    if (pred.rows[0].status !== 'OPEN') throw new HttpError(409, 'Market is not open');
    if (!pred.rows[0].closes_at) throw new HttpError(409, 'Market closing time is missing');
    if (pred.rows[0].expired) throw new HttpError(409, 'Market timer has expired');

    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
    const balance = Number(wallet.rows[0].current_balance);
    const min = Number(pred.rows[0].minimum_stake);
    const max = Number(pred.rows[0].maximum_stake);
    const pct = game.rows[0].maximum_wallet_percentage == null ? null : Number(game.rows[0].maximum_wallet_percentage);
    const allowed = maxPredictionStake(balance, min, max, pct);
    if (stake < min) throw new HttpError(400, `Minimum deposit is ${min}`);
    if (stake > allowed) throw new HttpError(409, allowed ? `Maximum deposit for this wallet is ${allowed}` : 'Available balance is below the minimum deposit');

    const existing = await client.query('SELECT id FROM bets WHERE prediction_id=$1 AND player_id=$2', [predictionId, session.playerId]);
    if (existing.rows[0]) throw new HttpError(409, 'You already placed a deposit on this prediction');

    const multiplier = Number(side === 'YES' ? pred.rows[0].yes_odds : pred.rows[0].no_odds);
    const bet = await client.query(
      `INSERT INTO bets(prediction_id,player_id,side,stake,odds_snapshot,potential_return,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [predictionId, session.playerId, side, stake, multiplier, payoutForStake(stake, multiplier), key],
    );
    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,prediction_id,bet_id,created_by,idempotency_key,metadata)
       VALUES($1,$2,$3,'PREDICTION_DEPOSIT',$4,$5,$6,$7,'player',$8,$9::jsonb)`,
      [gameId, session.playerId, -stake, `Prediction #${pred.rows[0].display_number} deposit`, pred.rows[0].round_id, predictionId, bet.rows[0].id, key, JSON.stringify({ bucket: 'locked', side, multiplier })],
    );
    await client.query('UPDATE wallets SET current_balance=current_balance-$1,updated_at=NOW() WHERE player_id=$2', [stake, session.playerId]);
    return { betId: Number(bet.rows[0].id), version: await incrementGameVersion(client, gameId) };
  }));
});
