import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import {
  displayStateOf,
  presentationSequence,
  presentationStep,
  type PresentationPageState,
} from '../netlify/lib/presentation';

/**
 * The presentation display-state machine, and the LIVE/VOLGENDE pair built on top of it.
 *
 * Two halves, tested apart. The sequence itself is arithmetic over a list and is checked
 * without a database; what the host actually sees is checked against a real one, driving
 * the same `advanceScreen` the VOLGENDE button calls and reading the same snapshot the
 * projector polls — because the bug this suite exists for was not in the sequence at all.
 * The walk was right; the projector's snapshot read its pointers off the wrong table, so
 * the big screen stayed on the round's title card while the preview marched on. Nothing
 * short of asking the real snapshot builder what the room can see would have caught it.
 */

const { holder } = vi.hoisted(() => ({ holder: { pool: null as any } }));
vi.mock('../netlify/lib/db', () => ({
  database: () => ({ pool: holder.pool, sql: async () => [] }),
  withTransaction: async (fn: any) => fn(holder.pool),
}));

const { advanceScreen, planStep } = await import('../netlify/lib/screen-flow');
const { previewNavigation } = await import('../netlify/lib/screen-preview');
const { getScreenState } = await import('../netlify/lib/queries');
const { setScreen } = await import('../netlify/lib/game-state');

const available = await pgliteAvailable();

// ---------------------------------------------------------------------------
// The sequence, on its own
// ---------------------------------------------------------------------------

const page = (id: number, hasAnswer = false, revealed = false, hidden = false): PresentationPageState =>
  ({ id, hasAnswer, revealed, hidden });

/** The walk written out, so a test reads like the sequence it is checking. */
const walk = (pages: PresentationPageState[], direction: 'NEXT' | 'PREVIOUS' = 'NEXT') => {
  const order = direction === 'NEXT' ? pages : [...pages];
  const seen: string[] = [];
  let at = direction === 'NEXT'
    ? null
    : (() => {
      const last = presentationSequence(order).filter(e => !e.hidden).pop();
      return last ? { slideId: last.slideId, revealed: last.revealed } : null;
    })();
  if (at) seen.push(`${at.slideId}${at.revealed ? ' revealed' : ''}`);
  for (let guard = 0; guard < 50; guard += 1) {
    const step = presentationStep(order, at, direction);
    if (step.kind !== 'state') { seen.push(step.kind.toUpperCase()); break; }
    at = step.state;
    seen.push(`${at.slideId}${at.revealed ? ' revealed' : ''}`);
  }
  return seen;
};

describe('the display-state sequence', () => {
  it('gives a page with nothing held back exactly one state', () => {
    expect(presentationSequence([page(1), page(2)])).toEqual([
      { slideId: 1, revealed: false, hidden: false, index: 0 },
      { slideId: 2, revealed: false, hidden: false, index: 1 },
    ]);
  });

  it('gives a page with an answer two states, in order', () => {
    expect(presentationSequence([page(1, true)]).map(e => e.revealed)).toEqual([false, true]);
  });

  // Scenario B in the brief: no answers anywhere, so no answer steps anywhere.
  it('walks pages without answers straight through', () => {
    expect(walk([page(1), page(2), page(3)])).toEqual(['1', '2', '3', 'END']);
  });

  it('walks a page and then its answer when there is one', () => {
    expect(walk([page(1, true), page(2, true), page(3, true)]))
      .toEqual(['1', '1 revealed', '2', '2 revealed', '3', '3 revealed', 'END']);
  });

  // The mixed case from the brief, which is the one an ad-hoc implementation gets wrong.
  it('mixes the two without inventing an empty answer step', () => {
    expect(walk([page(1), page(2, true), page(3), page(4, true)]))
      .toEqual(['1', '2', '2 revealed', '3', '4', '4 revealed', 'END']);
  });

  it('starts on the first page unrevealed even when the first page has an answer', () => {
    expect(walk([page(1, true), page(2)])[0]).toBe('1');
  });

  it('ends on the last page\'s answer, then the end of the round', () => {
    const steps = walk([page(1), page(2, true)]);
    expect(steps.slice(-3)).toEqual(['2', '2 revealed', 'END']);
  });

  it('walks a one-page presentation, with and without an answer', () => {
    expect(walk([page(1)])).toEqual(['1', 'END']);
    expect(walk([page(1, true)])).toEqual(['1', '1 revealed', 'END']);
  });

  it('walks backwards through exactly the same states', () => {
    expect(walk([page(1), page(2, true), page(3), page(4, true)], 'PREVIOUS'))
      .toEqual(['4 revealed', '4', '3', '2 revealed', '2', '1', 'START']);
  });

  it('steps over a held-back page in both directions', () => {
    expect(walk([page(1), page(2, true, false, true), page(3)])).toEqual(['1', '3', 'END']);
    expect(walk([page(1), page(2, true, false, true), page(3)], 'PREVIOUS')).toEqual(['3', '1', 'START']);
  });

  it('steps off a page that was held back while it was up', () => {
    const pages = [page(1), page(2, false, false, true), page(3)];
    expect(presentationStep(pages, { slideId: 2, revealed: false }, 'NEXT')).toEqual({ kind: 'state', state: { slideId: 3, revealed: false } });
    expect(presentationStep(pages, { slideId: 2, revealed: false }, 'PREVIOUS')).toEqual({ kind: 'state', state: { slideId: 1, revealed: false } });
  });

  it('has nowhere to go in a presentation with no visible pages', () => {
    expect(presentationStep([], null, 'NEXT')).toEqual({ kind: 'end' });
    expect(presentationStep([page(1, false, false, true)], null, 'NEXT')).toEqual({ kind: 'end' });
  });

  it('puts a page whose answer line was deleted back on its only remaining state', () => {
    // `revealed` survives in the database; the sequence no longer has a revealed state for
    // this page, so standing on one would be standing nowhere.
    expect(displayStateOf(page(1, false, true))).toEqual({ slideId: 1, revealed: false });
  });
});

// ---------------------------------------------------------------------------
// The same machine, driving a real projector
// ---------------------------------------------------------------------------

describe.skipIf(!available)('a presentation on the big screen', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;
  let pages: number[];

  /** What the room can see: the projector's own snapshot, as the big screen renders it. */
  const live = async () => {
    const s: any = await getScreenState(gameId);
    if (s.mode !== 'SLIDE') return { mode: s.mode, recovered: Boolean(s.screenRecovered) };
    return { mode: 'SLIDE', page: s.slide?.title ?? null, revealed: Boolean(s.slide?.revealed), answer: s.slide?.revealText ?? null };
  };

  /** What the Admin's VOLGENDE column is drawing, through the same snapshot builder. */
  const preview = async (direction: 'NEXT' | 'PREVIOUS' = 'NEXT') => {
    const p: any = await previewNavigation(db as any, gameId, direction);
    if (!p.preview) return { step: p.step, label: p.label, reason: p.reason };
    if (p.preview.mode !== 'SLIDE') return { step: p.step, mode: p.preview.mode };
    return {
      step: p.step,
      page: p.preview.slide?.title ?? null,
      revealed: Boolean(p.preview.slide?.revealed),
      answer: p.preview.slide?.revealText ?? null,
    };
  };

  const next = () => advanceScreen(db as any, gameId, 'NEXT', 'test', null);
  const back = () => advanceScreen(db as any, gameId, 'PREVIOUS', 'test', null);
  const revision = async () => Number((await db.query('SELECT revision FROM screen_state WHERE game_night_id=$1', [gameId])).rows[0].revision);

  const addPage = async (sortOrder: number, title: string, answer: string | null, hidden = false) => {
    const { rows } = await db.query(
      `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,reveal_text,hidden)
       VALUES($1,$2,$3,$4,'',$5,$6) RETURNING id`,
      [gameId, roundId, sortOrder, title, answer, hidden],
    );
    const id = Number(rows[0].id);
    await db.query('INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
    return id;
  };

  const startRound = async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'PRESENTATIE', { status: 'ACTIVE', title: 'De ronde' });
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);
    await setScreen(db as any, gameId, { kind: 'roundIntro', roundId }, 'test');
  };

  beforeAll(async () => {
    db = await migratedDb();
    holder.pool = db;
    gameId = await seedGame(db, 901);
  });
  afterAll(async () => { await db?.close(); });

  describe('page 1 plain, pages 2 and 3 with answers', () => {
    beforeEach(async () => {
      await startRound();
      pages = [
        await addPage(1, 'Slide 1', null),
        await addPage(2, 'Slide 2', 'Antwoord 2'),
        await addPage(3, 'Slide 3', 'Antwoord 3'),
      ];
    });

    // Scenario A, walked end to end, checking both columns after every press.
    it('shows each page before its answer, and previews exactly the next press', async () => {
      // The round opens on its own title card; the content is one press away.
      expect(await live()).toEqual({ mode: 'ROUND_INTRO', recovered: false });
      expect(await preview()).toEqual({ step: 'target', page: 'Slide 1', revealed: false, answer: null });

      await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 1', revealed: false, answer: null });
      expect(await preview()).toEqual({ step: 'target', page: 'Slide 2', revealed: false, answer: null });

      // The page arrives without its answer. This is the step that used to be skipped.
      await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 2', revealed: false, answer: null });
      expect(await preview()).toEqual({ step: 'target', page: 'Slide 2', revealed: true, answer: 'Antwoord 2' });

      await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 2', revealed: true, answer: 'Antwoord 2' });
      expect(await preview()).toEqual({ step: 'target', page: 'Slide 3', revealed: false, answer: null });

      await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 3', revealed: false, answer: null });
      expect(await preview()).toEqual({ step: 'target', page: 'Slide 3', revealed: true, answer: 'Antwoord 3' });

      await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 3', revealed: true, answer: 'Antwoord 3' });
      expect(await preview()).toMatchObject({ step: 'completeRound' });
    });

    // Scenario C: the answer is not merely hidden by the renderer, it is not on the wire.
    it('never puts an unrevealed answer on the projector snapshot', async () => {
      await next();
      await next();
      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.slide.id).toBe(pages[1]);
      expect(snapshot.slide.revealed).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain('Antwoord 2');
      expect(Object.keys(snapshot.slide)).not.toContain('revealText');
    });

    // Scenario D: and the Admin's preview of the reveal does carry it, because that is the
    // scene it is drawing.
    it('gives the Admin the answer it is about to publish', async () => {
      await next();
      await next();
      const p: any = await previewNavigation(db as any, gameId, 'NEXT');
      expect(p.preview.slide.revealText).toBe('Antwoord 2');
      // And the database has not been touched by having previewed it.
      expect((await db.query('SELECT revealed_at FROM presentation_slide_state WHERE slide_id=$1', [pages[1]])).rows[0].revealed_at).toBeNull();
      expect(await live()).toMatchObject({ revealed: false, answer: null });
    });

    it('walks back through the same states, answer first', async () => {
      for (let i = 0; i < 4; i += 1) await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 3', revealed: false, answer: null });

      await back();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 2', revealed: true, answer: 'Antwoord 2' });
      await back();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 2', revealed: false, answer: null });
      await back();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 1', revealed: false, answer: null });
      await back();
      expect(await live()).toEqual({ mode: 'ROUND_INTRO', recovered: false });
    });

    it('previews the answer coming down when VORIGE would take it down', async () => {
      for (let i = 0; i < 3; i += 1) await next();
      expect(await live()).toMatchObject({ page: 'Slide 2', revealed: true });
      expect(await preview('PREVIOUS')).toEqual({ step: 'target', page: 'Slide 2', revealed: false, answer: null });
    });

    it('has nothing to step back to from the round intro', async () => {
      expect(await preview('PREVIOUS')).toMatchObject({ step: 'none', reason: 'This is the start of the round' });
    });

    it('completes the round only after the last answer', async () => {
      // Five presses to walk page 1, page 2, its answer, page 3 and its answer.
      for (let i = 0; i < 5; i += 1) await next();
      expect(await live()).toMatchObject({ page: 'Slide 3', revealed: true });
      const result: any = await advanceScreen(db as any, gameId, 'NEXT', 'test', null);
      expect(result.kind).toBe('completeRound');
      expect((await db.query('SELECT status FROM rounds WHERE id=$1', [roundId])).rows[0].status).toBe('COMPLETED');
    });

    // Scenario E / edge case 7 and 8: a second press carrying the revision the first one
    // consumed is refused, so a double click and a stale second tab both cost one step.
    it('takes two presses from the same revision as one step', async () => {
      const stale = await revision();
      await advanceScreen(db as any, gameId, 'NEXT', 'test', stale);
      await expect(advanceScreen(db as any, gameId, 'NEXT', 'test', stale)).rejects.toThrow(/moved on/);
      expect(await live()).toMatchObject({ page: 'Slide 1' });
    });

    it('lets a second press through once it carries the revision the first produced', async () => {
      const first: any = await advanceScreen(db as any, gameId, 'NEXT', 'test', await revision());
      await advanceScreen(db as any, gameId, 'NEXT', 'test', first.revision);
      expect(await live()).toMatchObject({ page: 'Slide 2', revealed: false });
    });

    it('survives a reload: the state is the database, not the Admin page', async () => {
      await next();
      await next();
      await next();
      const before = await live();
      const again = await live();
      expect(again).toEqual(before);
      expect(again).toMatchObject({ page: 'Slide 2', revealed: true });
    });
  });

  describe('edge cases', () => {
    it('starts a presentation whose first page has an answer on the page, not the answer', async () => {
      await startRound();
      await addPage(1, 'Slide 1', 'Antwoord 1');
      await addPage(2, 'Slide 2', null);
      await next();
      expect(await live()).toEqual({ mode: 'SLIDE', page: 'Slide 1', revealed: false, answer: null });
    });

    it('walks a single page with an answer', async () => {
      await startRound();
      await addPage(1, 'Enige slide', 'Het antwoord');
      await next();
      expect(await live()).toMatchObject({ page: 'Enige slide', revealed: false });
      await next();
      expect(await live()).toMatchObject({ page: 'Enige slide', revealed: true, answer: 'Het antwoord' });
      expect(await preview()).toMatchObject({ step: 'completeRound' });
    });

    it('walks a single page without one', async () => {
      await startRound();
      await addPage(1, 'Enige slide', null);
      await next();
      expect(await live()).toMatchObject({ page: 'Enige slide', revealed: false });
      expect(await preview()).toMatchObject({ step: 'completeRound' });
    });

    it('offers nothing to show when every page is held back', async () => {
      await startRound();
      await addPage(1, 'Verborgen', null, true);
      expect(await preview()).toMatchObject({ step: 'completeRound', label: 'Every page is held back' });
    });

    it('steps over a page held back mid-round, in both directions', async () => {
      await startRound();
      const ids = [await addPage(1, 'Slide 1', null), await addPage(2, 'Slide 2', 'A2'), await addPage(3, 'Slide 3', null)];
      await next();
      await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [ids[1]]);
      await next();
      expect(await live()).toMatchObject({ page: 'Slide 3' });
      await back();
      expect(await live()).toMatchObject({ page: 'Slide 1' });
    });

    it('keeps a page whose title is the answer off the wire until it is revealed', async () => {
      await startRound();
      const { rows } = await db.query(
        `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,hide_title_until_reveal)
         VALUES($1,$2,1,'Bohemian Rhapsody','',TRUE) RETURNING id`,
        [gameId, roundId],
      );
      await db.query('INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)', [Number(rows[0].id), gameId, roundId]);

      await next();
      const hidden: any = await getScreenState(gameId);
      expect(hidden.slide.title).toBeNull();
      expect(hidden.slide.titleHidden).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain('Bohemian');

      await next();
      const shown: any = await getScreenState(gameId);
      expect(shown.slide.title).toBe('Bohemian Rhapsody');
    });
  });

  // The regression that started this: the walk was right, the snapshot was not.
  describe('the projector snapshot', () => {
    it('renders the page the screen points at rather than falling back to the intro', async () => {
      await startRound();
      const id = await addPage(1, 'Slide 1', null);
      await next();
      const row = (await db.query('SELECT mode,slide_id FROM screen_state WHERE game_night_id=$1', [gameId])).rows[0];
      expect(row.mode).toBe('SLIDE');
      expect(Number(row.slide_id)).toBe(id);

      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.mode).toBe('SLIDE');
      expect(snapshot.slide.id).toBe(id);
      expect(snapshot.screenRecovered).toBeUndefined();
    });

    // The same read was wrong for every scene that points at an item inside a round, so
    // the two question types are checked here too rather than only the one that was
    // reported. A round that opens on its title card and stays there looks, to a host,
    // exactly like a round that will not start.
    it('renders a pubquiz question the screen points at', async () => {
      await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
      const round = await addRound(db, gameId, 'PUBQUIZ', { status: 'ACTIVE', title: 'Pubquiz' });
      await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, round]);
      const { rows } = await db.query(
        `INSERT INTO pubquiz_questions(game_night_id,round_id,sort_order,question,body,points)
         VALUES($1,$2,1,'Hoofdstad van Peru?','',10) RETURNING id`,
        [gameId, round],
      );
      const questionId = Number(rows[0].id);
      await db.query('INSERT INTO pubquiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [questionId, gameId, round]);
      for (let i = 0; i < 3; i += 1) {
        await db.query(
          `INSERT INTO pubquiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
           VALUES($1,$2,$3,$4,$5)`,
          [questionId, gameId, i, `Optie ${i}`, i === 0],
        );
      }
      await setScreen(db as any, gameId, { kind: 'pubquizQuestion', roundId: round, questionId }, 'test');

      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.mode).toBe('PUBQUIZ_QUESTION');
      expect(snapshot.pubquizQuestion?.id).toBe(questionId);
      expect(snapshot.screenRecovered).toBeUndefined();
    });

    it('renders a live quiz question the screen points at', async () => {
      await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
      const round = await addRound(db, gameId, 'LIVE_QUIZ', { status: 'ACTIVE', title: 'Quiz' });
      await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, round]);
      const { rows } = await db.query(
        `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,body,points)
         VALUES($1,$2,1,'Wie won in 1988?','',10) RETURNING id`,
        [gameId, round],
      );
      const questionId = Number(rows[0].id);
      await db.query('INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [questionId, gameId, round]);
      await setScreen(db as any, gameId, { kind: 'quizQuestion', roundId: round, questionId }, 'test');

      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.mode).toBe('QUIZ_QUESTION');
      expect(snapshot.quizQuestion?.id).toBe(questionId);
      expect(snapshot.screenRecovered).toBeUndefined();
    });

    it('still falls back when the page it points at really is gone', async () => {
      await startRound();
      const id = await addPage(1, 'Slide 1', null);
      await next();
      await db.query('DELETE FROM presentation_slides WHERE id=$1', [id]);
      const snapshot: any = await getScreenState(gameId);
      expect(snapshot.screenRecovered).toBe(true);
      expect(snapshot.mode).toBe('ROUND_INTRO');
    });
  });

  it('leaves the other round types walking as they did', async () => {
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    const other = await addRound(db, gameId, 'ROULETTE', { status: 'ACTIVE', title: 'Roulette' });
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, other]);
    await setScreen(db as any, gameId, { kind: 'roundIntro', roundId: other }, 'test');
    expect(await planStep(db as any, gameId, 'NEXT')).toMatchObject({ kind: 'target', target: { kind: 'roundGame', roundId: other } });
  });
});
