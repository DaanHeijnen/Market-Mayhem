import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { planStep, advanceScreen, initialScreenTarget } from '../netlify/lib/screen-flow';
import { setScreen } from '../netlify/lib/game-state';

const available = await pgliteAvailable();

/**
 * The LIVE_QUIZ chronology, end to end.
 *
 * One button walks the whole round:
 *
 *   INTRO → question (opens for answers) → answer (reveals and pays)
 *         → context photo, only where one was authored → next question → … → completed
 *
 * The parts that matter most are the ones a surface could get subtly wrong: that the phone
 * shows nothing during the intro, that revealing pays exactly once however many times the
 * button is pressed, and that stepping back changes what the room sees without undoing any
 * of it.
 */
describe.skipIf(!available)('walking a live quiz', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;
  let questions: { id: number; optionIds: number[] }[];
  const client = () => db as any;

  const addQuestion = async (sortOrder: number, prompt: string, contextKey: string | null, points = 20) => {
    const { rows } = await db.query(
      `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,body,points,context_media_key)
       VALUES($1,$2,$3,$4,'',$5,$6) RETURNING id`,
      [gameId, roundId, sortOrder, prompt, points, contextKey],
    );
    const id = Number(rows[0].id);
    await db.query('INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
    const optionIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const o = await db.query(
        `INSERT INTO live_quiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [id, gameId, i, `Answer ${i}`, i === 0],
      );
      optionIds.push(Number(o.rows[0].id));
    }
    return { id, optionIds };
  };

  const screen = async () => (await db.query(
    'SELECT mode,round_id,quiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId],
  )).rows[0];

  const state = async (questionId: number) => (await db.query(
    'SELECT status,context_photo_shown FROM live_quiz_question_state WHERE question_id=$1', [questionId],
  )).rows[0];

  /** Which scene the projector is on, named the way the chronology names it. */
  const scene = async () => {
    const row = await screen();
    if (row.mode === 'ROUND_INTRO') return 'INTRO';
    if (row.mode !== 'QUIZ_QUESTION') return row.mode;
    const q = await state(Number(row.quiz_question_id));
    if (q.context_photo_shown) return `CONTEXT:${row.quiz_question_id}`;
    if (['REVEALED', 'SETTLED'].includes(q.status)) return `ANSWER:${row.quiz_question_id}`;
    return `QUESTION:${row.quiz_question_id}`;
  };

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 860); });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'LIVE_QUIZ');
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
    await db.query('UPDATE wallets SET current_balance=100 WHERE game_night_id=$1', [gameId]);
    questions = [
      await addQuestion(0, 'Vraag 1', 'g/image/ctx1.jpg'),
      await addQuestion(1, 'Vraag 2', null),
    ];
    await setScreen(client(), gameId, { kind: 'roundIntro', roundId }, 'test');
  });

  // 41 · the round opens on its title card
  it('starts on the intro', async () => {
    expect(await initialScreenTarget(client(), gameId, roundId, 'LIVE_QUIZ')).toEqual({ kind: 'roundIntro', roundId });
    expect(await scene()).toBe('INTRO');
  });

  // 42-46 · the first press asks question one, and asking it opens it
  it('asks the first question and opens it for answers in one press', async () => {
    expect(await state(questions[0].id)).toMatchObject({ status: 'READY' });

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

    expect(await scene()).toBe(`QUESTION:${questions[0].id}`);
    expect((await state(questions[0].id)).status).toBe('OPEN');
  });

  // 47-50 · the next press closes answers, reveals and pays, in one transition
  it('reveals and pays on the next press', async () => {
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    await db.query(
      'INSERT INTO quiz_answers(game_night_id,round_id,question_id,option_id,player_id) VALUES($1,$2,$3,$4,501)',
      [gameId, roundId, questions[0].id, questions[0].optionIds[0]],
    );

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

    expect(await scene()).toBe(`ANSWER:${questions[0].id}`);
    expect((await state(questions[0].id)).status).toBe('REVEALED');
    expect(Number((await db.query('SELECT current_balance::int AS b FROM wallets WHERE player_id=501')).rows[0].b)).toBe(120);
  });

  // 52-54 · the photo is its own scene, and only where one was authored
  it('shows the context photo after the answer, then moves on', async () => {
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // question 1
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // answer 1

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect(await scene()).toBe(`CONTEXT:${questions[0].id}`);

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect(await scene()).toBe(`QUESTION:${questions[1].id}`);
    expect((await state(questions[1].id)).status).toBe('OPEN');
  });

  // 55 · no empty context scene for a question that has no photo
  it('goes straight from an answer to the next question when there is no photo', async () => {
    for (let i = 0; i < 4; i += 1) await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect(await scene()).toBe(`QUESTION:${questions[1].id}`);

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect(await scene()).toBe(`ANSWER:${questions[1].id}`);

    // Question 2 has no photo, so the step after its answer ends the round.
    expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'completeRound' });
  });

  // 56-57 · the last scene stays up until the host presses on
  it('completes the round only after the last relevant scene', async () => {
    for (let i = 0; i < 5; i += 1) await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect((await db.query('SELECT status FROM rounds WHERE id=$1', [roundId])).rows[0].status).toBe('ACTIVE');

    const result = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect(result).toMatchObject({ kind: 'completeRound', completed: true });
    expect((await db.query('SELECT status FROM rounds WHERE id=$1', [roundId])).rows[0].status).toBe('COMPLETED');
  });

  // 60 · the preview predicts every scene exactly
  it('previews each scene before it happens', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const planned = await planStep(client(), gameId, 'NEXT');
      const taken = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(taken.kind).toBe(planned.kind);
      seen.push(await scene());
    }
    expect(seen).toEqual([
      `QUESTION:${questions[0].id}`,
      `ANSWER:${questions[0].id}`,
      `CONTEXT:${questions[0].id}`,
      `QUESTION:${questions[1].id}`,
      `ANSWER:${questions[1].id}`,
    ]);
  });

  // 61 · stepping back changes the scene, never the scoring
  it('steps back off the photo without un-revealing or unpaying', async () => {
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    await db.query(
      'INSERT INTO quiz_answers(game_night_id,round_id,question_id,option_id,player_id) VALUES($1,$2,$3,$4,501)',
      [gameId, roundId, questions[0].id, questions[0].optionIds[0]],
    );
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // answer, pays
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // context

    await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);

    expect(await scene()).toBe(`ANSWER:${questions[0].id}`);
    // Still revealed, still paid.
    expect((await state(questions[0].id)).status).toBe('REVEALED');
    expect(Number((await db.query('SELECT current_balance::int AS b FROM wallets WHERE player_id=501')).rows[0].b)).toBe(120);
  });

  it('steps back from the first question to the intro', async () => {
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
    expect(await scene()).toBe('INTRO');
  });

  // 35, 49 · scoring happens once, whatever the host does with the button
  it('pays once even if the reveal is stepped into twice', async () => {
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    await db.query(
      'INSERT INTO quiz_answers(game_night_id,round_id,question_id,option_id,player_id) VALUES($1,$2,$3,$4,501)',
      [gameId, roundId, questions[0].id, questions[0].optionIds[0]],
    );
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // answer
    await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null); // back to intro-side
    await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // forward again

    const paid = await db.query(
      "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE quiz_question_id=$1 AND transaction_type='QUESTION_REWARD'",
      [questions[0].id],
    );
    expect(paid.rows[0].n).toBe(1);
    expect(Number((await db.query('SELECT current_balance::int AS b FROM wallets WHERE player_id=501')).rows[0].b)).toBe(120);
  });

  // A step from a tab that has fallen behind must not drag the room back.
  it('refuses a stale step and leaves the projector where it is', async () => {
    const stale = Number((await db.query('SELECT revision FROM screen_state WHERE game_night_id=$1', [gameId])).rows[0].revision);
    await advanceScreen(client(), gameId, 'NEXT', 'admin', stale);
    const after = await scene();

    await expect(advanceScreen(client(), gameId, 'NEXT', 'other', stale)).rejects.toThrow(/moved on/i);
    expect(await scene()).toBe(after);
  });
});
