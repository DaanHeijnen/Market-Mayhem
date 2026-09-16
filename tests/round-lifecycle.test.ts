import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { assertRoundMayBeLeft, enterRound, leaveRound } from '../netlify/lib/round-lifecycle';
import { advanceRoundCursor, loadRoundRuntime } from '../netlify/lib/rounds';

const available = await pgliteAvailable();

/**
 * The acceptance criteria that only a real database can answer.
 *
 * These run the lifecycle code against a migrated Postgres, so what they assert is the
 * behaviour of the constraints as deployed — not of a stand-in for them.
 */
describe.skipIf(!available)('the round lifecycle, against a migrated database', () => {
  let db: TestDb;
  let gameId: number;

  beforeAll(async () => {
    db = await migratedDb();
    gameId = await seedGame(db);
  });
  afterAll(async () => { await db?.close(); });

  const client = () => db as any;

  // ---------------------------------------------------------------------
  // 1 · a round has exactly one type
  // ---------------------------------------------------------------------
  describe('a round has exactly one type', () => {
    it('refuses a type the model does not have', async () => {
      await expect(addRound(db, gameId, 'KAHOOT')).rejects.toThrow();
      await expect(addRound(db, gameId, 'TEXT')).rejects.toThrow();
    });

    // 7 · different content types can no longer coexist in one round
    it('refuses content that belongs to another round type', async () => {
      const roulette = await addRound(db, gameId, 'ROULETTE');
      await expect(db.query(
        'INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt) VALUES($1,$2,0,$3)',
        [gameId, roulette, 'nope'],
      )).rejects.toThrow(/LIVE_QUIZ content cannot be added to a ROULETTE round/);

      const quiz = await addRound(db, gameId, 'LIVE_QUIZ');
      await expect(db.query(
        'INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title) VALUES($1,$2,0,$3)',
        [gameId, quiz, 'nope'],
      )).rejects.toThrow(/PRESENTATIE content cannot be added to a LIVE_QUIZ round/);
    });
  });

  // ---------------------------------------------------------------------
  // 8 · at most one ACTIVE round per game night
  // ---------------------------------------------------------------------
  it('allows only one active round per game night', async () => {
    const first = await addRound(db, gameId, 'PRESENTATIE', { status: 'ACTIVE' });
    const second = await addRound(db, gameId, 'PRESENTATIE');
    await expect(db.query("UPDATE rounds SET status='ACTIVE' WHERE id=$1", [second])).rejects.toThrow();
    await db.query("UPDATE rounds SET status='COMPLETED' WHERE id=$1", [first]);
    // Once the first is finished the second may start — the invariant is "one at a
    // time", not "one ever".
    await db.query("UPDATE rounds SET status='ACTIVE' WHERE id=$1", [second]);
    await db.query("UPDATE rounds SET status='COMPLETED' WHERE id=$1", [second]);
  });

  // ---------------------------------------------------------------------
  // 14 · type-specific exit semantics
  // ---------------------------------------------------------------------
  describe('leaving a round runs that round type’s own policy', () => {
    it('refuses to leave a quiz round with an unsettled question', async () => {
      const round = await addRound(db, gameId, 'LIVE_QUIZ');
      const { rows } = await db.query(
        'INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,points) VALUES($1,$2,0,$3,10) RETURNING id',
        [gameId, round, 'Open question'],
      );
      await db.query(
        "INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id,status) VALUES($1,$2,$3,'OPEN')",
        [Number(rows[0].id), gameId, round],
      );
      await expect(assertRoundMayBeLeft(client(), gameId, round, 'LIVE_QUIZ')).rejects.toThrow(/still OPEN/);

      // Settled, it lets go.
      await db.query("UPDATE live_quiz_question_state SET status='SETTLED' WHERE question_id=$1", [Number(rows[0].id)]);
      await expect(assertRoundMayBeLeft(client(), gameId, round, 'LIVE_QUIZ')).resolves.toBeUndefined();
    });

    it('refuses to leave a roulette round with money on the table, and cancels a draft', async () => {
      const round = await addRound(db, gameId, 'ROULETTE');
      await db.query("INSERT INTO roulette_games(game_night_id,round_id,status) VALUES($1,$2,'OPEN')", [gameId, round]);
      await expect(assertRoundMayBeLeft(client(), gameId, round, 'ROULETTE')).rejects.toThrow(/still OPEN/);

      await db.query("UPDATE roulette_games SET status='SETTLED' WHERE round_id=$1", [round]);
      await db.query("INSERT INTO roulette_games(game_night_id,round_id,status) VALUES($1,$2,'DRAFT')", [gameId, round]);
      await assertRoundMayBeLeft(client(), gameId, round, 'ROULETTE');
      const outcome = await leaveRound(client(), gameId, round, 'ROULETTE', 'admin', 'round completed');
      expect(outcome.rouletteDraftsCancelled).toBe(1);
    });

    // A Fotoronde is closed, never cancelled: its photos and the credits owed for them
    // are the point of the round.
    it('closes a Fotoronde and keeps its photos', async () => {
      const round = await addRound(db, gameId, 'FOTORONDE');
      await db.query(
        "INSERT INTO fotoronde_subjects(game_night_id,round_id,sort_order,subject_key,label,points) VALUES($1,$2,0,'moois','Iets moois',15)",
        [gameId, round],
      );
      const photoRound = await db.query(
        "INSERT INTO photo_rounds(game_night_id,round_id,status) VALUES($1,$2,'OPEN') RETURNING id",
        [gameId, round],
      );
      const group = await db.query(
        'INSERT INTO round_groups(game_night_id,round_id,name) VALUES($1,$2,$3) RETURNING id',
        [gameId, round, `Team ${round}`],
      );
      await db.query(
        `INSERT INTO photo_submissions(photo_round_id,game_night_id,round_id,subject_key,group_id,uploaded_by,media_key)
         VALUES($1,$2,$3,'moois',$4,501,'photo-1')`,
        [Number(photoRound.rows[0].id), gameId, round, Number(group.rows[0].id)],
      );

      const outcome = await leaveRound(client(), gameId, round, 'FOTORONDE', 'admin', 'round completed');
      expect(outcome.photoRoundsClosed).toBe(1);

      const after = await db.query('SELECT status FROM photo_rounds WHERE round_id=$1', [round]);
      expect(after.rows[0].status).toBe('CLOSED');
      const kept = await db.query('SELECT COUNT(*)::int c FROM photo_submissions WHERE round_id=$1', [round]);
      expect(kept.rows[0].c).toBe(1);
    });

    it('cancels a Pak een Zes but keeps its draws', async () => {
      const round = await addRound(db, gameId, 'PAK_EEN_ZES', { defaultPoints: 25 });
      const game = await db.query(
        "INSERT INTO pak_een_zes_games(game_night_id,round_id,status) VALUES($1,$2,'DRAWING') RETURNING id",
        [gameId, round],
      );
      await db.query(
        `INSERT INTO pak_een_zes_draws(pak_een_zes_game_id,game_night_id,round_id,player_id,draw_number,rank,suit,is_six,idempotency_key)
         VALUES($1,$2,$3,501,1,'6','HEARTS',TRUE,$4)`,
        [Number(game.rows[0].id), gameId, round, `draw-${round}`],
      );

      const outcome = await leaveRound(client(), gameId, round, 'PAK_EEN_ZES', 'admin', 'round completed');
      expect(outcome.pakEenZesCancelled).toBe(1);
      expect((await db.query('SELECT status FROM pak_een_zes_games WHERE round_id=$1', [round])).rows[0].status).toBe('CANCELLED');
      // Cancelling must never erase the record of what happened.
      expect((await db.query('SELECT COUNT(*)::int c FROM pak_een_zes_draws WHERE round_id=$1', [round])).rows[0].c).toBe(1);
    });

    // A slot series is per player: blocking would let one player who wandered off hold
    // the evening hostage, so the round closes and refunds instead.
    it('refunds unspun slot spins rather than blocking, exactly once', async () => {
      const round = await addRound(db, gameId, 'SLOTMACHINE');
      const series = await db.query(
        `INSERT INTO slot_series(game_night_id,round_id,player_id,stake_per_spin,total_spins,spins_remaining,total_stake,status,idempotency_key)
         VALUES($1,$2,501,10,5,3,50,'ACTIVE',$3) RETURNING id`,
        [gameId, round, `series-${round}`],
      );
      const before = await db.query('SELECT current_balance FROM wallets WHERE player_id=501');

      const first = await leaveRound(client(), gameId, round, 'SLOTMACHINE', 'admin', 'round completed');
      expect(first.slotSeriesClosed).toBe(1);
      expect(first.slotCoinsRefunded).toBe(30); // 3 unspun × 10

      const after = await db.query('SELECT current_balance FROM wallets WHERE player_id=501');
      expect(Number(after.rows[0].current_balance)).toBe(Number(before.rows[0].current_balance) + 30);

      // Called twice — a retry, a double-clicked COMPLETE — it pays nothing more.
      const second = await leaveRound(client(), gameId, round, 'SLOTMACHINE', 'admin', 'round completed');
      expect(second.slotCoinsRefunded).toBe(0);
      const finalBalance = await db.query('SELECT current_balance FROM wallets WHERE player_id=501');
      expect(Number(finalBalance.rows[0].current_balance)).toBe(Number(after.rows[0].current_balance));
      expect((await db.query(
        "SELECT COUNT(*)::int c FROM ledger_entries WHERE slot_series_id=$1 AND transaction_type='SLOT_REFUND'",
        [Number(series.rows[0].id)],
      )).rows[0].c).toBe(1);
    });

    it('has nothing to settle on a presentation round', async () => {
      const round = await addRound(db, gameId, 'PRESENTATIE');
      const outcome = await leaveRound(client(), gameId, round, 'PRESENTATIE', 'admin', 'round completed');
      expect(outcome).toMatchObject({
        slotSeriesClosed: 0, slotCoinsRefunded: 0, pakEenZesCancelled: 0,
        photoRoundsClosed: 0, rouletteDraftsCancelled: 0,
      });
    });
  });

  // ---------------------------------------------------------------------
  // 9 / 10 · starting a round changes progression, never presentation
  // ---------------------------------------------------------------------
  describe('starting a round leaves the projector alone', () => {
    it('sets the round cursor and writes nothing to screen_state', async () => {
      const round = await addRound(db, gameId, 'LIVE_QUIZ');
      const q = await db.query(
        'INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,points) VALUES($1,$2,0,$3,10) RETURNING id',
        [gameId, round, 'First question'],
      );
      await db.query('INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)', [Number(q.rows[0].id), gameId, round]);

      const screenBefore = await db.query('SELECT mode,round_id,quiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId]);
      await enterRound(client(), gameId, round, 'LIVE_QUIZ');
      const screenAfter = await db.query('SELECT mode,round_id,quiz_question_id FROM screen_state WHERE game_night_id=$1', [gameId]);

      expect(screenAfter.rows[0]).toEqual(screenBefore.rows[0]);
      const runtime = await loadRoundRuntime(client(), round);
      expect(runtime.currentQuizQuestionId).toBe(Number(q.rows[0].id));
    });

    it('creates exactly one draft table for a roulette round, however often it is entered', async () => {
      const round = await addRound(db, gameId, 'ROULETTE');
      await enterRound(client(), gameId, round, 'ROULETTE');
      await enterRound(client(), gameId, round, 'ROULETTE');
      const games = await db.query('SELECT COUNT(*)::int c FROM roulette_games WHERE round_id=$1', [round]);
      expect(games.rows[0].c).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // 15 · a stale admin command cannot overwrite a newer state
  // ---------------------------------------------------------------------
  describe('concurrent and stale admin commands', () => {
    it('refuses a navigation based on a revision that has moved on', async () => {
      const round = await addRound(db, gameId, 'PRESENTATIE');
      const a = await db.query(
        'INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title) VALUES($1,$2,0,$3) RETURNING id',
        [gameId, round, 'Slide one'],
      );
      const b = await db.query(
        'INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title) VALUES($1,$2,1,$3) RETURNING id',
        [gameId, round, 'Slide two'],
      );

      const start = await loadRoundRuntime(client(), round);
      // Two admin tabs read the same revision. The first advances; the second is stale.
      const moved = await advanceRoundCursor(client(), round, start.revision, { slideId: Number(b.rows[0].id) });
      expect(moved.currentSlideId).toBe(Number(b.rows[0].id));

      await expect(
        advanceRoundCursor(client(), round, start.revision, { slideId: Number(a.rows[0].id) }),
      ).rejects.toThrow(/moved on/);

      // The newer state stands: the stale command changed nothing.
      const after = await loadRoundRuntime(client(), round);
      expect(after.currentSlideId).toBe(Number(b.rows[0].id));
      expect(after.revision).toBe(moved.revision);
    });
  });

  // ---------------------------------------------------------------------
  // 12 · rewards are idempotent, through the ledger
  // ---------------------------------------------------------------------
  describe('rewards move only through the ledger, and only once', () => {
    it('refuses a second reward for the same question and player', async () => {
      const round = await addRound(db, gameId, 'LIVE_QUIZ');
      const q = await db.query(
        'INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,points) VALUES($1,$2,0,$3,40) RETURNING id',
        [gameId, round, 'Paid question'],
      );
      const questionId = Number(q.rows[0].id);
      const insert = () => db.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,quiz_question_id,created_by)
         VALUES($1,501,40,'QUESTION_REWARD','Quiz reward',$2,$3,'admin')`,
        [gameId, round, questionId],
      );
      await insert();
      await expect(insert()).rejects.toThrow();

      const paid = await db.query(
        "SELECT COUNT(*)::int c FROM ledger_entries WHERE quiz_question_id=$1 AND transaction_type='QUESTION_REWARD'",
        [questionId],
      );
      expect(paid.rows[0].c).toBe(1);
    });

    // No second currency, and no balance column anywhere but the wallet.
    it('keeps points as an authored number and coins as ledger rows', async () => {
      const columns = await db.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema='public' AND column_name IN ('balance','coins','points_balance')`,
      );
      expect(columns.rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // 16 · the block architecture is gone
  // ---------------------------------------------------------------------
  describe('the old block architecture', () => {
    it('has no round_blocks table and no block pointer', async () => {
      const table = await db.query("SELECT COUNT(*)::int c FROM information_schema.tables WHERE table_name='round_blocks'");
      expect(table.rows[0].c).toBe(0);
      const column = await db.query(
        "SELECT COUNT(*)::int c FROM information_schema.columns WHERE table_name='game_nights' AND column_name='current_round_block_id'",
      );
      expect(column.rows[0].c).toBe(0);
    });

    it('leaves no round_block_id behind on any table', async () => {
      const columns = await db.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='round_block_id'",
      );
      expect(columns.rows.map((r: any) => r.table_name)).toEqual([]);
    });

    // Removing the model must not have removed the record of what was in it.
    it('keeps every pre-migration block in the archive', async () => {
      const archive = await db.query("SELECT COUNT(*)::int c FROM information_schema.tables WHERE table_name='round_blocks_archive'");
      expect(archive.rows[0].c).toBe(1);
    });
  });
});
