import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A real Postgres to run the round lifecycle against.
 *
 * PGlite is Postgres compiled to WebAssembly, so these tests exercise the actual
 * constraints, triggers and partial unique indexes the migrations create rather than a
 * model of them. That matters here: most of what this refactor promises — one active
 * round, one type per round, a reward that cannot be paid twice — is enforced by the
 * database, and a test that mocks the database cannot see any of it.
 *
 * It is an optional dependency. Where it is not installed these tests skip rather than
 * fail, so the suite still runs on a checkout that has not installed it.
 */
const MIGRATIONS = join(__dirname, '..', '..', 'netlify', 'database', 'migrations');

export type TestDb = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  close: () => Promise<void>;
};

export async function pgliteAvailable() {
  try {
    await import('@electric-sql/pglite');
    return true;
  } catch {
    return false;
  }
}

/** A migrated database, wrapped so it satisfies the `client.query` shape pg gives. */
export async function migratedDb(): Promise<TestDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return {
    // pg reports `rowCount`; PGlite reports `affectedRows`. The lifecycle code counts
    // rows it changed, so the two are bridged here rather than in the code under test.
    query: async (sql: string, params?: unknown[]) => {
      const result = await db.query(sql, params as any[]);
      return { rows: (result as any).rows ?? [], rowCount: (result as any).affectedRows ?? 0 };
    },
    close: () => db.close(),
  };
}

/** A game night with two players and wallets, ready for a round to be added to it. */
export async function seedGame(db: TestDb, gameId = 500) {
  await db.query(
    `INSERT INTO game_nights(id,name,starting_balance,game_state_version) VALUES($1,'Test Night',1000,1)
     ON CONFLICT (id) DO NOTHING`,
    [gameId],
  );
  await db.query(
    `INSERT INTO players(id,game_night_id,display_name,public_color,active,starting_balance_snapshot)
     VALUES(501,$1,'Daan','#f00',TRUE,1000),(502,$1,'Twan','#0f0',TRUE,1000)
     ON CONFLICT (id) DO NOTHING`,
    [gameId],
  );
  await db.query(
    `INSERT INTO wallets(game_night_id,player_id,current_balance) VALUES($1,501,1000),($1,502,1000)
     ON CONFLICT DO NOTHING`,
    [gameId],
  );
  await db.query(
    `INSERT INTO screen_state(game_night_id,mode) VALUES($1,'DASHBOARD') ON CONFLICT DO NOTHING`,
    [gameId],
  );
  return gameId;
}

/**
 * Rounds are unique by (game night, sort order), and a random number collides sooner than
 * feels plausible — a suite that adds a few hundred rounds hits it often enough to fail
 * for reasons that have nothing to do with what is being tested. A counter cannot.
 */
let sortOrderCounter = 1000;
const nextSortOrder = () => (sortOrderCounter += 1);

export async function addRound(
  db: TestDb,
  gameId: number,
  type: string,
  overrides: { status?: string; sortOrder?: number; defaultPoints?: number; title?: string } = {},
) {
  const { rows } = await db.query(
    `INSERT INTO rounds(game_night_id,sort_order,title,type,status,instructions,default_points)
     VALUES($1,$2,$3,$4,$5,'',$6) RETURNING id`,
    [
      gameId,
      overrides.sortOrder ?? nextSortOrder(),
      overrides.title ?? `${type} round`,
      type,
      overrides.status ?? 'UPCOMING',
      overrides.defaultPoints ?? 10,
    ],
  );
  const roundId = Number(rows[0].id);
  await db.query('INSERT INTO round_runtime(round_id,game_night_id) VALUES($1,$2)', [roundId, gameId]);
  return roundId;
}
