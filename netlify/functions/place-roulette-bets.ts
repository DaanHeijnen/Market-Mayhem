import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { normalizeRouletteSelection, payoutForStake, roulettePayoutMultiplier, type RouletteBetType } from '../lib/economy';
import { wrap } from './_wrap';

type DraftBet = { betType: RouletteBetType; selection: string; stake: number; multiplier: number };

export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const rouletteGameId = intValue(p.rouletteGameId, 'rouletteGameId', { min: 1 });
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);
  if (!Array.isArray(p.bets) || p.bets.length < 1 || p.bets.length > 24) throw new HttpError(400, 'bets must contain 1 to 24 roulette positions');

  const bets: DraftBet[] = p.bets.map((raw: any, index: number) => {
    const type = typeof raw?.betType === 'string' ? raw.betType.toUpperCase() as RouletteBetType : '' as RouletteBetType;
    if (!['NUMBER','COLOR','PARITY','RANGE'].includes(type)) throw new HttpError(400, `Invalid roulette bet type at position ${index + 1}`);
    let selection: string;
    try { selection = normalizeRouletteSelection(type, raw.selection); } catch (error) { throw new HttpError(400, (error as Error).message); }
    const stake = intValue(raw.stake, `stake ${index + 1}`, { min: 1, max: 1_000_000 });
    return { betType: type, selection, stake, multiplier: roulettePayoutMultiplier(type) };
  });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');
    const rg = await client.query('SELECT status,round_id FROM roulette_games WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [rouletteGameId, gameId]);
    if (!rg.rows[0]) throw new HttpError(404, 'Roulette game not found');
    if (rg.rows[0].status !== 'OPEN') throw new HttpError(409, 'Roulette betting is closed');
    const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
    if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
    const totalStake = bets.reduce((sum, bet) => sum + bet.stake, 0);
    if (totalStake > Number(wallet.rows[0].current_balance)) throw new HttpError(409, 'Insufficient available balance for these roulette chips');

    const itemKeys = bets.map((_, index) => `${key}:${index}`);
    const existing = await client.query(
      `SELECT id,bet_type,selection,stake,idempotency_key FROM roulette_bets
       WHERE roulette_game_id=$1 AND player_id=$2 AND idempotency_key=ANY($3::text[]) ORDER BY idempotency_key`,
      [rouletteGameId, session.playerId, itemKeys],
    );
    if (existing.rowCount) {
      if (existing.rowCount !== bets.length) throw new HttpError(409, 'Idempotency key conflicts with an incomplete roulette batch');
      for (let i = 0; i < bets.length; i += 1) {
        const found = existing.rows.find((row: any) => row.idempotency_key === `${key}:${i}`);
        const wanted = bets[i];
        if (!found || found.bet_type !== wanted.betType || found.selection !== wanted.selection || Number(found.stake) !== wanted.stake) throw new HttpError(409, 'Idempotency key was already used for different roulette chips');
      }
      return { duplicate: true, betIds: existing.rows.map((row: any) => Number(row.id)) };
    }

    const betIds: number[] = [];
    for (let i = 0; i < bets.length; i += 1) {
      const bet = bets[i];
      const itemKey = `${key}:${i}`;
      const inserted = await client.query(
        `INSERT INTO roulette_bets(roulette_game_id,player_id,bet_type,selection,stake,payout_multiplier,potential_return,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [rouletteGameId, session.playerId, bet.betType, bet.selection, bet.stake, bet.multiplier, payoutForStake(bet.stake, bet.multiplier), itemKey],
      );
      const betId = Number(inserted.rows[0].id);
      betIds.push(betId);
      await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,roulette_game_id,roulette_bet_id,created_by,idempotency_key,metadata)
         VALUES($1,$2,$3,'ROULETTE_STAKE',$4,$5,$6,$7,'player',$8,$9::jsonb)`,
        [gameId, session.playerId, -bet.stake, `Roulette ${bet.betType.toLowerCase()} ${bet.selection}`, rg.rows[0].round_id, rouletteGameId, betId, itemKey, JSON.stringify({ selection: bet.selection, betType: bet.betType, multiplier: bet.multiplier })],
      );
    }
    await client.query('UPDATE wallets SET current_balance=current_balance-$1,updated_at=NOW() WHERE player_id=$2', [totalStake, session.playerId]);
    return { betIds, totalStake, version: await incrementGameVersion(client, gameId) };
  }));
});
