import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http';
import {
  evaluateSlotConfig,
  outcomePercentage,
  resolveSlotTurn,
  symbolLetter,
  SLOT_MAX_SPINS_LIMIT,
  SLOT_OUTCOME_LABELS,
  SLOT_OUTCOME_TYPES,
  type SlotConfigStatus,
  type SlotOutcomeType,
  type SlotOutcomeWeight,
  type SlotSeriesTurn,
  type SlotTurn,
} from './slotmachine';

/**
 * Database-facing slotmachine helpers: reading the game-wide configuration, and closing
 * out player series safely.
 *
 * The rules themselves live in slotmachine.ts. This file is only the bridge between them
 * and PostgreSQL, so both the read paths (queries.ts) and the write paths (the endpoints)
 * agree on what a valid machine is.
 */

type Queryable = Pool | PoolClient;

/** One of the twelve shared symbols. No `reel`: all three reels use the same set. */
export type SlotSymbol = { position: number; letter: string; mediaKey: string };

export type SlotOutcomeRow = SlotOutcomeWeight & { label: string; percentage: number };

export type SlotConfig = {
  totalWeight: number;
  symbols: SlotSymbol[];
  /** The five fixed outcome types, always all five and always in category order. */
  outcomeTypes: SlotOutcomeRow[];
  status: SlotConfigStatus;
  /** position → blob key, for landing the reels on the right artwork. */
  symbolByPosition: Record<number, string>;
  /** Positions that have artwork, which is what the generator may draw from. */
  availableSymbols: number[];
};

export async function loadSlotConfig(db: Queryable, gameId: number): Promise<SlotConfig> {
  const [config, symbols, outcomes] = await Promise.all([
    db.query('SELECT total_weight FROM slot_configs WHERE game_night_id=$1', [gameId]),
    db.query('SELECT position,media_key FROM slot_reel_symbols WHERE game_night_id=$1 ORDER BY position', [gameId]),
    db.query('SELECT outcome_type,weight,payout_multiplier FROM slot_outcome_types WHERE game_night_id=$1', [gameId]),
  ]);

  // A game predating this feature, or one whose config row was never written, behaves as
  // the default denominator with nothing allocated — invalid, but describable.
  const totalWeight = Number(config.rows[0]?.total_weight ?? 100);

  const symbolRows: SlotSymbol[] = symbols.rows.map((row: any) => ({
    position: Number(row.position),
    letter: symbolLetter(Number(row.position)),
    mediaKey: row.media_key,
  }));
  const symbolByPosition: Record<number, string> = {};
  const positions = new Set<number>();
  for (const symbol of symbolRows) {
    symbolByPosition[symbol.position] = symbol.mediaKey;
    positions.add(symbol.position);
  }

  // Always report all five categories in a stable order, filling in zeros for any a
  // game predating this model has no row for. Settings renders a fixed five-row table,
  // so an absent row must read as "no chance yet" rather than vanishing.
  const stored = new Map<SlotOutcomeType, { weight: number; payoutMultiplier: number }>();
  for (const row of outcomes.rows) {
    stored.set(row.outcome_type as SlotOutcomeType, {
      weight: Number(row.weight),
      payoutMultiplier: Number(row.payout_multiplier),
    });
  }
  const outcomeTypes: SlotOutcomeRow[] = SLOT_OUTCOME_TYPES.map(type => {
    const row = stored.get(type);
    const weight = row?.weight ?? 0;
    return {
      type,
      weight,
      // A stored payout on NO_WIN would be a constraint violation, but normalise on read
      // too so a hand-edited database cannot make the projector promise a payout.
      payoutMultiplier: type === 'NO_WIN' ? 0 : row?.payoutMultiplier ?? 0,
      label: SLOT_OUTCOME_LABELS[type],
      percentage: outcomePercentage(weight, totalWeight),
    };
  });

  const status = evaluateSlotConfig(totalWeight, outcomeTypes, positions);

  return {
    totalWeight,
    symbols: symbolRows,
    symbolByPosition,
    availableSymbols: [...positions].sort((a, b) => a - b),
    status,
    outcomeTypes,
  };
}

/**
 * The round's own slotmachine settings.
 *
 * Read from `slotmachine_rounds` and `slotmachine_round_participants` rather than from a
 * payload, so an allowlist naming a player who has since been removed simply has no row
 * instead of a dangling id. `maxSpins` is still clamped on read as well as on write, so a
 * round authored before the ten-spin rule cannot sell a longer run.
 */
export type SlotRoundSettings = { maxSpins: number; allowedPlayerIds: number[] };

export async function loadSlotRoundSettings(db: Queryable, roundId: number): Promise<SlotRoundSettings> {
  const [config, participants] = await Promise.all([
    db.query('SELECT max_spins FROM slotmachine_rounds WHERE round_id=$1', [roundId]),
    db.query('SELECT player_id FROM slotmachine_round_participants WHERE round_id=$1 ORDER BY player_id', [roundId]),
  ]);
  const maxSpins = Number(config.rows[0]?.max_spins);
  return {
    maxSpins: Math.min(
      SLOT_MAX_SPINS_LIMIT,
      Number.isInteger(maxSpins) && maxSpins > 0 ? maxSpins : SLOT_MAX_SPINS_LIMIT,
    ),
    // No rows means everyone; the endpoints treat it that way rather than as "nobody".
    allowedPlayerIds: participants.rows.map((r: any) => Number(r.player_id)),
  };
}

export function playerMayPlaySlot(settings: SlotRoundSettings, playerId: number) {
  return settings.allowedPlayerIds.length === 0 || settings.allowedPlayerIds.includes(playerId);
}

/**
 * Close every live series on a slot block, refunding spins the player paid for but never
 * used.
 *
 * This is what stops a hidden slotmachine session running on after the Admin moves on
 * to the next round, and it is why moving on is allowed at all: blocking navigation
 * until every player finishes their reeks would let one player who walked away hold the
 * whole evening hostage. No coins are lost — only the unspun remainder is returned, and
 * spins already taken keep their outcome and payout.
 *
 * Callers must already hold the game row. Safe to call for any round type and to call
 * twice: the ledger's partial unique index on (slot_series_id,'SLOT_REFUND') means a
 * second attempt cannot pay a second refund.
 */
export async function closeSlotSeriesForRound(
  client: PoolClient,
  gameId: number,
  roundId: number,
  actor: string,
  reason: string,
) {
  const series = await client.query(
    `SELECT id,player_id,round_id,stake_per_spin,spins_remaining
     FROM slot_series
     WHERE game_night_id=$1 AND round_id=$2 AND status='ACTIVE'
     ORDER BY player_id,id FOR UPDATE`,
    [gameId, roundId],
  );
  if (!series.rows.length) return { closed: 0, refunded: 0 };

  let refundedTotal = 0;
  for (const row of series.rows) {
    const remaining = Number(row.spins_remaining);
    const refund = remaining * Number(row.stake_per_spin);

    if (refund > 0) {
      const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [row.player_id, gameId]);
      if (!wallet.rows[0]) throw new HttpError(409, 'Slotmachine player wallet is missing');
      const ledger = await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,slot_series_id,created_by,idempotency_key,metadata)
         VALUES($1,$2,$3,'SLOT_REFUND',$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          gameId, row.player_id, refund, `Slotmachine refund: ${remaining} unused spin${remaining === 1 ? '' : 's'}`,
          row.round_id, row.id, actor, `slot:series:${row.id}:refund`,
          JSON.stringify({ reason, unusedSpins: remaining, stakePerSpin: Number(row.stake_per_spin) }),
        ],
      );
      if (ledger.rows[0]) {
        await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [refund, row.player_id]);
        refundedTotal += refund;
      } else {
        const existing = await client.query(
          "SELECT player_id,amount FROM ledger_entries WHERE slot_series_id=$1 AND transaction_type='SLOT_REFUND'",
          [row.id],
        );
        if (!existing.rows[0] || Number(existing.rows[0].player_id) !== Number(row.player_id) || Number(existing.rows[0].amount) !== refund) {
          throw new HttpError(409, 'Slotmachine refund idempotency key conflicts with another transaction');
        }
      }
    }

    await client.query(
      `UPDATE slot_series
       SET status=$2,refunded_spins=$3,spins_remaining=0,closed_at=NOW()
       WHERE id=$1`,
      [row.id, remaining > 0 ? 'CANCELLED' : 'COMPLETED', remaining],
    );
  }

  return { closed: series.rows.length, refunded: refundedTotal };
}

/**
 * Read the turn for one slotmachine round.
 *
 * Turn order is lock order, so the series are read by id. A spin still sitting at
 * SPINNING holds the turn with its player until it resolves, which is what stops the
 * projector cutting away from someone's final result.
 */
export async function loadSlotTurn(db: Queryable, gameId: number, roundId: number): Promise<SlotTurn & { spinningSpinId: number | null }> {
  const [series, spinning] = await Promise.all([
    db.query(
      `SELECT sr.id,sr.player_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.status,p.display_name
       FROM slot_series sr JOIN players p ON p.id=sr.player_id
       WHERE sr.game_night_id=$1 AND sr.round_id=$2
       ORDER BY sr.id`,
      [gameId, roundId],
    ),
    // A spin is "in progress" exactly while it is SPINNING; the timed sync that reveals
    // it is the same one the roulette result uses.
    db.query(
      `SELECT id,player_id FROM slot_spins
       WHERE round_id=$1 AND game_night_id=$2 AND status='SPINNING'
       ORDER BY id DESC LIMIT 1`,
      [roundId, gameId],
    ),
  ]);

  const rows: SlotSeriesTurn[] = series.rows.map((row: any) => ({
    seriesId: Number(row.id),
    playerId: Number(row.player_id),
    playerName: row.display_name,
    stakePerSpin: Number(row.stake_per_spin),
    totalSpins: Number(row.total_spins),
    spinsRemaining: Number(row.spins_remaining),
    status: row.status,
  }));

  const spinningRow = spinning.rows[0];
  const turn = resolveSlotTurn(rows, spinningRow ? Number(spinningRow.player_id) : null);
  return { ...turn, spinningSpinId: spinningRow ? Number(spinningRow.id) : null };
}

/**
 * Whether every player this slotmachine round was waiting for has finished their run.
 *
 * "Eligible" is the round's allowlist when it has one, and every active player when it
 * does not — the same rule `playerMayPlaySlot` enforces on the way in, so the set that may
 * play and the set the round waits for are the same set.
 *
 * "Finished" means a series with no spins left. A cancelled series does not count as
 * having played, because it was refunded rather than used.
 *
 * A player who never locks a series keeps the round open. That is deliberate: ending the
 * round the moment the others are done would cut off someone who was still deciding, and
 * the host can always complete the round by hand. The automatic path is for the ordinary
 * case where everybody plays.
 */
export async function slotRoundIsFinished(db: Queryable, gameId: number, roundId: number) {
  const { rows } = await db.query(
    `WITH eligible AS (
       SELECT p.id
       FROM players p
       WHERE p.game_night_id=$1 AND p.active=TRUE
         AND (
           NOT EXISTS (SELECT 1 FROM slotmachine_round_participants sp WHERE sp.round_id=$2)
           OR EXISTS (SELECT 1 FROM slotmachine_round_participants sp WHERE sp.round_id=$2 AND sp.player_id=p.id)
         )
     ),
     played AS (
       SELECT DISTINCT sr.player_id
       FROM slot_series sr
       WHERE sr.game_night_id=$1 AND sr.round_id=$2 AND sr.status<>'CANCELLED' AND sr.spins_remaining=0
     )
     SELECT
       (SELECT COUNT(*)::int FROM eligible) AS eligible_count,
       (SELECT COUNT(*)::int FROM eligible e JOIN played pl ON pl.player_id=e.id) AS finished_count,
       EXISTS(SELECT 1 FROM slot_series sr WHERE sr.game_night_id=$1 AND sr.round_id=$2 AND sr.status='ACTIVE' AND sr.spins_remaining>0) AS spins_left,
       EXISTS(SELECT 1 FROM slot_spins ss WHERE ss.game_night_id=$1 AND ss.round_id=$2 AND ss.status='SPINNING') AS spinning`,
    [gameId, roundId],
  );
  const row = rows[0];
  const eligibleCount = Number(row?.eligible_count ?? 0);
  const finishedCount = Number(row?.finished_count ?? 0);
  return {
    eligibleCount,
    finishedCount,
    // Never on an empty round: a slotmachine nobody was eligible for has not "finished".
    finished: eligibleCount > 0
      && finishedCount >= eligibleCount
      && !row?.spins_left
      && !row?.spinning,
  };
}
