import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http';
import {
  cardLabel,
  countCorrectPredictions,
  isLive,
  playerAtTurn,
  predictionPoints,
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

export type PakEenZesResult = {
  playerId: number;
  playerName: string;
  picks: number[];
  /** Names, in the order they were picked — duplicates included. */
  pickNames: string[];
  correct: number;
  points: number;
};

export type PakEenZesGame = {
  id: number;
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
  /** The rate this game paid, or the current setting while it is still running. */
  pointsPerCorrect: number;
  /** Per-player results, once the sixes are known. Empty before any six is drawn. */
  results: PakEenZesResult[];
  live: boolean;
  finished: boolean;
};

const DECK_SIZE = 52;

/** Load one game with everything any surface needs. Null when the block has no game. */
export async function loadPakEenZesGame(db: Queryable, gameId: number, roundId: number): Promise<PakEenZesGame | null> {
  const games = await db.query(
    `SELECT id,round_id,status,turn_index
     FROM pak_een_zes_games
     WHERE game_night_id=$1 AND round_id=$2
     ORDER BY id DESC LIMIT 1`,
    [gameId, roundId],
  );
  const row = games.rows[0];
  if (!row) return null;
  const id = Number(row.id);

  const [participants, draws, predictions, allPicks, rate] = await Promise.all([
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
    // Every pick, in slot order, so scoring keeps the multiplicity intact.
    db.query(
      `SELECT pr.player_id,pr.slot,pr.predicted_player_id,pl.display_name AS predictor,
              target.display_name AS predicted_name
       FROM pak_een_zes_predictions pr
       JOIN players pl ON pl.id=pr.player_id
       JOIN players target ON target.id=pr.predicted_player_id
       WHERE pr.pak_een_zes_game_id=$1
       ORDER BY pr.player_id,pr.slot`,
      [id],
    ),
    // The snapshotted rate if this game already paid, otherwise the live setting.
    db.query(
      `SELECT COALESCE(g.points_per_correct, r.default_points) AS rate
       FROM pak_een_zes_games g JOIN rounds r ON r.id=g.round_id
       WHERE g.id=$1`,
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
  const pointsPerCorrect = Number(rate.rows[0]?.rate ?? 0);

  // Scored from the two records 0013 kept: the picks and the six events. Recomputed on
  // read rather than stored per player, so the breakdown shown always matches the rows.
  const sixDrawerIds = drawRows.filter(d => d.isSix).map(d => d.playerId);
  type Grouped = { name: string; picks: number[]; names: string[] };
  const byPredictor = new Map<number, Grouped>();
  for (const pick of allPicks.rows) {
    const predictorId = Number(pick.player_id);
    const entry: Grouped = byPredictor.get(predictorId) ?? { name: pick.predictor, picks: [], names: [] };
    entry.picks.push(Number(pick.predicted_player_id));
    entry.names.push(pick.predicted_name);
    byPredictor.set(predictorId, entry);
  }
  const results: PakEenZesResult[] = [...byPredictor.entries()]
    .filter(([, entry]) => entry.picks.length === 4)
    .map(([playerId, entry]) => {
      const correct = countCorrectPredictions(entry.picks, sixDrawerIds);
      return {
        playerId,
        playerName: entry.name,
        picks: entry.picks,
        pickNames: entry.names,
        correct,
        points: predictionPoints(correct, pointsPerCorrect),
      };
    })
    .sort((a, b) => b.correct - a.correct || a.playerName.localeCompare(b.playerName));

  return {
    id,
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
    pointsPerCorrect,
    results,
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
export async function closePakEenZesForRound(client: PoolClient, gameId: number, roundId: number) {
  const { rowCount } = await client.query(
    `UPDATE pak_een_zes_games
     SET status='CANCELLED',finished_at=COALESCE(finished_at,NOW()),updated_at=NOW()
     WHERE game_night_id=$1 AND round_id=$2 AND status IN ('READY','PREDICTING','LOCKED','DRAWING')`,
    [gameId, roundId],
  );
  return { cancelled: rowCount ?? 0 };
}

/**
 * Pay out a finished game's predictions.
 *
 * Called from inside the transaction that drew the fourth six, so the reward lands with
 * the event that earned it — no separate Admin action to forget, and no window where the
 * game is over but unpaid.
 *
 * Every correct prediction is worth the same Admin-set amount. The rate is read here and
 * snapshotted onto the game row, so changing Settings afterwards never rewrites what a
 * finished game awarded.
 *
 * Paying twice is impossible rather than unlikely: the ledger's partial unique index on
 * (game, player) for `PAK_EEN_ZES_REWARD` means a retry conflicts instead of crediting
 * again, and the conflict is verified against the row that already exists rather than
 * swallowed.
 */
export async function awardPakEenZesPredictions(
  client: PoolClient,
  gameId: number,
  pakEenZesGameId: number,
  actor: string,
) {
  // Prefer the snapshot if this game already paid. A retry must recompute the same
  // amounts it paid the first time — reading the live setting instead would make a retry
  // after any Settings change look like a conflicting transaction and throw, when in
  // fact nothing needs doing.
  const rateRow = await client.query(
    `SELECT COALESCE(g.points_per_correct, r.default_points) AS rate
     FROM pak_een_zes_games g JOIN rounds r ON r.id=g.round_id
     WHERE g.id=$1`,
    [pakEenZesGameId],
  );
  const pointsPerCorrect = Number(rateRow.rows[0]?.rate ?? 0);

  // Snapshot the rate on the game, so the result breakdown every surface shows is the
  // rate that was actually paid.
  await client.query(
    'UPDATE pak_een_zes_games SET points_per_correct=$2,updated_at=NOW() WHERE id=$1 AND points_per_correct IS NULL',
    [pakEenZesGameId, pointsPerCorrect],
  );

  const game = await client.query(
    'SELECT round_id FROM pak_een_zes_games WHERE id=$1',
    [pakEenZesGameId],
  );
  const roundId = game.rows[0]?.round_id ?? null;

  const [picks, sixes] = await Promise.all([
    client.query(
      `SELECT player_id,predicted_player_id FROM pak_een_zes_predictions
       WHERE pak_een_zes_game_id=$1 ORDER BY player_id,slot`,
      [pakEenZesGameId],
    ),
    client.query(
      'SELECT player_id FROM pak_een_zes_draws WHERE pak_een_zes_game_id=$1 AND is_six ORDER BY draw_number',
      [pakEenZesGameId],
    ),
  ]);

  const sixDrawerIds = sixes.rows.map((r: any) => Number(r.player_id));
  const byPredictor = new Map<number, number[]>();
  for (const row of picks.rows) {
    const predictorId = Number(row.player_id);
    byPredictor.set(predictorId, [...(byPredictor.get(predictorId) || []), Number(row.predicted_player_id)]);
  }

  let awarded = 0;
  let totalPoints = 0;
  // Ordered so concurrent transactions take the wallet locks in the same sequence.
  for (const predictorId of [...byPredictor.keys()].sort((a, b) => a - b)) {
    const own = byPredictor.get(predictorId)!;
    if (own.length !== 4) continue; // an incomplete prediction never scores
    const correct = countCorrectPredictions(own, sixDrawerIds);
    const points = predictionPoints(correct, pointsPerCorrect);
    if (points <= 0) continue;

    const wallet = await client.query(
      'SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE',
      [predictorId, gameId],
    );
    if (!wallet.rows[0]) continue; // a removed player has no wallet to credit

    const ledger = await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
        attributed_round_id,pak_een_zes_game_id,created_by,idempotency_key,metadata)
       VALUES($1,$2,$3,'PAK_EEN_ZES_REWARD',$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        gameId, predictorId, points,
        `Pak een Zes: ${correct} correcte voorspelling${correct === 1 ? '' : 'en'}`,
        roundId, pakEenZesGameId, actor,
        `pakeenzes:${pakEenZesGameId}:reward:${predictorId}`,
        JSON.stringify({ correct, pointsPerCorrect }),
      ],
    );

    if (ledger.rows[0]) {
      await client.query(
        'UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2',
        [points, predictorId],
      );
      awarded += 1;
      totalPoints += points;
    } else {
      // Already paid. Verify it matches rather than assuming, so a key collision with a
      // different amount surfaces instead of silently passing.
      const existing = await client.query(
        `SELECT amount FROM ledger_entries
         WHERE pak_een_zes_game_id=$1 AND player_id=$2 AND transaction_type='PAK_EEN_ZES_REWARD'`,
        [pakEenZesGameId, predictorId],
      );
      if (!existing.rows[0] || Number(existing.rows[0].amount) !== points) {
        throw new HttpError(409, 'Pak een Zes reward conflicts with an existing transaction');
      }
    }
  }

  return { awarded, totalPoints, pointsPerCorrect };
}
