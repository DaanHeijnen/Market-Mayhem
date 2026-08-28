import type { Pool, PoolClient } from 'pg';
import { database } from './db';
import { HttpError } from './http';
import {
  SLOT_SYMBOLS_PER_REEL,
  SLOT_REELS,
  slotConfigurationStatus,
  slotSymbolLetter,
  type SlotConfigurationStatus,
} from './slot';

export interface SlotSettingsRow {
  game_night_id: number;
  total_probability_pool: number;
  maximum_spins: number;
  minimum_stake: number;
  maximum_stake: number;
}

export interface SlotSettings {
  totalProbabilityPool: number;
  maximumSpins: number;
  minimumStake: number;
  maximumStake: number;
}

type Queryable = Pool | PoolClient;

export function normalizeSlotSettings(row: SlotSettingsRow | undefined): SlotSettings {
  return {
    totalProbabilityPool: Number(row?.total_probability_pool ?? 100),
    maximumSpins: Number(row?.maximum_spins ?? 20),
    minimumStake: Number(row?.minimum_stake ?? 1),
    maximumStake: Number(row?.maximum_stake ?? 500),
  };
}

/**
 * Slot settings are created lazily so games that predate migration 0007 and
 * games created afterwards behave identically. The row is locked because every
 * caller inside a transaction is about to validate money against it.
 */
export async function lockSlotSettings(client: PoolClient, gameId: number) {
  await client.query(
    `INSERT INTO slot_settings (game_night_id) VALUES ($1) ON CONFLICT (game_night_id) DO NOTHING`,
    [gameId],
  );
  const { rows } = await client.query<SlotSettingsRow>('SELECT * FROM slot_settings WHERE game_night_id=$1 FOR UPDATE', [gameId]);
  if (!rows[0]) throw new HttpError(404, 'Game not found');
  return normalizeSlotSettings(rows[0]);
}

export async function readSlotSettings(source: Queryable, gameId: number) {
  const { rows } = await source.query<SlotSettingsRow>('SELECT * FROM slot_settings WHERE game_night_id=$1', [gameId]);
  return normalizeSlotSettings(rows[0]);
}

export async function slotTotals(source: Queryable, gameId: number) {
  const { rows } = await source.query<{ assigned_weight: string; outcome_count: string; symbol_count: string }>(
    `SELECT
       COALESCE((SELECT SUM(weight) FROM slot_outcomes WHERE game_night_id=$1),0)::int AS assigned_weight,
       (SELECT COUNT(*) FROM slot_outcomes WHERE game_night_id=$1 AND weight>0)::int AS outcome_count,
       (SELECT COUNT(*) FROM slot_symbols WHERE game_night_id=$1)::int AS symbol_count`,
    [gameId],
  );
  const row = rows[0];
  return {
    assignedWeight: Number(row?.assigned_weight || 0),
    weightedOutcomeCount: Number(row?.outcome_count || 0),
    symbolCount: Number(row?.symbol_count || 0),
  };
}

export interface SlotStatusSnapshot {
  settings: SlotSettings;
  status: SlotConfigurationStatus;
  weightedOutcomeCount: number;
}

export async function slotStatus(source: Queryable, gameId: number, settings?: SlotSettings): Promise<SlotStatusSnapshot> {
  const resolved = settings ?? await readSlotSettings(source, gameId);
  const totals = await slotTotals(source, gameId);
  return {
    settings: resolved,
    weightedOutcomeCount: totals.weightedOutcomeCount,
    status: slotConfigurationStatus({
      totalPool: resolved.totalProbabilityPool,
      assignedWeight: totals.assignedWeight,
      symbolCount: totals.symbolCount,
    }),
  };
}

export interface SlotSymbolMeta {
  reel: number;
  position: number;
  letter: string;
  checksum: string;
  byteSize: number;
  originalFilename: string | null;
  updatedAt: string;
}

export async function readSlotSymbolMeta(source: Queryable, gameId: number): Promise<SlotSymbolMeta[]> {
  const { rows } = await source.query(
    `SELECT reel,symbol_position,checksum,byte_size,original_filename,updated_at
     FROM slot_symbols WHERE game_night_id=$1 ORDER BY reel,symbol_position`,
    [gameId],
  );
  return rows.map((row: any) => ({
    reel: Number(row.reel),
    position: Number(row.symbol_position),
    letter: slotSymbolLetter(Number(row.symbol_position)),
    checksum: row.checksum,
    byteSize: Number(row.byte_size),
    originalFilename: row.original_filename,
    updatedAt: row.updated_at,
  }));
}

/**
 * Every combination that carries a weight or a payout. Combinations that carry
 * neither are not stored: 1728 rows per game would be written for no reason.
 */
export async function readSlotOutcomes(source: Queryable, gameId: number) {
  const { rows } = await source.query(
    `SELECT reel1_position,reel2_position,reel3_position,weight,payout_multiplier
     FROM slot_outcomes WHERE game_night_id=$1 AND (weight>0 OR payout_multiplier>0)
     ORDER BY reel1_position,reel2_position,reel3_position`,
    [gameId],
  );
  return rows.map((row: any) => ({
    reel1: Number(row.reel1_position),
    reel2: Number(row.reel2_position),
    reel3: Number(row.reel3_position),
    weight: Number(row.weight),
    payoutMultiplier: Number(row.payout_multiplier),
  }));
}

export async function getSlotConfig(gameId: number) {
  const pool = database().pool;
  const game = await pool.query('SELECT id FROM game_nights WHERE id=$1', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');
  const settings = await readSlotSettings(pool, gameId);
  const [snapshot, symbols, outcomes] = await Promise.all([
    slotStatus(pool, gameId, settings),
    readSlotSymbolMeta(pool, gameId),
    readSlotOutcomes(pool, gameId),
  ]);
  return {
    gameId,
    reels: SLOT_REELS,
    symbolsPerReel: SLOT_SYMBOLS_PER_REEL,
    settings,
    status: snapshot.status,
    weightedOutcomeCount: snapshot.weightedOutcomeCount,
    symbols,
    outcomes,
  };
}

/** The full ordered weighted table used by the randomizer, locked for the spin. */
export async function lockWeightedOutcomes(client: PoolClient, gameId: number) {
  const { rows } = await client.query(
    `SELECT reel1_position,reel2_position,reel3_position,weight,payout_multiplier
     FROM slot_outcomes WHERE game_night_id=$1 AND weight>0
     ORDER BY reel1_position,reel2_position,reel3_position`,
    [gameId],
  );
  return rows.map((row: any) => ({
    reel1: Number(row.reel1_position),
    reel2: Number(row.reel2_position),
    reel3: Number(row.reel3_position),
    weight: Number(row.weight),
    payoutMultiplier: Number(row.payout_multiplier),
  }));
}
