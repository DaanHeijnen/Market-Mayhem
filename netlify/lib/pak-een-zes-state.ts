import type { Pool, PoolClient } from 'pg';
import {
  cardLabel,
  isLive,
  playerAtTurn,
  type Card,
  type PakEenZesStatus,
  type Rank,
  type Suit,
} from './pak-een-zes';

/**
 * Database-facing Pak een Zes helpers: reading a game's full state, and closing one out.
 *
 * The rules themselves live in pak-een-zes.ts. This file is only the bridge between them
 * and PostgreSQL, so the read paths (queries.ts) and the write paths (the endpoints)
 * agree on what a game looks like.
 */

type Queryable = Pool | PoolClient;

export type PakEenZesParticipant = { playerId: number; name: string; color: string; turnOrder: number };
export type PakEenZesDraw = {
  id: number;
  drawNumber: number;
  playerId: number;
  playerName: string;
  rank: Rank;
  suit: Suit;
  label: string;
  isSix: boolean;
  drawnAt: string;
};

export type PakEenZesGame = {
  id: number;
  blockId: number | null;
  roundId: number | null;
  status: PakEenZesStatus;
  turnIndex: number;
  participants: PakEenZesParticipant[];
  /** Whose turn it is, or null outside the drawing phase. */
  currentPlayer: PakEenZesParticipant | null;
  draws: PakEenZesDraw[];
  /** Only the sixes, in draw order — the record a later scoring pass reads. */
  sixes: PakEenZesDraw[];
  drawnCount: number;
  cardsRemaining: number;
  /** Player ids that have submitted all four picks. */
  predictedPlayerIds: number[];
  predictionCount: number;
  live: boolean;
  finished: boolean;
};

const DECK_SIZE = 52;

/** Load one game with everything any surface needs. Null when the block has no game. */
export async function loadPakEenZesGame(db: Queryable, gameId: number, blockId: number): Promise<PakEenZesGame | null> {
  const games = await db.query(
    `SELECT id,round_id,round_block_id,status,turn_index
     FROM pak_een_zes_games
     WHERE game_night_id=$1 AND round_block_id=$2
     ORDER BY id DESC LIMIT 1`,
    [gameId, blockId],
  );
  const row = games.rows[0];
  if (!row) return null;
  const id = Number(row.id);

  const [participants, draws, predictions] = await Promise.all([
    db.query(
      `SELECT p.player_id,p.turn_order,pl.display_name,pl.public_color
       FROM pak_een_zes_participants p JOIN players pl ON pl.id=p.player_id
       WHERE p.pak_een_zes_game_id=$1 ORDER BY p.turn_order`,
      [id],
    ),
    db.query(
      `SELECT d.id,d.draw_number,d.player_id,d.rank,d.suit,d.is_six,d.created_at,pl.display_name
       FROM pak_een_zes_draws d JOIN players pl ON pl.id=d.player_id
       WHERE d.pak_een_zes_game_id=$1 ORDER BY d.draw_number`,
      [id],
    ),
    // A prediction only counts once all four slots are in, which is what makes the
    // Admin's "who is still missing" list trustworthy.
    db.query(
      `SELECT player_id FROM pak_een_zes_predictions
       WHERE pak_een_zes_game_id=$1
       GROUP BY player_id HAVING COUNT(*)=4`,
      [id],
    ),
  ]);

  const participantRows: PakEenZesParticipant[] = participants.rows.map((p: any) => ({
    playerId: Number(p.player_id),
    name: p.display_name,
    color: p.public_color,
    turnOrder: Number(p.turn_order),
  }));

  const drawRows: PakEenZesDraw[] = draws.rows.map((d: any) => ({
    id: Number(d.id),
    drawNumber: Number(d.draw_number),
    playerId: Number(d.player_id),
    playerName: d.display_name,
    rank: d.rank as Rank,
    suit: d.suit as Suit,
    label: cardLabel({ rank: d.rank as Rank, suit: d.suit as Suit }),
    isSix: Boolean(d.is_six),
    drawnAt: d.created_at,
  }));

  const status = row.status as PakEenZesStatus;
  const turnIndex = Number(row.turn_index);

  return {
    id,
    blockId: row.round_block_id ? Number(row.round_block_id) : null,
    roundId: row.round_id ? Number(row.round_id) : null,
    status,
    turnIndex,
    participants: participantRows,
    currentPlayer: status === 'DRAWING' ? playerAtTurn(participantRows, turnIndex) : null,
    draws: drawRows,
    sixes: drawRows.filter(d => d.isSix),
    drawnCount: drawRows.length,
    cardsRemaining: DECK_SIZE - drawRows.length,
    predictedPlayerIds: predictions.rows.map((p: any) => Number(p.player_id)),
    predictionCount: predictions.rowCount ?? 0,
    live: isLive(status),
    finished: status === 'FINISHED',
  };
}

/** The cards already out, in the shape the rules module expects. */
export async function drawnCards(db: Queryable, pakEenZesGameId: number): Promise<Card[]> {
  const { rows } = await db.query(
    'SELECT rank,suit FROM pak_een_zes_draws WHERE pak_een_zes_game_id=$1',
    [pakEenZesGameId],
  );
  return rows.map((r: any) => ({ rank: r.rank as Rank, suit: r.suit as Suit }));
}

/** The block's own settings, read from the payload every other block type also uses. */
export type PakEenZesBlockSettings = { instructions: string };

export function pakEenZesBlockSettings(payload: any): PakEenZesBlockSettings {
  return { instructions: typeof payload?.body === 'string' ? payload.body : '' };
}

/**
 * Close out any live game on a block.
 *
 * Called when the host moves to another content block or completes the round. No coins
 * are involved, so unlike a slotmachine series there is nothing to refund — but leaving
 * a game in DRAWING would keep a turn indicator live on somebody's phone for a game
 * nobody is watching any more. The draws and predictions are kept: they are the record
 * a later scoring pass reads, and cancelling must not erase history.
 *
 * A game that already finished is left alone. Safe to call for any block type.
 */
export async function closePakEenZesForBlock(client: PoolClient, gameId: number, blockId: number) {
  const { rowCount } = await client.query(
    `UPDATE pak_een_zes_games
     SET status='CANCELLED',finished_at=COALESCE(finished_at,NOW()),updated_at=NOW()
     WHERE game_night_id=$1 AND round_block_id=$2 AND status IN ('READY','PREDICTING','LOCKED','DRAWING')`,
    [gameId, blockId],
  );
  return { cancelled: rowCount ?? 0 };
}
