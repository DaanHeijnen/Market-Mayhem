import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { planStep, advanceScreen, initialScreenTarget, navigationCapabilities } from '../netlify/lib/screen-flow';
import { setScreen } from '../netlify/lib/game-state';
import { slotRoundIsFinished } from '../netlify/lib/slot-state';

const available = await pgliteAvailable();

describe('which rounds step, and which do not', () => {
  // Every type now opens on a title card, so every type has something to step out of and
  // back to. What differs is how far forward the sequence goes, which is planStep's job.
  it('navigates every round type, because every round has an intro', () => {
    for (const type of ['PRESENTATIE', 'LIVE_QUIZ', 'PUBQUIZ', 'ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE'] as const) {
      expect(navigationCapabilities(type), type).toEqual({ canGoNext: true, canGoPrevious: true });
    }
  });

  it('navigates nothing when no round is being played', () => {
    expect(navigationCapabilities(null)).toEqual({ canGoNext: false, canGoPrevious: false });
  });
});

describe.skipIf(!available)('stepping the projector, against a migrated database', () => {
  let db: TestDb;
  let gameId: number;
  const client = () => db as any;

  const screen = async () => (await db.query(
    'SELECT mode,round_id,slide_id,quiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId],
  )).rows[0];

  const cursor = async (roundId: number) => (await db.query(
    'SELECT current_slide_id,current_quiz_question_id,revision FROM round_runtime WHERE round_id=$1', [roundId],
  )).rows[0];

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

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 810); });
  afterAll(async () => { await db?.close(); });

  // ---------------------------------------------------------------------
  // Presentation: NEXT is live, not staged
  // ---------------------------------------------------------------------
  describe('a presentation round', () => {
    let roundId: number;
    let pages: number[];

    const addPageWithAnswer = async (round: number, sortOrder: number, title: string, answer: string | null) => {
      const { rows } = await db.query(
        `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,reveal_text)
         VALUES($1,$2,$3,$4,'',$5) RETURNING id`,
        [gameId, round, sortOrder, title, answer],
      );
      const id = Number(rows[0].id);
      await db.query('INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, round]);
      return id;
    };

    beforeEach(async () => {
      roundId = await addRound(db, gameId, 'PRESENTATIE');
      await activate(roundId);
      pages = [
        await addPage(roundId, 0, 'Page 1'),
        await addPage(roundId, 1, 'Page 2'),
        await addPage(roundId, 2, 'Page 3'),
      ];
      await setScreen(client(), gameId, { kind: 'roundIntro', roundId }, 'test');
    });

    // 4-5 · the round opens on its own title card, not on its content
    it('starts on the intro and reaches the first page only on VOLGENDE', async () => {
      expect((await screen()).mode).toBe('ROUND_INTRO');

      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

      const row = await screen();
      expect(row.mode).toBe('SLIDE');
      expect(Number(row.slide_id)).toBe(pages[0]);
    });

    it('puts the next page on the projector immediately, with no go-live step', async () => {
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[1]);
    });

    // 9-11 · a page with an answer is two steps, not one
    it('shows a page, then its answer, then the next page', async () => {
      const withAnswer = await addRound(db, gameId, 'PRESENTATIE');
      await activate(withAnswer);
      const one = await addPageWithAnswer(withAnswer, 0, 'Vraag 1', 'Lima');
      const two = await addPageWithAnswer(withAnswer, 1, 'Vraag 2', null);
      await setScreen(client(), gameId, { kind: 'roundIntro', roundId: withAnswer }, 'test');

      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(one);
      expect((await db.query('SELECT revealed_at FROM presentation_slide_state WHERE slide_id=$1', [one])).rows[0].revealed_at).toBeNull();

      // The answer is the next step, on the same page.
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(one);
      expect((await db.query('SELECT revealed_at FROM presentation_slide_state WHERE slide_id=$1', [one])).rows[0].revealed_at).not.toBeNull();

      // And only then the next page.
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(two);
    });

    // 12 · no empty answer card for a page that has nothing to reveal
    it('does not invent an answer step for a page without one', async () => {
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[0]);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[1]);
    });

    // 13 · VORIGE is presentation history, not an undo
    it('steps back without un-revealing anything', async () => {
      const withAnswer = await addRound(db, gameId, 'PRESENTATIE');
      await activate(withAnswer);
      const one = await addPageWithAnswer(withAnswer, 0, 'Vraag 1', 'Lima');
      const two = await addPageWithAnswer(withAnswer, 1, 'Vraag 2', null);
      await setScreen(client(), gameId, { kind: 'roundIntro', roundId: withAnswer }, 'test');
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // page 1
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // its answer
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // page 2

      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);

      expect(Number((await screen()).slide_id)).toBe(one);
      // Still revealed: going back shows the page as it now is, rather than undoing it.
      expect((await db.query('SELECT revealed_at FROM presentation_slide_state WHERE slide_id=$1', [one])).rows[0].revealed_at).not.toBeNull();
      expect(two).toBeTruthy();
    });

    it('steps back from the first page to the intro', async () => {
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
      expect((await screen()).mode).toBe('ROUND_INTRO');
    });

    it('has nowhere to step back from the intro', async () => {
      expect(await planStep(client(), gameId, 'PREVIOUS')).toMatchObject({ kind: 'none' });
      await expect(advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null)).rejects.toThrow(/start of the round/i);
    });

    // 14 · hidden pages are not part of the run
    it('steps over a held-back page in both directions', async () => {
      await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[2]);

      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[0]);
    });

    // The preview is the step, asked without taking it. If these could disagree the whole
    // LIVE/NEXT pair would be a lie.
    it('previews exactly the step it will take', async () => {
      const planned = await planStep(client(), gameId, 'NEXT');
      expect(planned).toMatchObject({ kind: 'target', target: { kind: 'slide', roundId, slideId: pages[0] } });
      const taken = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(taken.kind === 'target' && taken.target).toEqual((planned as any).target);
    });

    // 15 · completion comes after the last relevant state, not before
    it('completes the round only after the last page and its answer', async () => {
      const withAnswer = await addRound(db, gameId, 'PRESENTATIE');
      await activate(withAnswer);
      await addPageWithAnswer(withAnswer, 0, 'Laatste', 'Het antwoord');
      await setScreen(client(), gameId, { kind: 'roundIntro', roundId: withAnswer }, 'test');

      await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // the page
      expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'target' });

      await advanceScreen(client(), gameId, 'NEXT', 'admin', null); // its answer
      expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'completeRound' });

      const result = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(result).toMatchObject({ kind: 'completeRound', completed: true });
      expect((await db.query('SELECT status FROM rounds WHERE id=$1', [withAnswer])).rows[0].status).toBe('COMPLETED');
      expect((await screen()).mode).toBe('DASHBOARD');
    });

    // A step carries the screen revision the Admin was looking at.
    it('refuses a step issued against a revision that has moved on', async () => {
      const stale = Number((await db.query('SELECT revision FROM screen_state WHERE game_night_id=$1', [gameId])).rows[0].revision);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', stale);

      await expect(advanceScreen(client(), gameId, 'NEXT', 'other-admin', stale)).rejects.toThrow(/moved on/i);
      expect(Number((await screen()).slide_id)).toBe(pages[0]);
    });

    // Two clicks in a row are two steps, not one step twice.
    it('takes two presses as two steps', async () => {
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[1]);
    });
  });

  // ---------------------------------------------------------------------
  // Rounds that are one scene
  // ---------------------------------------------------------------------
  /**
   * A game round is a short story: its title card, then its one live scene, which its own
   * controls drive. Stepping past the scene ends the round; stepping back returns to the
   * card without touching anything the round has done.
   */
  it('walks a roulette round from intro to scene to completion', async () => {
    const roundId = await addRound(db, gameId, 'ROULETTE');
    await activate(roundId);
    await setScreen(client(), gameId, { kind: 'roundIntro', roundId }, 'test');

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect((await screen()).mode).toBe('ROULETTE');

    // Back to the card, and no financial state is touched by a navigation button.
    await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
    expect((await screen()).mode).toBe('ROUND_INTRO');

    await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
    expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'completeRound' });
  });

  // 35 · a settled spin is never unspun by a navigation button
  it('leaves a settled roulette run alone when stepping back', async () => {
    const roundId = await addRound(db, gameId, 'ROULETTE');
    await activate(roundId);
    const { rows } = await db.query(
      `INSERT INTO roulette_games(game_night_id,round_id,status,run_number,result_number,total_staked,total_payout)
       VALUES($1,$2,'SETTLED',1,17,120,90) RETURNING id`,
      [gameId, roundId],
    );
    await setScreen(client(), gameId, { kind: 'roundGame', roundId }, 'test');

    await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);

    const run = await db.query('SELECT status,total_payout FROM roulette_games WHERE id=$1', [Number(rows[0].id)]);
    expect(run.rows[0].status).toBe('SETTLED');
    expect(Number(run.rows[0].total_payout)).toBe(90);
  });

  // ---------------------------------------------------------------------
  // Starting a round claims the big screen
  // ---------------------------------------------------------------------
  describe('what a round opens on', () => {
    // 1-4 · every type, without exception, opens on its own title card
    it('opens every round type on its intro', async () => {
      for (const type of ['PRESENTATIE', 'LIVE_QUIZ', 'PUBQUIZ', 'ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE'] as const) {
        const roundId = await addRound(db, gameId, type);
        expect(await initialScreenTarget(client(), gameId, roundId, type), type)
          .toEqual({ kind: 'roundIntro', roundId });
      }
    });

    // 5 · the content waits for a press, even on a round that has plenty of it
    it('does not jump past the intro into the content', async () => {
      const roundId = await addRound(db, gameId, 'PRESENTATIE');
      await addPage(roundId, 0, 'Page 1');
      expect(await initialScreenTarget(client(), gameId, roundId, 'PRESENTATIE'))
        .toEqual({ kind: 'roundIntro', roundId });
    });

    // An empty round still gets its card: it is the round announcing itself, and has
    // nothing to do with whether the round holds anything.
    it('opens an empty round on its intro too', async () => {
      const roundId = await addRound(db, gameId, 'PRESENTATIE');
      expect(await initialScreenTarget(client(), gameId, roundId, 'PRESENTATIE'))
        .toEqual({ kind: 'roundIntro', roundId });
    });
  });
});

describe.skipIf(!available)('a slotmachine round ending itself', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;

  const addSeries = async (playerId: number, spinsRemaining: number, status = 'ACTIVE') => {
    await db.query(
      `INSERT INTO slot_series(game_night_id,round_id,player_id,stake_per_spin,total_spins,spins_remaining,total_stake,status,idempotency_key)
       VALUES($1,$2,$3,5,3,$4,15,$5,$6)`,
      [gameId, roundId, playerId, spinsRemaining, status, `s-${playerId}-${spinsRemaining}-${status}-${Math.random()}`],
    );
  };

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 820); });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.query('DELETE FROM slot_series WHERE game_night_id=$1', [gameId]);
    roundId = await addRound(db, gameId, 'SLOTMACHINE');
  });

  it('is not finished while somebody still has spins', async () => {
    await addSeries(501, 0);
    await addSeries(502, 2);
    expect((await slotRoundIsFinished(db as any, gameId, roundId)).finished).toBe(false);
  });

  it('is not finished while a player has not played at all', async () => {
    await addSeries(501, 0);
    const state = await slotRoundIsFinished(db as any, gameId, roundId);
    expect(state.eligibleCount).toBe(2);
    expect(state.finishedCount).toBe(1);
    expect(state.finished).toBe(false);
  });

  it('is finished once everybody has used their run', async () => {
    await addSeries(501, 0);
    await addSeries(502, 0);
    expect((await slotRoundIsFinished(db as any, gameId, roundId)).finished).toBe(true);
  });

  // A spin still turning is a player who has not finished, whatever the counter says.
  it('is not finished while a spin is still resolving', async () => {
    await addSeries(501, 0);
    await addSeries(502, 0);
    await db.query(
      `INSERT INTO slot_spins(slot_series_id,game_night_id,round_id,player_id,spin_number,
         reel1_position,reel2_position,reel3_position,reel1_media_key,reel2_media_key,reel3_media_key,
         stake,payout_multiplier,payout,idempotency_key,status,outcome_type,grid,win_cells)
       SELECT id,$1,$2,player_id,1,1,1,1,'a','b','c',5,0,0,'spin-k','SPINNING','NO_WIN','[]'::jsonb,'[]'::jsonb
       FROM slot_series WHERE round_id=$2 LIMIT 1`,
      [gameId, roundId],
    );
    expect((await slotRoundIsFinished(db as any, gameId, roundId)).finished).toBe(false);
  });

  // The allowlist decides who the round waits for, so a round for two of ten players
  // ends when those two are done.
  it('waits only for the players the round is for', async () => {
    await db.query('INSERT INTO slotmachine_round_participants(game_night_id,round_id,player_id) VALUES($1,$2,501)', [gameId, roundId]);
    await addSeries(501, 0);
    const state = await slotRoundIsFinished(db as any, gameId, roundId);
    expect(state.eligibleCount).toBe(1);
    expect(state.finished).toBe(true);
  });

  // A refunded series was never used, so it does not count as having played.
  it('does not count a cancelled series as a turn taken', async () => {
    await addSeries(501, 0);
    await addSeries(502, 0, 'CANCELLED');
    expect((await slotRoundIsFinished(db as any, gameId, roundId)).finished).toBe(false);
  });

  it('never fires on a round nobody could play', async () => {
    await db.query("UPDATE players SET active=FALSE WHERE game_night_id=$1", [gameId]);
    const state = await slotRoundIsFinished(db as any, gameId, roundId);
    expect(state.eligibleCount).toBe(0);
    expect(state.finished).toBe(false);
    await db.query("UPDATE players SET active=TRUE WHERE game_night_id=$1", [gameId]);
  });
});

/**
 * The whole story, walked end to end.
 *
 * Start a presentation and press VOLGENDE until the round ends, checking at every step
 * that the projector snapshot and the Admin's LIVE pane are the same thing — they are fed
 * by the same function, so this is really a check that nothing has grown a second path.
 */
describe.skipIf(!available)('walking a presentation from start to finish', () => {
  let db: TestDb;
  let gameId: number;
  const client = () => db as any;

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 840); });
  afterAll(async () => { await db?.close(); });

  it('goes intro → vraag 1 → antwoord 1 → vraag 2 → antwoord 2 → completed', async () => {
    const roundId = await addRound(db, gameId, 'PRESENTATIE');
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE game_nights SET current_round_id=$2 WHERE id=$1', [gameId, roundId]);

    const ids: number[] = [];
    for (const [order, title] of [[0, 'Vraag 1'], [1, 'Vraag 2']] as const) {
      const { rows } = await db.query(
        `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,reveal_text)
         VALUES($1,$2,$3,$4,'','Het antwoord') RETURNING id`,
        [gameId, roundId, order, title],
      );
      const id = Number(rows[0].id);
      await db.query('INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)', [id, gameId, roundId]);
      ids.push(id);
    }

    await setScreen(client(), gameId, { kind: 'roundIntro', roundId }, 'test');

    /** What the projector is pointed at, as both surfaces read it. */
    const where = async () => {
      const { rows } = await db.query(
        'SELECT mode,slide_id FROM screen_state WHERE game_night_id=$1', [gameId],
      );
      const revealed = rows[0].slide_id
        ? (await db.query('SELECT revealed_at FROM presentation_slide_state WHERE slide_id=$1', [rows[0].slide_id])).rows[0].revealed_at != null
        : false;
      return { mode: rows[0].mode, slideId: Number(rows[0].slide_id || 0) || null, revealed };
    };

    const seen: any[] = [await where()];
    // One press per step, six presses to walk two pages and their answers and end.
    for (let i = 0; i < 5; i += 1) {
      // The preview promises this step before it is taken.
      const planned = await planStep(client(), gameId, 'NEXT');
      const taken = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(taken.kind, `step ${i}`).toBe(planned.kind);
      if (taken.kind !== 'completeRound') seen.push(await where());
    }

    expect(seen).toEqual([
      { mode: 'ROUND_INTRO', slideId: null, revealed: false },
      { mode: 'SLIDE', slideId: ids[0], revealed: false },
      { mode: 'SLIDE', slideId: ids[0], revealed: true },
      { mode: 'SLIDE', slideId: ids[1], revealed: false },
      { mode: 'SLIDE', slideId: ids[1], revealed: true },
    ]);

    // And the sixth press ends the round.
    expect((await db.query('SELECT status FROM rounds WHERE id=$1', [roundId])).rows[0].status).toBe('COMPLETED');
    expect((await where()).mode).toBe('DASHBOARD');
  });
});
