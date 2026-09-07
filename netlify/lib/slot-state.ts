import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http';
import {
  evaluateSlotConfig,
  outcomePercentage,
  symbolLetter,
  SLOT_OUTCOME_LABELS,
  SLOT_OUTCOME_TYPES,
  type SlotConfigStatus,
  type SlotOutcomeType,
  type SlotOutcomeWeight,
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

/** The block's own settings, read from the payload every other block type also uses. */
export type SlotBlockSettings = { maxSpins: number; instructions: string; allowedPlayerIds: number[] };

export function slotBlockSettings(payload: any): SlotBlockSettings {
  const maxSpins = Number(payload?.maxSpins);
  const allowed = Array.isArray(payload?.allowedPlayerIds) ? payload.allowedPlayerIds.map(Number).filter(Number.isInteger) : [];
  return {
    maxSpins: Number.isInteger(maxSpins) && maxSpins > 0 ? maxSpins : 10,
    instructions: typeof payload?.body === 'string' ? payload.body : '',
    // Empty means everyone; the endpoints treat it that way rather than as "nobody".
    allowedPlayerIds: allowed,
  };
}

export function playerMayPlaySlot(settings: SlotBlockSettings, playerId: number) {
  return settings.allowedPlayerIds.length === 0 || settings.allowedPlayerIds.includes(playerId);
}

/**
 * Close every live series on a slot block, refunding spins the player paid for but never
 * used.
 *
 * This is what stops a hidden slotmachine session running on after the Admin moves to
 * the next content block, and it is why moving on is allowed at all: blocking navigation
 * until every player finishes their reeks would let one player who walked away hold the
 * whole evening hostage. No coins are lost — only the unspun remainder is returned, and
 * spins already taken keep their outcome and payout.
 *
 * Callers must already hold the game row. Safe to call for any block type and to call
 * twice: the ledger's partial unique index on (slot_series_id,'SLOT_REFUND') means a
 * second attempt cannot pay a second refund.
 */
export async function closeSlotSeriesForBlock(
  client: PoolClient,
  gameId: number,
  blockId: number,
  actor: string,
  reason: string,
) {
  const series = await client.query(
    `SELECT id,player_id,round_id,stake_per_spin,spins_remaining
     FROM slot_series
     WHERE game_night_id=$1 AND round_block_id=$2 AND status='ACTIVE'
     ORDER BY player_id,id FOR UPDATE`,
    [gameId, blockId],
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
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,round_block_id,slot_series_id,created_by,idempotency_key,metadata)
         VALUES($1,$2,$3,'SLOT_REFUND',$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          gameId, row.player_id, refund, `Slotmachine refund: ${remaining} unused spin${remaining === 1 ? '' : 's'}`,
          row.round_id, blockId, row.id, actor, `slot:series:${row.id}:refund`,
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
