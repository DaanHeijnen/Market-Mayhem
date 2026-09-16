import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { planStep, advanceScreen, initialScreenTarget, navigationCapabilities } from '../netlify/lib/screen-flow';
import { setScreen } from '../netlify/lib/game-state';

const available = await pgliteAvailable();

/**
 * PUBQUIZ against a migrated database.
 *
 * The parts that only a real Postgres can answer: the triggers and unique indexes that
 * make "one type per round", "one correct answer", "one answer per player" and "one reward
 * per player per question" facts rather than conventions.
 */
describe.skipIf(!available)('a pubquiz round', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;
  const client = () => db as any;

  const addQuestion = async (
    round: number,
    sortOrder: number,
    text: string,
    opts: { hidden?: boolean; points?: number; correct?: number } = {},
  ) => {
    const { rows } = await db.query(
      `INSERT INTO pubquiz_questions(game_night_id,round_id,sort_order,question,body,points,hidden)
       VALUES($1,$2,$3,$4,'',$5,$6) RETURNING id`,
      [gameId, round, sortOrder, text, opts.points ?? 10, opts.hidden ?? false],
    );
    const id = Number(rows[0].id);
    await db.query('INSERT INTO pubquiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, round]);
    const correct = opts.correct ?? 0;
    const optionIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const o = await db.query(
        `INSERT INTO pubquiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [id, gameId, i, `Answer ${i}`, i === correct],
      );
      optionIds.push(Number(o.rows[0].id));
    }
    return { id, optionIds };
  };

  const status = async (questionId: number) =>
    (await db.query('SELECT status FROM pubquiz_question_state WHERE question_id=$1', [questionId])).rows[0].status;

  const screen = async () => (await db.query(
    'SELECT mode,round_id,pubquiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId],
  )).rows[0];

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 830); });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'PUBQUIZ');
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
    await setScreen(client(), gameId, { kind: 'dashboard' }, 'test');
  });

  // ---------------------------------------------------------------------
  // 1 · it is its own type, with its own content
  // ---------------------------------------------------------------------
  describe('the round type', () => {
    it('exists and accepts pubquiz content', async () => {
      const { id } = await addQuestion(roundId, 0, 'Hoofdstad van Peru?');
      const { rows } = await db.query('SELECT question FROM pubquiz_questions WHERE id=$1', [id]);
      expect(rows[0].question).toBe('Hoofdstad van Peru?');
    });

    it('refuses pubquiz content on a round of another type', async () => {
      const presentation = await addRound(db, gameId, 'PRESENTATIE');
      await expect(db.query(
        `INSERT INTO pubquiz_questions(game_night_id,round_id,sort_order,question,body,points)
         VALUES($1,$2,0,'nope','',10)`,
        [gameId, presentation],
      )).rejects.toThrow(/PUBQUIZ content cannot be added to a PRESENTATIE round/);
    });

    it('refuses quiz content on a pubquiz round, so the two never share a table', async () => {
      await expect(db.query(
        'INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt) VALUES($1,$2,0,$3)',
        [gameId, roundId, 'nope'],
      )).rejects.toThrow(/LIVE_QUIZ content cannot be added to a PUBQUIZ round/);
    });

    // A pub quiz announces *the* answer, so two of them would make both the projector's
    // reveal and the player's "you were right" ambiguous.
    it('allows exactly one correct answer per question', async () => {
      const { id } = await addQuestion(roundId, 0, 'Q');
      await expect(db.query(
        `INSERT INTO pubquiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
         VALUES($1,$2,3,'second correct',TRUE)`,
        [id, gameId],
      )).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------
  // 13-14 · answers
  // ---------------------------------------------------------------------
  describe('answers', () => {
    it('takes one answer per player and no more', async () => {
      const { id, optionIds } = await addQuestion(roundId, 0, 'Q');
      await db.query(
        'INSERT INTO pubquiz_answers(game_night_id,round_id,question_id,option_id,player_id) VALUES($1,$2,$3,$4,501)',
        [gameId, roundId, id, optionIds[0]],
      );
      await expect(db.query(
        'INSERT INTO pubquiz_answers(game_night_id,round_id,question_id,option_id,player_id) VALUES($1,$2,$3,$4,501)',
        [gameId, roundId, id, optionIds[1]],
      )).rejects.toThrow();
    });

    it('keeps each player’s answer separate', async () => {
      const { id, optionIds } = await addQuestion(roundId, 0, 'Q');
      await db.query(
        `INSERT INTO pubquiz_answers(game_night_id,round_id,question_id,option_id,player_id)
         VALUES($1,$2,$3,$4,501),($1,$2,$3,$5,502)`,
        [gameId, roundId, id, optionIds[0], optionIds[1]],
      );
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM pubquiz_answers WHERE question_id=$1', [id]);
      expect(rows[0].n).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // 18-19 · rewards
  // ---------------------------------------------------------------------
  describe('rewards', () => {
    it('cannot pay one player twice for one question', async () => {
      const { id } = await addQuestion(roundId, 0, 'Q', { points: 40 });
      const insert = () => db.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,
           attributed_round_id,pubquiz_question_id,created_by,idempotency_key)
         VALUES($1,501,40,'PUBQUIZ_REWARD','reward',$2,$3,'admin',$4)`,
        [gameId, roundId, id, `pubquiz:${id}:reward:501`],
      );
      await insert();
      await expect(insert()).rejects.toThrow();
    });

    it('pays different players and different questions separately', async () => {
      const a = await addQuestion(roundId, 0, 'A', { points: 40 });
      const b = await addQuestion(roundId, 1, 'B', { points: 40 });
      await db.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,pubquiz_question_id,created_by,idempotency_key)
         VALUES($1,501,40,'PUBQUIZ_REWARD','r',$2,$3,'admin',$5),
               ($1,502,40,'PUBQUIZ_REWARD','r',$2,$3,'admin',$6),
               ($1,501,40,'PUBQUIZ_REWARD','r',$2,$4,'admin',$7)`,
        [gameId, roundId, a.id, b.id, `k1-${a.id}`, `k2-${a.id}`, `k3-${b.id}`],
      );
      // Scoped to this round's questions: the game night is shared across these tests.
      const { rows } = await db.query(
        "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transaction_type='PUBQUIZ_REWARD' AND pubquiz_question_id=ANY($1::bigint[])",
        [[a.id, b.id]],
      );
      expect(rows[0].n).toBe(3);
    });
  });

  // ---------------------------------------------------------------------
  // 21-24 · navigation and completion
  // ---------------------------------------------------------------------
  describe('navigation', () => {
    it('steps in both directions', () => {
      expect(navigationCapabilities('PUBQUIZ')).toEqual({ next: true, previous: true });
    });

    it('puts the next question straight on the big screen', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      const second = await addQuestion(roundId, 1, 'Q2');
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [first.id]);

      const result = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

      expect(result.kind).toBe('target');
      const row = await screen();
      expect(row.mode).toBe('PUBQUIZ_QUESTION');
      expect(Number(row.pubquiz_question_id)).toBe(second.id);
    });

    // One button, not two: the phones are ready before the room has finished reading.
    it('opens a fresh question the moment it goes live', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      const second = await addQuestion(roundId, 1, 'Q2');
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [first.id]);

      expect(await status(second.id)).toBe('READY');
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(await status(second.id)).toBe('OPEN');
    });

    // Stepping back must not reopen scoring the room has already watched settle.
    it('does not reopen a question it steps back onto', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      const second = await addQuestion(roundId, 1, 'Q2');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [first.id]);
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: second.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [second.id]);

      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);

      expect(Number((await screen()).pubquiz_question_id)).toBe(first.id);
      expect(await status(first.id)).toBe('REVEALED');
    });

    it('steps over a held-back question in both directions', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      const spare = await addQuestion(roundId, 1, 'Spare', { hidden: true });
      const third = await addQuestion(roundId, 2, 'Q3');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id IN ($1,$2)", [first.id, third.id]);
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');

      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).pubquiz_question_id)).toBe(third.id);
      expect(await status(spare.id)).toBe('READY');

      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
      expect(Number((await screen()).pubquiz_question_id)).toBe(first.id);
    });

    it('refuses to put a held-back question on the projector at all', async () => {
      const spare = await addQuestion(roundId, 0, 'Spare', { hidden: true });
      await expect(setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: spare.id }, 'admin'))
        .rejects.toThrow(/hidden/i);
    });

    // Stepping away from a question the room has answered but not been told about would
    // strand their answers with no reveal.
    it('refuses to move on from a question that is still open', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      await addQuestion(roundId, 1, 'Q2');
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='OPEN' WHERE question_id=$1", [first.id]);

      expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'none' });
      await expect(advanceScreen(client(), gameId, 'NEXT', 'admin', null)).rejects.toThrow(/still OPEN/);
    });

    // The last question stays up normally; the step *after* it ends the round.
    it('completes the round on the step past the last question', async () => {
      const only = await addQuestion(roundId, 0, 'Q1');
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: only.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [only.id]);

      expect((await db.query('SELECT status FROM rounds WHERE id=$1', [roundId])).rows[0].status).toBe('ACTIVE');
      const result = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

      expect(result).toMatchObject({ kind: 'completeRound', completed: true });
      expect((await db.query('SELECT status FROM rounds WHERE id=$1', [roundId])).rows[0].status).toBe('COMPLETED');
      expect((await screen()).mode).toBe('DASHBOARD');
    });

    it('treats the last visible question as the last one', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      await addQuestion(roundId, 1, 'Spare', { hidden: true });
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [first.id]);

      expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'completeRound' });
    });

    // A step carries the cursor the Admin was looking at; one from a tab that has fallen
    // behind must not drag the projector back.
    it('refuses a step issued against a revision that has moved on', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      const second = await addQuestion(roundId, 1, 'Q2');
      await addQuestion(roundId, 2, 'Q3');
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [first.id]);
      const stale = Number((await db.query('SELECT revision FROM round_runtime WHERE round_id=$1', [roundId])).rows[0].revision);

      await advanceScreen(client(), gameId, 'NEXT', 'admin', stale);
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [second.id]);

      await expect(advanceScreen(client(), gameId, 'NEXT', 'other-admin', stale)).rejects.toThrow(/moved on/i);
      expect(Number((await screen()).pubquiz_question_id)).toBe(second.id);
    });

    // The preview is the step, asked without taking it.
    it('previews exactly the step it will take', async () => {
      const first = await addQuestion(roundId, 0, 'Q1');
      const second = await addQuestion(roundId, 1, 'Q2');
      await setScreen(client(), gameId, { kind: 'pubquizQuestion', roundId, questionId: first.id }, 'test');
      await db.query("UPDATE pubquiz_question_state SET status='REVEALED' WHERE question_id=$1", [first.id]);

      const planned = await planStep(client(), gameId, 'NEXT');
      expect(planned).toMatchObject({ kind: 'target', target: { kind: 'pubquizQuestion', roundId, questionId: second.id } });
      const taken = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(taken.kind === 'target' && taken.target).toEqual((planned as any).target);
    });
  });

  // ---------------------------------------------------------------------
  // 25 · starting the round
  // ---------------------------------------------------------------------
  describe('starting the round', () => {
    it('opens on the first question in the run, already open for answers', async () => {
      await addQuestion(roundId, 0, 'Spare', { hidden: true });
      const visible = await addQuestion(roundId, 1, 'Q1');

      const target = await initialScreenTarget(client(), gameId, roundId, 'PUBQUIZ');

      expect(target).toEqual({ kind: 'pubquizQuestion', roundId, questionId: visible.id });
      expect(await status(visible.id)).toBe('OPEN');
    });

    it('leaves the screen alone for a round with no questions', async () => {
      expect(await initialScreenTarget(client(), gameId, roundId, 'PUBQUIZ')).toBeNull();
    });

    it('leaves the screen alone when every question is held back', async () => {
      await addQuestion(roundId, 0, 'Spare', { hidden: true });
      expect(await initialScreenTarget(client(), gameId, roundId, 'PUBQUIZ')).toBeNull();
    });
  });
});
