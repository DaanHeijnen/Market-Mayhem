import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { setScreen, stageScreen, promoteStaged, clearScreenIfReferences } from '../netlify/lib/game-state';
import { performFullReset } from '../netlify/lib/full-reset';

const available = await pgliteAvailable();

/**
 * What a held-back presentation page may and may not do, against a migrated database.
 *
 * The rule that matters most is that it is enforced in one place: every route that can
 * move the projector resolves its target through `resolveTarget`, so these tests exercise
 * showing, staging and going live and expect the same refusal from all three.
 */
describe.skipIf(!available)('presentation page visibility', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;
  let pages: number[];
  const client = () => db as any;

  const addPage = async (round: number, sortOrder: number, title: string, hidden = false) => {
    const { rows } = await db.query(
      `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,hidden)
       VALUES($1,$2,$3,$4,'',$5) RETURNING id`,
      [gameId, round, sortOrder, title, hidden],
    );
    const id = Number(rows[0].id);
    await db.query(
      'INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)',
      [id, gameId, round],
    );
    return id;
  };

  const screen = async () => (await db.query(
    'SELECT mode,round_id,slide_id,staged_mode,staged_slide_id FROM screen_state WHERE game_night_id=$1',
    [gameId],
  )).rows[0];

  beforeAll(async () => {
    db = await migratedDb();
    gameId = await seedGame(db, 700);
  });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    // One active round per game night is a partial unique index, so the previous test's
    // round stands down before this one starts.
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'PRESENTATIE');
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    pages = [
      await addPage(roundId, 0, 'Page 1'),
      await addPage(roundId, 1, 'Page 2'),
      await addPage(roundId, 2, 'Page 3'),
    ];
    await setScreen(client(), gameId, { kind: 'dashboard' }, 'test');
  });

  // 1-3 · the round reaches the projector, pointed at one page
  it('puts a specific page on the big screen', async () => {
    await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin');

    const row = await screen();
    expect(row.mode).toBe('SLIDE');
    expect(Number(row.round_id)).toBe(roundId);
    expect(Number(row.slide_id)).toBe(pages[1]);
  });

  // 9-10 · authored state, so it is still there on the next read
  it('stores visibility on the authored page, where a refresh finds it again', async () => {
    const before = await db.query('SELECT hidden FROM presentation_slides WHERE id=$1', [pages[1]]);
    expect(before.rows[0].hidden).toBe(false);

    await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);

    const after = await db.query('SELECT hidden FROM presentation_slides WHERE id=$1', [pages[1]]);
    expect(after.rows[0].hidden).toBe(true);
  });

  // 6 · the guarantee, from every direction
  describe('a held-back page cannot reach the projector', () => {
    beforeEach(async () => { await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]); });

    it('refuses to show it', async () => {
      await expect(setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin'))
        .rejects.toThrow(/hidden/i);
    });

    it('refuses to stage it, rather than letting GO LIVE fail later', async () => {
      await expect(stageScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin'))
        .rejects.toThrow(/hidden/i);
    });

    // The stale command: staged while visible, held back before it went live.
    it('refuses to promote one that was staged before it was held back', async () => {
      await db.query('UPDATE presentation_slides SET hidden=FALSE WHERE id=$1', [pages[1]]);
      await stageScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin');
      await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);

      await expect(promoteStaged(client(), gameId, 'admin')).rejects.toThrow(/hidden/i);
      // and the projector is untouched by the attempt
      expect((await screen()).mode).toBe('DASHBOARD');
    });

    it('leaves the visible pages showable', async () => {
      await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[2] }, 'admin');
      expect(Number((await screen()).slide_id)).toBe(pages[2]);
    });
  });

  // 11-12 · and back again
  it('can be shown once it is made visible again', async () => {
    await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);
    await expect(setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin'))
      .rejects.toThrow(/hidden/i);

    await db.query('UPDATE presentation_slides SET hidden=FALSE WHERE id=$1', [pages[1]]);
    await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin');

    expect(Number((await screen()).slide_id)).toBe(pages[1]);
  });

  // Holding back the page that is currently up must take it off the screen, or the room
  // keeps looking at something the host has just removed from the evening.
  it('takes a page off the projector when it is held back while showing', async () => {
    await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'admin');
    await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);
    await clearScreenIfReferences(client(), gameId, 'admin', { slideId: pages[1] });

    const row = await screen();
    expect(row.mode).toBe('DASHBOARD');
    expect(row.slide_id).toBeNull();
  });

  it('leaves the projector alone when a different page is held back', async () => {
    await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[0] }, 'admin');
    await clearScreenIfReferences(client(), gameId, 'admin', { slideId: pages[2] });

    expect(Number((await screen()).slide_id)).toBe(pages[0]);
  });

  // Visibility is authored, the reveal is runtime — so a reset has to treat them
  // differently, and this is the test that says which is which.
  it('survives a Full Reset, while the reveal state does not', async () => {
    await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);
    await db.query('UPDATE presentation_slide_state SET revealed_at=NOW() WHERE slide_id=$1', [pages[0]]);

    await performFullReset(client(), gameId, 'admin');

    const { rows } = await db.query(
      `SELECT s.id,s.hidden,st.revealed_at FROM presentation_slides s
       JOIN presentation_slide_state st ON st.slide_id=s.id WHERE s.round_id=$1 ORDER BY s.sort_order`,
      [roundId],
    );
    expect(rows.map((r: any) => r.hidden)).toEqual([false, true, false]);
    expect(rows.every((r: any) => r.revealed_at === null)).toBe(true);
  });

  // 15 · the pointer is the round plus the page, and nothing block-shaped.
  it('points at the page through round_id and slide_id, with no block pointer anywhere', async () => {
    await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[0] }, 'admin');

    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('screen_state','game_nights','round_runtime') AND column_name LIKE '%block%'`,
    );
    expect(columns.rows).toEqual([]);

    const row = await screen();
    expect(Number(row.round_id)).toBe(roundId);
    expect(Number(row.slide_id)).toBe(pages[0]);
  });
});
