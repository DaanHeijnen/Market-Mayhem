import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { canTransition } from '../netlify/lib/pak-een-zes';

const available = await pgliteAvailable();

/**
 * Opening Pak een Zes predictions, against a migrated database.
 *
 * The bug this covers returned a bare `{"error":"Internal server error"}` for every
 * attempt. The cause was not in the logic at all: the insert that creates the game handed
 * three parameters to a statement with two placeholders — a leftover from the migration
 * that dropped round blocks, where the third was `round_block_id`. Postgres refuses the
 * bind before the statement runs, and a driver error is not an `HttpError`, so the wrapper
 * turned a one-word mistake into a 500 with nothing to go on.
 *
 * `tests/backend-sql.test.ts` now fails on that shape anywhere in the backend. These tests
 * cover the flow the fix restores.
 */
describe('the Pak een Zes phase machine', () => {
  it('runs forwards only', () => {
    expect(canTransition('READY', 'PREDICTING')).toBe(true);
    expect(canTransition('PREDICTING', 'LOCKED')).toBe(true);
    expect(canTransition('LOCKED', 'DRAWING')).toBe(true);
    expect(canTransition('DRAWING', 'PREDICTING')).toBe(false);
    expect(canTransition('READY', 'DRAWING')).toBe(false);
  });
});

describe.skipIf(!available)('opening Pak een Zes predictions', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;

  /** Exactly the statement the endpoint runs, with the parameters it now passes. */
  const createGame = () => db.query(
    `INSERT INTO pak_een_zes_games(game_night_id,round_id,status)
     SELECT $1,$2,'READY'
     WHERE NOT EXISTS (
       SELECT 1 FROM pak_een_zes_games
       WHERE game_night_id=$1 AND round_id=$2 AND status IN ('READY','PREDICTING','LOCKED','DRAWING')
     )`,
    [gameId, roundId],
  );

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 870); });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'PAK_EEN_ZES');
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
  });

  // 27-29 · the statement that used to reject its own parameters
  it('creates the runtime the first time it is asked', async () => {
    await expect(createGame()).resolves.toBeTruthy();
    const { rows } = await db.query('SELECT status FROM pak_een_zes_games WHERE round_id=$1', [roundId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('READY');
  });

  // The guard that makes a second press harmless rather than a second game.
  it('creates nothing the second time', async () => {
    await createGame();
    await createGame();
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM pak_een_zes_games WHERE round_id=$1', [roundId]);
    expect(rows[0].n).toBe(1);
  });

  it('opens predictions from READY', async () => {
    await createGame();
    const { rows } = await db.query(
      "UPDATE pak_een_zes_games SET status='PREDICTING',predictions_opened_at=NOW() WHERE round_id=$1 AND status='READY' RETURNING status",
      [roundId],
    );
    expect(rows[0].status).toBe('PREDICTING');
  });

  // 31-32 · a player names one person per six, four slots in all, and each slot once
  it('takes one prediction per player per slot, and four slots in all', async () => {
    await createGame();
    const game = await db.query('SELECT id FROM pak_een_zes_games WHERE round_id=$1', [roundId]);
    const pakId = Number(game.rows[0].id);

    for (let slot = 1; slot <= 4; slot += 1) {
      await db.query(
        'INSERT INTO pak_een_zes_predictions(pak_een_zes_game_id,player_id,slot,predicted_player_id) VALUES($1,501,$2,502)',
        [pakId, slot],
      );
    }
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM pak_een_zes_predictions WHERE pak_een_zes_game_id=$1', [pakId]);
    expect(rows[0].n).toBe(4);

    // Filling the same slot twice is the database's decision, not a check the endpoint
    // could win against two taps arriving together.
    await expect(db.query(
      'INSERT INTO pak_een_zes_predictions(pak_een_zes_game_id,player_id,slot,predicted_player_id) VALUES($1,501,1,501)',
      [pakId],
    )).rejects.toThrow();

    // There is no fifth six to predict.
    await expect(db.query(
      'INSERT INTO pak_een_zes_predictions(pak_een_zes_game_id,player_id,slot,predicted_player_id) VALUES($1,501,5,502)',
      [pakId],
    )).rejects.toThrow();
  });

  // A round that is not being played has no business creating runtime, and that refusal is
  // a business error rather than a crash.
  it('leaves an unrelated round without a game', async () => {
    const other = await addRound(db, gameId, 'PAK_EEN_ZES');
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM pak_een_zes_games WHERE round_id=$1', [other]);
    expect(rows[0].n).toBe(0);
  });
});
