import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, type TestDb } from './helpers/pglite';
import {
  DEFAULT_PLAYERS,
  DEFAULT_PLAYER_COINS,
  initializeDefaultPlayers,
  resetPlayersToDefaults,
} from '../netlify/lib/default-players';
import { performFullReset } from '../netlify/lib/full-reset';

const available = await pgliteAvailable();
const MIGRATION = join(__dirname, '..', 'netlify', 'database', 'migrations', '0017_default_players.sql');

const NAMES = ['Jordi', 'Wouter', 'Bas', 'Boyen', 'David', 'Dries', 'Moise', 'Raúl', 'Tijs', 'Twan'];

/**
 * The roster is written down twice — once in TypeScript for the application, once in SQL
 * so a fresh database has it before any request arrives. This is the test that makes that
 * safe: it reads both and fails the moment they disagree.
 */
describe('the standard roster', () => {
  it('is the ten names, spelled exactly', () => {
    expect(DEFAULT_PLAYERS.map(p => p.name)).toEqual(NAMES);
  });

  // Called out because it is the one name with an accent, and losing it to an encoding
  // slip would be invisible in a count.
  it('keeps the accent on Raúl', () => {
    expect(DEFAULT_PLAYERS.find(p => p.key === 'default:raul')?.name).toBe('Raúl');
    expect(NAMES).toContain('Raúl');
  });

  it('does not include Daan', () => {
    expect(DEFAULT_PLAYERS.map(p => p.name)).not.toContain('Daan');
  });

  it('starts everyone on a hundred coins', () => {
    expect(DEFAULT_PLAYER_COINS).toBe(100);
  });

  it('gives every player their own key and their own colour', () => {
    expect(new Set(DEFAULT_PLAYERS.map(p => p.key)).size).toBe(DEFAULT_PLAYERS.length);
    expect(new Set(DEFAULT_PLAYERS.map(p => p.name)).size).toBe(DEFAULT_PLAYERS.length);
    expect(new Set(DEFAULT_PLAYERS.map(p => p.color)).size).toBe(DEFAULT_PLAYERS.length);
    for (const player of DEFAULT_PLAYERS) expect(player.color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('is the same list the migration seeds', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const player of DEFAULT_PLAYERS) {
      expect(sql, player.key).toContain(`('${player.key}','${player.name}','${player.color}'`);
      expect(sql, `${player.key} adoption`).toContain(`('${player.key}','${player.name}')`);
    }
    // The starting balance the migration writes, so the constant cannot drift away from
    // the value a fresh database is actually seeded with.
    expect(sql).toContain(`TRUE, ${DEFAULT_PLAYER_COINS}, d.seed_key`);
  });
});

describe.skipIf(!available)('the standard players, against a migrated database', () => {
  let db: TestDb;
  const client = () => db as any;
  let nextGameId = 900;

  /** A game night with nothing in it, as a creation path would leave one. */
  const newGame = async () => {
    const gameId = nextGameId++;
    await db.query(
      `INSERT INTO game_nights(id,name,starting_balance,game_state_version) VALUES($1,'Night',100,1)`,
      [gameId],
    );
    await db.query(`INSERT INTO screen_state(game_night_id,mode) VALUES($1,'DASHBOARD')`, [gameId]);
    return gameId;
  };

  const roster = async (gameId: number) => (await db.query(
    `SELECT p.display_name,p.seed_key,p.active,w.current_balance::int AS balance,
            (SELECT COALESCE(SUM(l.amount),0)::int FROM ledger_entries l WHERE l.player_id=p.id) AS ledger,
            (SELECT COUNT(*)::int FROM ledger_entries l WHERE l.player_id=p.id AND l.transaction_type='STARTING_BALANCE') AS openings
     FROM players p JOIN wallets w ON w.player_id=p.id
     WHERE p.game_night_id=$1 ORDER BY p.id`,
    [gameId],
  )).rows;

  beforeAll(async () => { db = await migratedDb(); });
  afterAll(async () => { await db?.close(); });

  // ---------------------------------------------------------------------
  // 1-4 · a night begins with the ten, each on a hundred coins
  // ---------------------------------------------------------------------
  describe('initialization', () => {
    it('seeds the game night a fresh database is created with', async () => {
      // Migration 0003 creates game night 1 and 0017 fills it, so an installation that
      // has only ever been migrated already has its players.
      const rows = await roster(1);
      expect(rows.map(r => r.display_name)).toEqual(NAMES);
      expect(rows.every(r => r.balance === 100)).toBe(true);
      expect(rows.map(r => r.display_name)).not.toContain('Daan');
    });

    it('fills a newly created game night with the ten, on a hundred coins each', async () => {
      const gameId = await newGame();
      const result = await initializeDefaultPlayers(client(), gameId, 'test');

      expect(result.alreadyInitialized).toBe(false);
      expect(result.created).toBe(10);
      const rows = await roster(gameId);
      expect(rows.map(r => r.display_name).sort()).toEqual([...NAMES].sort());
      for (const row of rows) {
        expect(row.balance, row.display_name).toBe(100);
        // The financial invariant, per player: the wallet is what the ledger adds up to.
        expect(row.ledger, row.display_name).toBe(100);
        expect(row.openings, row.display_name).toBe(1);
      }
    });

    it('refuses a game night that does not exist', async () => {
      await expect(initializeDefaultPlayers(client(), 99_999, 'test')).rejects.toThrow(/not found/i);
    });
  });

  // ---------------------------------------------------------------------
  // 8, 9, 15 · running it again changes nothing
  // ---------------------------------------------------------------------
  describe('idempotency', () => {
    it('creates no second Jordi and no second hundred coins, however often it runs', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
      const second = await initializeDefaultPlayers(client(), gameId, 'test');
      const third = await initializeDefaultPlayers(client(), gameId, 'test');

      expect(second.alreadyInitialized).toBe(true);
      expect(third.alreadyInitialized).toBe(true);
      expect(second.created + third.created).toBe(0);

      const rows = await roster(gameId);
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.balance).toBe(100);
        expect(row.openings).toBe(1);
      }
    });

    // The guarantee that does not depend on the code path: even a direct insert cannot
    // produce a second standard Jordi.
    it('is a database invariant, not a convention', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
      await expect(db.query(
        `INSERT INTO players(game_night_id,display_name,public_color,active,starting_balance_snapshot,seed_key)
         VALUES($1,'Jordi 2','#000000',TRUE,100,'default:jordi')`,
        [gameId],
      )).rejects.toThrow();
    });

    // Criterion 6, and the reason the latch exists: a night in progress must not be
    // rolled back to the starting balance by something as ordinary as a page load.
    it('leaves a played balance alone', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
      const jordi = (await db.query(
        `SELECT id FROM players WHERE game_night_id=$1 AND seed_key='default:jordi'`, [gameId],
      )).rows[0].id;

      // Through the ledger, the way the app moves money.
      await db.query('UPDATE wallets SET current_balance=340 WHERE player_id=$1', [jordi]);
      await db.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,created_by)
         VALUES($1,$2,240,'MANUAL_ADJUSTMENT','Won a round','admin')`,
        [gameId, jordi],
      );

      await initializeDefaultPlayers(client(), gameId, 'test');

      const after = (await db.query('SELECT current_balance::int AS balance FROM wallets WHERE player_id=$1', [jordi])).rows[0];
      expect(after.balance).toBe(340);
    });

    // Criterion 7: nothing about playing the night touches the roster. Rounds are the
    // one thing that moves constantly during an evening.
    it('survives the round machinery', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
      const { rows } = await db.query(
        `INSERT INTO rounds(game_night_id,sort_order,title,type,status,instructions,default_points)
         VALUES($1,1,'R1','PRESENTATIE','UPCOMING','',10) RETURNING id`, [gameId],
      );
      await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [rows[0].id]);
      await db.query(`UPDATE rounds SET status='COMPLETED',completed_at=NOW() WHERE id=$1`, [rows[0].id]);

      expect(await roster(gameId)).toHaveLength(10);
    });

    // A deliberate removal has to stick, or "ensure setup" would quietly be a rule that
    // all ten always exist.
    it('does not bring back a player the Admin removed', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
      await db.query(`UPDATE players SET active=FALSE WHERE game_night_id=$1 AND seed_key='default:bas'`, [gameId]);

      await initializeDefaultPlayers(client(), gameId, 'test');

      const bas = (await db.query(
        `SELECT active FROM players WHERE game_night_id=$1 AND seed_key='default:bas'`, [gameId],
      )).rows[0];
      expect(bas.active).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // 10-13 · reset to defaults
  // ---------------------------------------------------------------------
  describe('reset to defaults', () => {
    let gameId: number;

    beforeEach(async () => {
      gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
    });

    it('puts everyone back on a hundred coins with one opening entry', async () => {
      await db.query('UPDATE wallets SET current_balance=7 WHERE game_night_id=$1', [gameId]);
      await db.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,created_by)
         SELECT $1,id,-93,'MANUAL_ADJUSTMENT','Lost it all','admin' FROM players WHERE game_night_id=$1`,
        [gameId],
      );

      const summary = await resetPlayersToDefaults(client(), gameId, 'admin');

      expect(summary.restored).toBe(10);
      expect(summary.created).toBe(0);
      const rows = await roster(gameId);
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.balance, row.display_name).toBe(100);
        expect(row.ledger, row.display_name).toBe(100);
        expect(row.openings, row.display_name).toBe(1);
      }
    });

    it('removes players added by hand and keeps the standard ten', async () => {
      const extra = (await db.query(
        `INSERT INTO players(game_night_id,display_name,public_color,active,starting_balance_snapshot)
         VALUES($1,'Daan','#123456',TRUE,100) RETURNING id`, [gameId],
      )).rows[0].id;
      await db.query('INSERT INTO wallets(player_id,game_night_id,current_balance) VALUES($1,$2,100)', [extra, gameId]);

      const summary = await resetPlayersToDefaults(client(), gameId, 'admin');

      expect(summary.removed).toBe(1);
      const rows = await roster(gameId);
      expect(rows.map(r => r.display_name).sort()).toEqual([...NAMES].sort());
      expect(rows.map(r => r.display_name)).not.toContain('Daan');
    });

    it('restores a standard player who was deactivated or renamed, as the same player', async () => {
      const before = (await db.query(
        `SELECT id FROM players WHERE game_night_id=$1 AND seed_key='default:tijs'`, [gameId],
      )).rows[0].id;
      await db.query(
        `UPDATE players SET display_name='Iemand anders',active=FALSE,public_color='#000000' WHERE id=$1`,
        [before],
      );
      // A join link hangs off the player row, and keeping the row is what keeps it working.
      await db.query(
        `INSERT INTO player_join_tokens(game_night_id,player_id,token_hash) VALUES($1,$2,'hash-tijs')`,
        [gameId, before],
      );

      await resetPlayersToDefaults(client(), gameId, 'admin');

      const after = (await db.query(
        `SELECT id,display_name,active,public_color FROM players WHERE game_night_id=$1 AND seed_key='default:tijs'`,
        [gameId],
      )).rows[0];
      expect(Number(after.id)).toBe(Number(before));
      expect(after.display_name).toBe('Tijs');
      expect(after.active).toBe(true);
      expect(after.public_color).toBe(DEFAULT_PLAYERS.find(p => p.key === 'default:tijs')!.color);
      const token = await db.query('SELECT 1 FROM player_join_tokens WHERE player_id=$1', [before]);
      expect(token.rows).toHaveLength(1);
    });

    // Names are unique per night, so handing them all back out at once can collide
    // halfway through if two of them were swapped past each other.
    it('survives two standard players having been renamed onto each other', async () => {
      await db.query(`UPDATE players SET display_name='Basje' WHERE game_night_id=$1 AND seed_key='default:bas'`, [gameId]);
      await db.query(`UPDATE players SET display_name='Bas' WHERE game_night_id=$1 AND seed_key='default:tijs'`, [gameId]);

      await resetPlayersToDefaults(client(), gameId, 'admin');

      const rows = await roster(gameId);
      expect(rows.map(r => r.display_name).sort()).toEqual([...NAMES].sort());
    });

    it('re-creates a standard player whose row is gone', async () => {
      await db.query(`DELETE FROM players WHERE game_night_id=$1 AND seed_key='default:moise'`, [gameId]);

      const summary = await resetPlayersToDefaults(client(), gameId, 'admin');

      expect(summary.created).toBe(1);
      expect(summary.restored).toBe(9);
      const rows = await roster(gameId);
      expect(rows.map(r => r.display_name).sort()).toEqual([...NAMES].sort());
      expect(rows.find(r => r.display_name === 'Moise')!.balance).toBe(100);
    });

    // Criterion 15: the second of two reset requests must find nothing left to do.
    it('is idempotent, so a double-clicked reset pays nothing twice', async () => {
      await resetPlayersToDefaults(client(), gameId, 'admin');
      await resetPlayersToDefaults(client(), gameId, 'admin');
      await resetPlayersToDefaults(client(), gameId, 'admin');

      const rows = await roster(gameId);
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.balance).toBe(100);
        expect(row.ledger).toBe(100);
        expect(row.openings).toBe(1);
      }
    });

    it('leaves another game night alone', async () => {
      const other = await newGame();
      await initializeDefaultPlayers(client(), other, 'test');
      await db.query('UPDATE wallets SET current_balance=555 WHERE game_night_id=$1', [other]);

      await resetPlayersToDefaults(client(), gameId, 'admin');

      const rows = await roster(other);
      expect(rows).toHaveLength(10);
      expect(rows.every(r => r.balance === 555)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // What Full Reset must not touch
  // ---------------------------------------------------------------------
  describe('Full Reset and the slotmachine artwork', () => {
    // The twelve reel images are uploaded by hand, one at a time, and re-doing that before
    // every real night would make the reset unusable. They are configuration, not runtime,
    // and this is the test that keeps them that way.
    it('keeps the uploaded reel symbols and the odds behind them', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');
      await db.query(
        `INSERT INTO slot_configs(game_night_id,total_weight,updated_by) VALUES($1,100,'admin')
         ON CONFLICT (game_night_id) DO NOTHING`,
        [gameId],
      );
      for (let position = 1; position <= 3; position += 1) {
        await db.query(
          'INSERT INTO slot_reel_symbols(game_night_id,position,media_key) VALUES($1,$2,$3)',
          [gameId, position, `${gameId}/image/symbol${position}.png`],
        );
      }
      await db.query(
        `INSERT INTO slot_outcome_types(game_night_id,outcome_type,weight,payout_multiplier)
         VALUES($1,'THREE_LINE',10,5)`,
        [gameId],
      );

      await performFullReset(client(), gameId, 'admin');

      const symbols = await db.query('SELECT position,media_key FROM slot_reel_symbols WHERE game_night_id=$1 ORDER BY position', [gameId]);
      expect(symbols.rows).toHaveLength(3);
      expect(symbols.rows[0].media_key).toBe(`${gameId}/image/symbol1.png`);
      // The chances and payouts that go with them survive too.
      const outcomes = await db.query('SELECT weight FROM slot_outcome_types WHERE game_night_id=$1', [gameId]);
      expect(outcomes.rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // 10-14 · through the reset the Admin actually presses
  // ---------------------------------------------------------------------
  describe('Full Reset', () => {
    it('ends with exactly the ten standard players on a hundred coins', async () => {
      const gameId = await newGame();
      await initializeDefaultPlayers(client(), gameId, 'test');

      const extra = (await db.query(
        `INSERT INTO players(game_night_id,display_name,public_color,active,starting_balance_snapshot)
         VALUES($1,'Daan','#123456',TRUE,100) RETURNING id`, [gameId],
      )).rows[0].id;
      await db.query('INSERT INTO wallets(player_id,game_night_id,current_balance) VALUES($1,$2,100)', [extra, gameId]);
      await db.query('UPDATE wallets SET current_balance=999 WHERE game_night_id=$1', [gameId]);
      await db.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,created_by)
         SELECT $1,id,899,'MANUAL_ADJUSTMENT','Test run','admin' FROM players WHERE game_night_id=$1`,
        [gameId],
      );

      const summary = await performFullReset(client(), gameId, 'admin');

      expect(summary.playersReset).toBe(10);
      expect(summary.playersRemoved).toBe(1);
      expect(summary.startingBalanceEntries).toBe(10);

      const rows = await roster(gameId);
      expect(rows.map(r => r.display_name).sort()).toEqual([...NAMES].sort());
      for (const row of rows) {
        expect(row.balance, row.display_name).toBe(100);
        expect(row.ledger, row.display_name).toBe(100);
      }
    });
  });
});

/**
 * The upgrade path, which is the half a fresh database never exercises.
 *
 * A deployed installation already has players, wallets and history. What 0017 does to
 * *that* is the risky part: it must adopt the people who are already there, invent
 * nobody, and delete nothing.
 */
describe.skipIf(!available)('migration 0017 on a database that is already being played', () => {
  let db: TestDb;

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = join(__dirname, '..', 'netlify', 'database', 'migrations');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const pg = new PGlite();
    db = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await pg.query(sql, params as any[]);
        return { rows: (result as any).rows ?? [], rowCount: (result as any).affectedRows ?? 0 };
      },
      close: () => pg.close(),
    };

    // Everything up to but not including 0017 — the state a deployed database is in.
    for (const file of files.filter(f => !f.startsWith('0017'))) {
      await pg.exec(readFileSync(join(dir, file), 'utf8'));
    }

    // A night mid-play: two of the standard names, one guest, one near-miss spelling,
    // and balances that are nothing like a starting balance.
    await pg.exec(`
      INSERT INTO players(id,game_night_id,display_name,public_color,active,starting_balance_snapshot) VALUES
        (801,1,'Bas','#111111',TRUE,100),
        (802,1,'Twan','#222222',TRUE,100),
        (803,1,'Daan','#333333',TRUE,100),
        (804,1,'Raul','#444444',TRUE,100);
      INSERT INTO wallets(player_id,game_night_id,current_balance) VALUES
        (801,1,340),(802,1,55),(803,1,210),(804,1,90);
    `);

    await pg.exec(readFileSync(join(dir, files.find(f => f.startsWith('0017'))!), 'utf8'));
  });
  afterAll(async () => { await db?.close(); });

  it('invents nobody and removes nobody', async () => {
    const { rows } = await db.query('SELECT display_name FROM players WHERE game_night_id=1 ORDER BY id');
    expect(rows.map(r => r.display_name)).toEqual(['Bas', 'Twan', 'Daan', 'Raul']);
  });

  it('leaves every balance exactly where the night left it', async () => {
    const { rows } = await db.query('SELECT player_id,current_balance::int AS balance FROM wallets WHERE game_night_id=1 ORDER BY player_id');
    expect(rows.map(r => Number(r.balance))).toEqual([340, 55, 210, 90]);
  });

  it('adopts the players who are already there under a standard name', async () => {
    const { rows } = await db.query('SELECT id,seed_key FROM players WHERE game_night_id=1 ORDER BY id');
    const byId = Object.fromEntries(rows.map(r => [Number(r.id), r.seed_key]));
    expect(byId[801]).toBe('default:bas');
    expect(byId[802]).toBe('default:twan');
  });

  it('adopts neither a guest nor a name spelled differently', async () => {
    const { rows } = await db.query('SELECT id,seed_key FROM players WHERE game_night_id=1 ORDER BY id');
    const byId = Object.fromEntries(rows.map(r => [Number(r.id), r.seed_key]));
    // Daan is not one of the ten, and "Raul" is not how "Raúl" is spelled. Guessing that
    // it is the same person is the kind of decision a migration must not make quietly.
    expect(byId[803]).toBeNull();
    expect(byId[804]).toBeNull();
  });

  it('closes the latch, so no request seeds ten more people into a live night', async () => {
    const { rows } = await db.query('SELECT default_players_initialized_at FROM game_nights WHERE id=1');
    expect(rows[0].default_players_initialized_at).not.toBeNull();

    const before = await db.query('SELECT COUNT(*)::int AS n FROM players WHERE game_night_id=1');
    await initializeDefaultPlayers(db as any, 1, 'test');
    const after = await db.query('SELECT COUNT(*)::int AS n FROM players WHERE game_night_id=1');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('writes down what it decided, per night', async () => {
    const { rows } = await db.query("SELECT note FROM migration_notes WHERE migration='0017' AND game_night_id=1");
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain('2 existing player(s) were adopted');
  });

  // The way out: an explicit reset is what turns a played night into the standard roster.
  it('reaches the standard ten through a reset', async () => {
    await resetPlayersToDefaults(db as any, 1, 'admin');
    const { rows } = await db.query(
      `SELECT p.display_name,w.current_balance::int AS balance FROM players p
       JOIN wallets w ON w.player_id=p.id WHERE p.game_night_id=1 ORDER BY p.display_name`,
    );
    expect(rows.map(r => r.display_name).sort()).toEqual([...NAMES].sort());
    expect(rows.every(r => Number(r.balance) === 100)).toBe(true);
  });
});
