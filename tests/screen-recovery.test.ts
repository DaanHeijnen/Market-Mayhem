import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { isRenderable, recoverScreenTarget } from '../netlify/lib/screen-recovery';
import { setScreen } from '../netlify/lib/game-state';

const available = await pgliteAvailable();

/**
 * Whether a snapshot can be drawn at all.
 *
 * `screen_state`'s pointers are ON DELETE SET NULL, so a deleted page leaves a mode with
 * no item — a shape that used to reach the projector and stay there.
 */
describe('recognising a screen the projector cannot draw', () => {
  it('accepts the dashboard, which needs nothing', () => {
    expect(isRenderable({ mode: 'DASHBOARD' })).toBe(true);
  });

  it('accepts a scene whose payload arrived', () => {
    expect(isRenderable({ mode: 'SLIDE', slide: { id: 1 } })).toBe(true);
    expect(isRenderable({ mode: 'ROUND_INTRO', roundIntro: { title: 'R' } })).toBe(true);
    expect(isRenderable({ mode: 'QUIZ_QUESTION', quizQuestion: { id: 2 } })).toBe(true);
    expect(isRenderable({ mode: 'PUBQUIZ_QUESTION', pubquizQuestion: { id: 3 } })).toBe(true);
    expect(isRenderable({ mode: 'ROULETTE', round: { id: 4 } })).toBe(true);
  });

  // The exact shape a deleted page leaves behind.
  it('rejects a scene whose payload is missing', () => {
    expect(isRenderable({ mode: 'SLIDE', slide: null })).toBe(false);
    expect(isRenderable({ mode: 'QUIZ_QUESTION' })).toBe(false);
    expect(isRenderable({ mode: 'PUBQUIZ_QUESTION', pubquizQuestion: null })).toBe(false);
    expect(isRenderable({ mode: 'ROUND_INTRO', roundIntro: null })).toBe(false);
    expect(isRenderable({ mode: 'FOTORONDE', round: null })).toBe(false);
  });

  it('rejects a mode this build does not know', () => {
    expect(isRenderable({ mode: 'SOMETHING_ELSE' })).toBe(false);
  });
});

describe.skipIf(!available)('recovering the projector, against a migrated database', () => {
  let db: TestDb;
  let gameId: number;
  const client = () => db as any;

  const activate = async (roundId: number) => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
  };

  const addPage = async (roundId: number, sortOrder: number, title: string, hidden = false) => {
    const { rows } = await db.query(
      `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,hidden)
       VALUES($1,$2,$3,$4,'',$5) RETURNING id`,
      [gameId, roundId, sortOrder, title, hidden],
    );
    const id = Number(rows[0].id);
    await db.query('INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
    return id;
  };

  const screen = async () => (await db.query(
    'SELECT mode,round_id,slide_id,quiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId],
  )).rows[0];

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 850); });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    await db.query('UPDATE game_nights SET current_round_id=NULL WHERE id=$1', [gameId]);
    await setScreen(client(), gameId, { kind: 'dashboard' }, 'test');
  });

  // Recovery goes forwards where it can: a round in progress comes back to where it was,
  // not to the beginning.
  it('reconstructs the page the round was actually on', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await activate(roundId);
    const first = await addPage(roundId, 0, 'Page 1');
    const second = await addPage(roundId, 1, 'Page 2');
    await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: second }, 'test');

    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'slide', roundId, slideId: second });
    expect(first).toBeTruthy();
  });

  it('reconstructs the quiz question the round was on', async () => {
    const roundId = await addRound(db, gameId, 'LIVE_QUIZ');
    await activate(roundId);
    const { rows } = await db.query(
      `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,points) VALUES($1,$2,0,'Q1',10) RETURNING id`,
      [gameId, roundId],
    );
    const questionId = Number(rows[0].id);
    await db.query('INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [questionId, gameId, roundId]);
    await db.query('UPDATE round_runtime SET current_quiz_question_id=$2 WHERE round_id=$1', [roundId, questionId]);

    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'quizQuestion', roundId, questionId });
  });

  // A cursor pointing at something deleted must not produce a target that is invalid in a
  // new way — that is how a recovery loop starts.
  it('falls back to the round intro when the cursor points at a deleted page', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await activate(roundId);
    const page = await addPage(roundId, 0, 'Page 1');
    await db.query('UPDATE round_runtime SET current_slide_id=$2 WHERE round_id=$1', [roundId, page]);
    await db.query('DELETE FROM presentation_slides WHERE id=$1', [page]);

    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'roundIntro', roundId });
  });

  it('falls back to the round intro when the cursor points at a held-back page', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await activate(roundId);
    const page = await addPage(roundId, 0, 'Spare', true);
    await db.query('UPDATE round_runtime SET current_slide_id=$2 WHERE round_id=$1', [roundId, page]);

    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'roundIntro', roundId });
  });

  it('falls back to the round intro when the round has never moved', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await activate(roundId);
    await addPage(roundId, 0, 'Page 1');

    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'roundIntro', roundId });
  });

  it('recovers a game round to its own scene', async () => {
    const roundId = await addRound(db, gameId, 'ROULETTE');
    await activate(roundId);
    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'roundGame', roundId });
  });

  // Nothing is being played, so there is nothing to go back to but the standings.
  it('falls back to the dashboard when no round is active', async () => {
    expect(await recoverScreenTarget(client(), gameId)).toEqual({ kind: 'dashboard' });
  });

  // The whole point: whatever it returns can be shown. A recovery that needed recovering
  // would loop.
  it('always returns a target the projector can be pointed at', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await activate(roundId);
    const page = await addPage(roundId, 0, 'Page 1');
    await db.query('UPDATE round_runtime SET current_slide_id=$2 WHERE round_id=$1', [roundId, page]);
    await db.query('DELETE FROM presentation_slides WHERE id=$1', [page]);

    const target = await recoverScreenTarget(client(), gameId);
    await setScreen(client(), gameId, target, 'admin');
    const row = await screen();
    expect(row.mode).toBe('ROUND_INTRO');
    expect(Number(row.round_id)).toBe(roundId);

    // And asking again from the recovered state gives the same answer rather than drifting.
    expect(await recoverScreenTarget(client(), gameId)).toEqual(target);
  });

  // Recovery moves a pointer. It must not reopen answers, un-reveal a page or undo a
  // reward — the round is mid-flight and its state is the truth.
  it('changes nothing about the round it recovers', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await activate(roundId);
    const page = await addPage(roundId, 0, 'Page 1');
    await db.query('UPDATE presentation_slide_state SET revealed_at=NOW() WHERE slide_id=$1', [page]);
    await db.query('UPDATE round_runtime SET current_slide_id=$2 WHERE round_id=$1', [roundId, page]);

    await setScreen(client(), gameId, await recoverScreenTarget(client(), gameId), 'admin');

    const state = await db.query('SELECT revealed_at FROM presentation_slide_state WHERE slide_id=$1', [page]);
    expect(state.rows[0].revealed_at).not.toBeNull();
    const round = await db.query('SELECT status FROM rounds WHERE id=$1', [roundId]);
    expect(round.rows[0].status).toBe('ACTIVE');
  });
});
