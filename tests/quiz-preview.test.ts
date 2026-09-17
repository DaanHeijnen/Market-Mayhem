import { beforeEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';

/**
 * PREVIEW = NEXT(LIVE), for a room full of questions.
 *
 * The Admin's VOLGENDE column is the projector's own snapshot of the step the button would
 * take, so the only way to test it honestly is to take the step and compare. Every case
 * here checks both columns after every press.
 *
 * The bug it was written for: asking a question and answering it were one boolean on the
 * step, so the preview could not tell them apart and drew every arrival as a reveal. The
 * host saw question 2 *with its correct answer* as the preview of "go to question 2" — one
 * press early, and with the answer on screen before the room had been asked.
 */

const { holder } = vi.hoisted(() => ({ holder: { pool: null as any } }));
vi.mock('../netlify/lib/db', () => ({
  database: () => ({ pool: holder.pool, sql: async () => [] }),
  withTransaction: async (fn: any) => fn(holder.pool),
}));

const { advanceScreen } = await import('../netlify/lib/screen-flow');
const { previewNavigation } = await import('../netlify/lib/screen-preview');
const { getScreenState } = await import('../netlify/lib/queries');
const { setScreen } = await import('../netlify/lib/game-state');

const available = await pgliteAvailable();

describe.skipIf(!available)('what VOLGENDE will put on the screen, for a quiz', () => {
  let db: TestDb;
  let gameId: number;

  beforeAll(async () => {
    db = await migratedDb();
    holder.pool = db;
    gameId = await seedGame(db, 902);
  });
  afterAll(async () => { await db?.close(); });

  const activate = async (roundId: number) => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
    await setScreen(db as any, gameId, { kind: 'roundIntro', roundId }, 'test');
  };

  const next = () => advanceScreen(db as any, gameId, 'NEXT', 'test', null);
  const back = () => advanceScreen(db as any, gameId, 'PREVIOUS', 'test', null);

  // Both flavours in one shape. The two round types hold different tables and the same
  // chronology, so the cases below are written once and run twice.
  const FLAVOURS = [
    {
      name: 'PUBQUIZ',
      type: 'PUBQUIZ' as const,
      scene: 'PUBQUIZ_QUESTION',
      field: 'pubquizQuestion',
      textOf: (q: any) => q.question,
      add: async (roundId: number, sortOrder: number, prompt: string, correct: string) => {
        const { rows } = await db.query(
          `INSERT INTO pubquiz_questions(game_night_id,round_id,sort_order,question,body,points)
           VALUES($1,$2,$3,$4,'',10) RETURNING id`,
          [gameId, roundId, sortOrder, prompt],
        );
        const id = Number(rows[0].id);
        await db.query('INSERT INTO pubquiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
        for (const [i, text] of ['A', 'B', 'C'].entries()) {
          await db.query(
            `INSERT INTO pubquiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
             VALUES($1,$2,$3,$4,$5)`,
            [id, gameId, i, text, text === correct],
          );
        }
        return id;
      },
      status: (id: number) => db.query('SELECT status FROM pubquiz_question_state WHERE question_id=$1', [id]),
    },
    {
      name: 'LIVE_QUIZ',
      type: 'LIVE_QUIZ' as const,
      scene: 'QUIZ_QUESTION',
      field: 'quizQuestion',
      textOf: (q: any) => q.prompt,
      add: async (roundId: number, sortOrder: number, prompt: string, correct: string) => {
        const { rows } = await db.query(
          `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,body,points)
           VALUES($1,$2,$3,$4,'',10) RETURNING id`,
          [gameId, roundId, sortOrder, prompt],
        );
        const id = Number(rows[0].id);
        await db.query('INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
        for (const [i, text] of ['A', 'B', 'C'].entries()) {
          await db.query(
            `INSERT INTO live_quiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
             VALUES($1,$2,$3,$4,$5)`,
            [id, gameId, i, text, text === correct],
          );
        }
        return id;
      },
      status: (id: number) => db.query('SELECT status FROM live_quiz_question_state WHERE question_id=$1', [id]),
    },
  ];

  for (const flavour of FLAVOURS) {
    describe(flavour.name, () => {
      let roundId: number;
      let ids: number[];

      /** What the room can see, reduced to the two things that matter. */
      const live = async () => {
        const s: any = await getScreenState(gameId);
        if (s.mode !== flavour.scene) return { mode: s.mode };
        const q = s[flavour.field];
        return {
          question: flavour.textOf(q),
          status: q.status,
          // Present only from the reveal onwards — the server does not put it on the wire
          // before that, so this is the leak check as much as the state check.
          answer: q.options.find((o: any) => o.isCorrect)?.text ?? null,
        };
      };

      const preview = async (direction: 'NEXT' | 'PREVIOUS' = 'NEXT') => {
        const p: any = await previewNavigation(db as any, gameId, direction);
        if (!p.preview) return { step: p.step, label: p.label };
        if (p.preview.mode !== flavour.scene) return { step: p.step, mode: p.preview.mode };
        const q = p.preview[flavour.field];
        return {
          question: flavour.textOf(q),
          status: q.status,
          answer: q.options.find((o: any) => o.isCorrect)?.text ?? null,
        };
      };

      beforeEach(async () => {
        roundId = await addRound(db, gameId, flavour.type, { status: 'UPCOMING', title: `${flavour.name} ronde` });
        ids = [
          await flavour.add(roundId, 1, 'Vraag 1', 'B'),
          await flavour.add(roundId, 2, 'Vraag 2', 'C'),
          await flavour.add(roundId, 3, 'Vraag 3', 'A'),
        ];
        await activate(roundId);
      });

      // The whole invariant, walked: after every press, LIVE is what the previous preview
      // promised and the new preview is the press after that.
      it('previews the question, then its answer, then the next question', async () => {
        // On the intro. The next press asks question 1 — it does not answer it.
        expect(await preview()).toEqual({ question: 'Vraag 1', status: 'OPEN', answer: null });

        await next();
        expect(await live()).toEqual({ question: 'Vraag 1', status: 'OPEN', answer: null });
        expect(await preview()).toEqual({ question: 'Vraag 1', status: 'REVEALED', answer: 'B' });

        await next();
        expect(await live()).toEqual({ question: 'Vraag 1', status: 'REVEALED', answer: 'B' });
        // The press after the answer goes to question 2 — asked, not answered.
        expect(await preview()).toEqual({ question: 'Vraag 2', status: 'OPEN', answer: null });

        await next();
        expect(await live()).toEqual({ question: 'Vraag 2', status: 'OPEN', answer: null });
        expect(await preview()).toEqual({ question: 'Vraag 2', status: 'REVEALED', answer: 'C' });

        await next();
        expect(await live()).toEqual({ question: 'Vraag 2', status: 'REVEALED', answer: 'C' });
        expect(await preview()).toEqual({ question: 'Vraag 3', status: 'OPEN', answer: null });
      });

      // The half of the bug that was a security problem rather than a confusing one.
      it('never previews the next question already answered', async () => {
        await next();
        await next();
        const p: any = await previewNavigation(db as any, gameId, 'NEXT');
        const q = p.preview[flavour.field];
        expect(flavour.textOf(q)).toBe('Vraag 2');
        expect(q.status).not.toBe('REVEALED');
        expect(q.options.every((o: any) => !('isCorrect' in o))).toBe(true);
        expect(JSON.stringify(p.preview)).not.toContain('isCorrect');
      });

      it('keeps the answer off the projector until the room has been asked', async () => {
        await next();
        const snapshot: any = await getScreenState(gameId);
        const q = snapshot[flavour.field];
        expect(q.status).toBe('OPEN');
        expect(q.options.map((o: any) => Object.keys(o))).not.toContainEqual(expect.arrayContaining(['isCorrect']));
      });

      it('opens the question it steps onto, and pays only on the reveal', async () => {
        await next();
        expect((await flavour.status(ids[0])).rows[0].status).toBe('OPEN');
        expect((await flavour.status(ids[1])).rows[0].status).toBe('READY');

        await next();
        expect((await flavour.status(ids[0])).rows[0].status).toBe('REVEALED');
        // Arriving at the next question must not have asked it early.
        expect((await flavour.status(ids[1])).rows[0].status).toBe('READY');

        await next();
        expect((await flavour.status(ids[1])).rows[0].status).toBe('OPEN');
      });

      // Two presses from the same revision are one step, in this round type too.
      it('takes a double click as one step', async () => {
        const revision = Number((await db.query('SELECT revision FROM screen_state WHERE game_night_id=$1', [gameId])).rows[0].revision);
        await advanceScreen(db as any, gameId, 'NEXT', 'test', revision);
        await expect(advanceScreen(db as any, gameId, 'NEXT', 'test', revision)).rejects.toThrow(/moved on/);
        expect(await live()).toMatchObject({ question: 'Vraag 1', status: 'OPEN' });
      });

      // Going back is the same state machine, not a second set of rules — and it never
      // un-pays a question that has already rewarded the room.
      it('steps back without unasking or unpaying anything', async () => {
        await next();
        await next();
        await next();
        expect(await live()).toMatchObject({ question: 'Vraag 2', status: 'OPEN' });

        await back();
        expect(await live()).toEqual({ question: 'Vraag 1', status: 'REVEALED', answer: 'B' });
        expect((await flavour.status(ids[1])).rows[0].status).toBe('OPEN');

        // And forward again lands on question 2 as it now stands, not re-opened.
        expect(await preview()).toMatchObject({ question: 'Vraag 2', status: 'OPEN' });
      });
    });
  }

  // The context photo is a LIVE_QUIZ scene that already worked. These are here to prove
  // the preview change left it exactly where it was: same moment, same navigation, same
  // withheld key.
  describe('the LIVE_QUIZ context photo, unchanged', () => {
    let roundId: number;
    let withPhoto: number;

    const shown = async () => (await db.query(
      'SELECT context_photo_shown FROM live_quiz_question_state WHERE question_id=$1', [withPhoto],
    )).rows[0].context_photo_shown;

    beforeEach(async () => {
      roundId = await addRound(db, gameId, 'LIVE_QUIZ', { status: 'UPCOMING', title: 'Met fotos' });
      const add = async (sortOrder: number, prompt: string, contextKey: string | null) => {
        const { rows } = await db.query(
          `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,body,points,context_media_key)
           VALUES($1,$2,$3,$4,'',10,$5) RETURNING id`,
          [gameId, roundId, sortOrder, prompt, contextKey],
        );
        const id = Number(rows[0].id);
        await db.query('INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
        await db.query(
          `INSERT INTO live_quiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
           VALUES($1,$2,0,'A',TRUE),($1,$2,1,'B',FALSE)`,
          [id, gameId],
        );
        return id;
      };
      withPhoto = await add(1, 'Met foto', '1/image/bewijs.png');
      await add(2, 'Zonder foto', null);
      await activate(roundId);
    });

    it('still shows the photo after the answer, and not before', async () => {
      await next();  // ask
      expect(await shown()).toBe(false);
      await next();  // answer
      expect(await shown()).toBe(false);

      // The photo is its own step on the same question, after the reveal.
      const planned: any = await previewNavigation(db as any, gameId, 'NEXT');
      expect(planned.label).toContain('foto');
      await next();
      expect(await shown()).toBe(true);

      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.quizQuestion.showingContextPhoto).toBe(true);
      expect(snapshot.quizQuestion.contextMediaKey).toBe('1/image/bewijs.png');
    });

    it('still withholds the photo key while the question is only asked', async () => {
      await next();
      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.quizQuestion.contextMediaKey).toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain('bewijs.png');
    });

    it('still steps back off the photo onto the answer it belongs to', async () => {
      await next();
      await next();
      await next();
      expect(await shown()).toBe(true);

      await back();
      expect(await shown()).toBe(false);
      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.quizQuestion.status).toBe('REVEALED');
    });

    it('still invents no photo step for a question that has none', async () => {
      await next();  // ask 1
      await next();  // answer 1
      await next();  // photo 1
      await next();  // ask 2
      await next();  // answer 2
      const after: any = await previewNavigation(db as any, gameId, 'NEXT');
      expect(after.step).toBe('completeRound');
    });
  });
});
