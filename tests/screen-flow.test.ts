import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { planStep, advanceScreen, initialScreenTarget, navigationCapabilities } from '../netlify/lib/screen-flow';
import { setScreen } from '../netlify/lib/game-state';
import { slotRoundIsFinished } from '../netlify/lib/slot-state';

const available = await pgliteAvailable();

describe('which rounds step, and which do not', () => {
  it('steps through a presentation and a quiz', () => {
    expect(navigationCapabilities('PRESENTATIE')).toEqual({ next: true, previous: true });
    expect(navigationCapabilities('LIVE_QUIZ')).toEqual({ next: true, previous: true });
  });

  // Backwards is not forced onto a state machine where going back would mean undoing a
  // settled spin. These four are one live scene driven by their own controls.
  it('does not offer stepping on a round that is one scene', () => {
    for (const type of ['ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE'] as const) {
      expect(navigationCapabilities(type), type).toEqual({ next: false, previous: false });
    }
    expect(navigationCapabilities(null)).toEqual({ next: false, previous: false });
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

    beforeEach(async () => {
      roundId = await addRound(db, gameId, 'PRESENTATIE');
      await activate(roundId);
      pages = [
        await addPage(roundId, 0, 'Page 1'),
        await addPage(roundId, 1, 'Page 2'),
        await addPage(roundId, 2, 'Page 3'),
      ];
      await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[0] }, 'test');
    });

    it('puts the next page on the projector immediately, with no go-live step', async () => {
      const result = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

      expect(result.kind).toBe('target');
      const row = await screen();
      expect(row.mode).toBe('SLIDE');
      expect(Number(row.slide_id)).toBe(pages[1]);
      // The round's own cursor came along, so progression and presentation agree.
      expect(Number((await cursor(roundId)).current_slide_id)).toBe(pages[1]);
    });

    it('steps back the same way', async () => {
      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[0]);
    });

    it('steps over a held-back page in both directions', async () => {
      await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[1]]);

      await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[2]);

      await advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null);
      expect(Number((await screen()).slide_id)).toBe(pages[0]);
    });

    // The preview is the step, asked without taking it. If these two could disagree the
    // whole LIVE/NEXT pair would be a lie.
    it('previews exactly the step it will take', async () => {
      const planned = await planStep(client(), gameId, 'NEXT');
      expect(planned).toMatchObject({ kind: 'target', target: { kind: 'slide', roundId, slideId: pages[1] } });

      const taken = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);
      expect(taken.kind === 'target' && taken.target).toEqual((planned as any).target);
    });

    // The last page stays up normally; it is the step *after* it that ends the round.
    it('keeps the round active while the last page is showing', async () => {
      await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[2] }, 'test');
      const round = await db.query('SELECT status FROM rounds WHERE id=$1', [roundId]);
      expect(round.rows[0].status).toBe('ACTIVE');
      expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'completeRound' });
    });

    it('completes the round on the step past the last page', async () => {
      await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[2] }, 'test');

      const result = await advanceScreen(client(), gameId, 'NEXT', 'admin', null);

      expect(result).toMatchObject({ kind: 'completeRound', completed: true });
      const round = await db.query('SELECT status FROM rounds WHERE id=$1', [roundId]);
      expect(round.rows[0].status).toBe('COMPLETED');
      // Nobody is playing anything, so the projector goes back to the standings.
      expect((await screen()).mode).toBe('DASHBOARD');
    });

    it('treats the last visible page as the last page, not the last row', async () => {
      await db.query('UPDATE presentation_slides SET hidden=TRUE WHERE id=$1', [pages[2]]);
      await setScreen(client(), gameId, { kind: 'slide', roundId, slideId: pages[1] }, 'test');

      expect(await planStep(client(), gameId, 'NEXT')).toMatchObject({ kind: 'completeRound' });
    });

    it('has nowhere to step back from the first page', async () => {
      expect(await planStep(client(), gameId, 'PREVIOUS')).toMatchObject({ kind: 'none' });
      await expect(advanceScreen(client(), gameId, 'PREVIOUS', 'admin', null)).rejects.toThrow(/first page/i);
    });

    // A step carries the cursor the Admin was looking at. One from a tab that has fallen
    // behind is refused rather than dragging the projector back.
    it('refuses a step issued against a revision that has moved on', async () => {
      const stale = Number((await cursor(roundId)).revision);
      await advanceScreen(client(), gameId, 'NEXT', 'admin', stale);

      await expect(advanceScreen(client(), gameId, 'NEXT', 'other-admin', stale)).rejects.toThrow(/moved on/i);
      // and the projector stayed where the winning step put it
      expect(Number((await screen()).slide_id)).toBe(pages[1]);
    });
  });

  // ---------------------------------------------------------------------
  // Rounds that are one scene
  // ---------------------------------------------------------------------
  it('refuses to step a roulette round, and says why', async () => {
    const roundId = await addRound(db, gameId, 'ROULETTE');
    await activate(roundId);

    const planned = await planStep(client(), gameId, 'NEXT');
    expect(planned).toMatchObject({ kind: 'none' });
    expect((planned as any).reason).toMatch(/one scene/i);
    await expect(advanceScreen(client(), gameId, 'NEXT', 'admin', null)).rejects.toThrow(/one scene/i);
  });

  // ---------------------------------------------------------------------
  // Starting a round claims the big screen
  // ---------------------------------------------------------------------
  describe('what a round opens on', () => {
    it('opens a presentation on its first page in the run', async () => {
      const roundId = await addRound(db, gameId, 'PRESENTATIE');
      const hiddenFirst = await addPage(roundId, 0, 'Spare', true);
      const visible = await addPage(roundId, 1, 'Welkom');

      const target = await initialScreenTarget(client(), gameId, roundId, 'PRESENTATIE');

      expect(target).toEqual({ kind: 'slide', roundId, slideId: visible });
      expect(target).not.toEqual({ kind: 'slide', roundId, slideId: hiddenFirst });
    });

    it('opens a quiz on its first question', async () => {
      const roundId = await addRound(db, gameId, 'LIVE_QUIZ');
      const { rows } = await db.query(
        `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,points) VALUES($1,$2,0,'Q1',10) RETURNING id`,
        [gameId, roundId],
      );
      expect(await initialScreenTarget(client(), gameId, roundId, 'LIVE_QUIZ'))
        .toEqual({ kind: 'quizQuestion', roundId, questionId: Number(rows[0].id) });
    });

    it('opens each game round on its own scene', async () => {
      for (const type of ['ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE'] as const) {
        const roundId = await addRound(db, gameId, type);
        expect(await initialScreenTarget(client(), gameId, roundId, type), type)
          .toEqual({ kind: 'roundGame', roundId });
      }
    });

    // An empty round has nothing to show, and a blank scene on the wall is worse than the
    // dashboard that was already there.
    it('leaves the screen alone for a round with nothing in it', async () => {
      const roundId = await addRound(db, gameId, 'PRESENTATIE');
      expect(await initialScreenTarget(client(), gameId, roundId, 'PRESENTATIE')).toBeNull();
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
