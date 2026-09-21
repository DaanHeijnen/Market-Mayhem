import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { adminCookie, jsonRequest, readJson, sqlTag, TEST_SESSION_SECRET } from './helpers/endpoint';

/**
 * Starting a round, and the projector noticing.
 *
 * The complaint: the first slide of a presentation took seconds to appear, while every
 * later VOLGENDE was instant. The start itself was never slow — this suite proves that —
 * and the delay was on the other side of the wire, in how often the projector was asking.
 *
 * `idle` is the whole story. It meant "nothing is running", which is exactly true in the
 * gap between two rounds, so the projector had backed off to its slow tier at the precise
 * moment the host pressed START. By the time the room was looking at the first slide the
 * round *was* running, so everything after it landed in half a second.
 *
 * So the fix is tested where it lives: idleness now also asks whether anything has
 * happened lately, and a game that has just been touched is not idle however little is
 * running in it.
 */

const { holder } = vi.hoisted(() => ({ holder: { pool: null as any, sql: null as any } }));
vi.mock('../netlify/lib/db', () => ({
  database: () => ({ pool: holder.pool, sql: holder.sql }),
  withTransaction: async (fn: any) => fn(holder.pool),
}));

const startRound = (await import('../netlify/functions/start-round')).default;
const { getScreenState, getGameVersion } = await import('../netlify/lib/queries');
const { previewNavigation } = await import('../netlify/lib/screen-preview');

const available = await pgliteAvailable();

describe.skipIf(!available)('starting a round', () => {
  let db: TestDb;
  let gameId: number;
  let admin: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    db = await migratedDb();
    holder.pool = db;
    holder.sql = sqlTag(db);
    gameId = await seedGame(db, 904);
    admin = await adminCookie(db);
  });
  afterAll(async () => { await db?.close(); });

  const addPage = async (roundId: number, sortOrder: number, title: string) => {
    const { rows } = await db.query(
      `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body)
       VALUES($1,$2,$3,$4,'') RETURNING id`,
      [gameId, roundId, sortOrder, title],
    );
    const id = Number(rows[0].id);
    await db.query('INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
    return id;
  };

  beforeEach(async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    await db.query('UPDATE game_nights SET current_round_id=NULL WHERE id=$1', [gameId]);
  });

  // The start itself: one call, and the projector's snapshot is already correct.
  it('has the projector state ready the moment the round is started', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE', { status: 'UPCOMING', title: 'De ronde' });
    await addPage(roundId, 1, 'Slide 1');

    const result = await startRound(jsonRequest('/api/start-round', { gameId, roundId }, admin)).then(readJson);
    expect(result.status).toBe(200);
    expect(result.body.shownOnScreen).toBe('roundIntro');

    // No second request, no second write, no waiting: the very next read of the
    // projector's own snapshot is the round.
    const snapshot: any = await getScreenState(gameId);
    expect(snapshot.mode).toBe('ROUND_INTRO');
    expect(snapshot.roundIntro.title).toBe('De ronde');
    expect(snapshot.screenRecovered).toBeUndefined();

    // And the first page is one press away, already drawn.
    const preview: any = await previewNavigation(db as any, gameId, 'NEXT');
    expect(preview.step).toBe('target');
    expect(preview.preview.slide.title).toBe('Slide 1');
  });

  it('writes the round, its runtime and the screen in one transaction', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE', { status: 'UPCOMING' });
    await addPage(roundId, 1, 'Slide 1');
    await startRound(jsonRequest('/api/start-round', { gameId, roundId }, admin));

    const [round, runtime, screen] = await Promise.all([
      db.query('SELECT status FROM rounds WHERE id=$1', [roundId]),
      db.query('SELECT round_id FROM round_runtime WHERE round_id=$1', [roundId]),
      db.query('SELECT mode,round_id FROM screen_state WHERE game_night_id=$1', [gameId]),
    ]);
    expect(round.rows[0].status).toBe('ACTIVE');
    expect(runtime.rows[0]).toBeTruthy();
    expect(screen.rows[0].mode).toBe('ROUND_INTRO');
    expect(Number(screen.rows[0].round_id)).toBe(roundId);
  });

  // The actual bottleneck. A game with no round running used to read idle unconditionally,
  // which is what put the projector on its slow tier during the gap between rounds.
  describe('whether the room may back off', () => {
    const quiet = () => db.query(`UPDATE game_nights SET updated_at=NOW()-INTERVAL '10 minutes' WHERE id=$1`, [gameId]);
    // The version reader caches for a moment so a room full of clients landing together
    // costs one read. Long enough to matter to a test, so each case waits it out.
    const past = () => new Promise(resolve => setTimeout(resolve, 200));

    it('backs off only once the evening has actually gone quiet', async () => {
      await quiet();
      await past();
      expect((await getGameVersion(gameId)).idle).toBe(true);
    });

    it('stays awake through the pause between two rounds', async () => {
      const roundId = await addRound(db, gameId, 'PRESENTATIE', { status: 'UPCOMING' });
      await addPage(roundId, 1, 'Slide 1');
      await startRound(jsonRequest('/api/start-round', { gameId, roundId }, admin));
      // The round is completed; nothing is live. Before, that alone made the game idle and
      // sent the projector to sleep — right when the host was about to start the next one.
      await db.query(`UPDATE rounds SET status='COMPLETED' WHERE id=$1`, [roundId]);
      await db.query('UPDATE game_nights SET current_round_id=NULL,updated_at=NOW() WHERE id=$1', [gameId]);

      await past();
      expect((await getGameVersion(gameId)).idle).toBe(false);
    });

    it('is never idle while a round is being played', async () => {
      await quiet();
      const roundId = await addRound(db, gameId, 'PRESENTATIE', { status: 'ACTIVE' });
      await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
      // Deliberately without touching updated_at: a long round in which nothing changes
      // must still keep the room awake.
      await quiet();
      await past();
      expect((await getGameVersion(gameId)).idle).toBe(false);
    });
  });
});
