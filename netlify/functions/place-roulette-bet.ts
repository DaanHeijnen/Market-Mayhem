import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { normalizeRouletteSelection, payoutForStake, roulettePayoutMultiplier, type RouletteBetType } from '../lib/economy';
import { wrap } from './_wrap';

export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const rouletteGameId = intValue(p.rouletteGameId, 'rouletteGameId', { min: 1 });
  const stake = intValue(p.stake, 'stake', { min: 1, max: 1_000_000 });
  const type = typeof p.betType === 'string' ? p.betType.toUpperCase() as RouletteBetType : '' as RouletteBetType;
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);
  if (!['NUMBER', 'COLOR', 'PARITY', 'RANGE'].includes(type)) throw new HttpError(400, 'Invalid roulette bet type');
  let selection: string;
  try { selection = normalizeRouletteSelection(type, p.selection); } catch (e) { throw new HttpError(400, (e as Error).message); }
  const multiplier = roulettePayoutMultiplier(type);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const priorKey = await client.query(
      `SELECT b.id,b.roulette_game_id,b.player_id,b.bet_type,b.selection,b.stake
       FROM roulette_bets b JOIN roulette_games rg ON rg.id=b.roulette_game_id
       WHERE b.idempotency_key=$1`,
      [key],
    );
    if (priorKey.rows[0]) {
      const prior = priorKey.rows[0];
      if (Number(prior.player_id) === session.playerId && Number(prior.roulette_game_id) === rouletteGameId && prior.bet_type === type && prior.selection === selection && Number(prior.stake) === stake) {
        return { duplicate: true, betId: Number(prior.id) };
      }
      throw new HttpError(409, 'Idempotency key was already used for a different roulette bet');
    }

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');
    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!wallet.rows[0] || Number(wallet.rows[0].current_balance) < stake) throw new HttpError(409, 'Insufficient balance');
    const rg = await client.query('SELECT status,round_id FROM roulette_games WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [rouletteGameId, gameId]);
    if (!rg.rows[0]) throw new HttpError(404, 'Roulette game not found');
    if (rg.rows[0].status !== 'OPEN') throw new HttpError(409, 'Roulette betting is closed');

    const bet = await client.query(
      `INSERT INTO roulette_bets(roulette_game_id,player_id,bet_type,selection,stake,payout_multiplier,potential_return,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [rouletteGameId, session.playerId, type, selection, stake, multiplier, payoutForStake(stake, multiplier), key],
    );
    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,roulette_game_id,roulette_bet_id,created_by,idempotency_key)
       VALUES($1,$2,$3,'ROULETTE_STAKE',$4,$5,$6,$7,'player',$8)`,
      [gameId, session.playerId, -stake, `Roulette ${type.toLowerCase()} ${selection}`, rg.rows[0].round_id, rouletteGameId, bet.rows[0].id, key],
    );
    await client.query('UPDATE wallets SET current_balance=current_balance-$1,updated_at=NOW() WHERE player_id=$2', [stake, session.playerId]);
    return { betId: Number(bet.rows[0].id), version: await incrementGameVersion(client, gameId) };
  }));
});
