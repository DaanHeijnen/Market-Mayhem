import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { payoutForStake, rouletteBetWins, type RouletteBetType } from './economy';

/**
 * Settling a roulette run, and starting the next one.
 *
 * A `roulette_games` row is one *run* of the wheel within a ROULETTE round. A round holds
 * as many as the host wants: OPEN BETTING AGAIN adds a run, the round stays ACTIVE, and
 * every finished run keeps its own bets, its own ledger entries and its own frozen totals.
 *
 * Settlement is not an Admin action any more. The moment the result becomes final — which
 * is when the spin animation window elapses and the run leaves SPINNING — the same
 * transaction that makes it final pays everybody. There is no window in which the room can
 * see a number that nobody has been paid for, and no button whose absence loses money.
 */

/** How long the wheel is presentationally spinning before its result is final. */
export const ROULETTE_SPIN_MS = 5500;

/** Statuses in which a run is still the round's live table. */
export const LIVE_ROULETTE_STATUSES = ['DRAFT', 'OPEN', 'LOCKED', 'SPINNING', 'RESULT'] as const;

export type RouletteSettlement = {
  rouletteGameId: number;
  resultNumber: number;
  /** Coins players put on the table in this run. */
  totalStaked: number;
  /** Coins paid back out, gross: returned stake plus winnings, as the ledger moved them. */
  totalPayout: number;
  /** Unique players who placed at least one bet. Five chips is still one participant. */
  participantCount: number;
  /** Bets moved out of ACTIVE by this call. Zero on a replay. */
  betsSettled: number;
};

/**
 * Pay out one run and close it.
 *
 * The caller must already hold the `roulette_games` row and must have established that
 * the result is final. Everything below happens in the caller's transaction, so wallets,
 * ledger entries, bet statuses and the run's frozen totals commit together or not at all.
 *
 * Idempotent along two independent lines, which is what makes a retry or a racing timer
 * harmless. Each payout carries the business key `roulette:payout:bet:<betId>` and is
 * further pinned by `ledger_unique_roulette_bet_action`, so one bet can be paid once
 * however many times this runs. And the bet update is guarded on `status='ACTIVE'`, so
 * a second pass finds nothing to settle and reports zero.
 */
export async function settleRouletteRun(
  client: PoolClient,
  gameId: number,
  rouletteGameId: number,
  actor: string,
): Promise<RouletteSettlement> {
  const runResult = await client.query(
    'SELECT id,round_id,status,result_number FROM roulette_games WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
    [rouletteGameId, gameId],
  );
  const run = runResult.rows[0];
  if (!run) throw new HttpError(404, 'Roulette run not found');
  if (run.result_number == null) throw new HttpError(409, 'This roulette run has no result to settle');
  const resultNumber = Number(run.result_number);

  const bets = await client.query(
    `SELECT id,player_id,bet_type,selection,stake,payout_multiplier,status
     FROM roulette_bets WHERE roulette_game_id=$1 ORDER BY player_id,id FOR UPDATE`,
    [rouletteGameId],
  );

  let totalStaked = 0;
  let totalPayout = 0;
  let betsSettled = 0;
  const participants = new Set<number>();

  for (const bet of bets.rows) {
    // A refunded bet never took part in the spin, so it is in neither total.
    if (bet.status === 'REFUNDED') continue;
    const stake = Number(bet.stake);
    totalStaked += stake;
    participants.add(Number(bet.player_id));

    const won = rouletteBetWins(bet.bet_type as RouletteBetType, bet.selection, resultNumber);
    const credit = won ? payoutForStake(stake, Number(bet.payout_multiplier)) : 0;
    if (credit > 0) totalPayout += credit;

    // Only a bet still standing gets touched. On a replay every bet is already WON or
    // LOST and this whole block is skipped, while the totals above are recomputed from
    // the same rows and come out the same.
    if (bet.status !== 'ACTIVE') continue;

    if (credit > 0) {
      const wallet = await client.query(
        'SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE',
        [bet.player_id, gameId],
      );
      if (!wallet.rows[0]) throw new HttpError(409, 'Roulette player wallet is missing');

      // Deterministic key rather than one derived from a request: the settling caller may
      // be a timer with no request to take a header from, and the bet is the business key
      // either way — one bet, one payout, for all time.
      const ledger = await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,roulette_game_id,roulette_bet_id,created_by,idempotency_key)
         VALUES($1,$2,$3,'ROULETTE_PAYOUT',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
        [
          gameId, bet.player_id, credit, `Roulette ${resultNumber} payout`,
          run.round_id, rouletteGameId, bet.id, actor, `roulette:payout:bet:${bet.id}`,
        ],
      );
      if (ledger.rows[0]) {
        await client.query(
          'UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2',
          [credit, bet.player_id],
        );
      }
      // No entry means this bet was already paid, by an earlier pass of this same
      // function. The wallet move went with it, so there is nothing to repair.
    }

    const moved = await client.query(
      "UPDATE roulette_bets SET status=$2,settled_at=NOW() WHERE id=$1 AND status='ACTIVE' RETURNING id",
      [bet.id, won ? 'WON' : 'LOST'],
    );
    if (moved.rows[0]) betsSettled += 1;
  }

  const participantCount = participants.size;

  // Frozen here rather than derived later: this is what the room was told the spin paid.
  await client.query(
    `UPDATE roulette_games
     SET status='SETTLED',settled_at=COALESCE(settled_at,NOW()),updated_at=NOW(),
         total_staked=$2,total_payout=$3,participant_count=$4
     WHERE id=$1`,
    [rouletteGameId, totalStaked, totalPayout, participantCount],
  );

  return { rouletteGameId, resultNumber, totalStaked, totalPayout, participantCount, betsSettled };
}

/**
 * Start another run of the wheel in the same round.
 *
 * Adds a row; changes no round. The previous run keeps its bets, its payouts and its
 * totals, and the new one starts empty — which is the whole point, because bets leaking
 * from one spin into the next would pay the wrong people.
 *
 * `one_live_roulette_run_per_round` is the backstop behind the row lock the caller holds:
 * two OPEN BETTING AGAIN clicks cannot produce two tables for players to split across.
 */
export async function openNextRouletteRun(
  client: PoolClient,
  gameId: number,
  roundId: number,
): Promise<{ rouletteGameId: number; runNumber: number }> {
  const live = await client.query(
    `SELECT id,run_number,status FROM roulette_games
     WHERE game_night_id=$1 AND round_id=$2 AND status = ANY($3::text[])
     ORDER BY run_number DESC LIMIT 1`,
    [gameId, roundId, LIVE_ROULETTE_STATUSES as unknown as string[]],
  );
  if (live.rows[0]) {
    throw new HttpError(409, `Run ${live.rows[0].run_number} is still ${live.rows[0].status} — finish it before opening another`);
  }

  const inserted = await client.query(
    `INSERT INTO roulette_games(game_night_id,round_id,status,run_number)
     SELECT $1,$2,'DRAFT',COALESCE(MAX(run_number),0)+1 FROM roulette_games WHERE round_id=$2
     RETURNING id,run_number`,
    [gameId, roundId],
  );
  return { rouletteGameId: Number(inserted.rows[0].id), runNumber: Number(inserted.rows[0].run_number) };
}
