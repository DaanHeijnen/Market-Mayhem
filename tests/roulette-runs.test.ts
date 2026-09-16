import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, pgliteAvailable, seedGame, addRound, type TestDb } from './helpers/pglite';
import { settleRouletteRun, openNextRouletteRun } from '../netlify/lib/roulette';
import { isRouletteChip, ROULETTE_CHIPS } from '../netlify/lib/economy';
import { ROULETTE_CHIPS as PHONE_CHIPS } from '../src/components/mobile/MobileViews';

const available = await pgliteAvailable();

describe('the chips a bet can be', () => {
  it('accepts the fixed amounts and nothing else', () => {
    for (const chip of ROULETTE_CHIPS) expect(isRouletteChip(chip), String(chip)).toBe(true);
    // The values a free-text field used to allow.
    expect(isRouletteChip(3)).toBe(false);
    expect(isRouletteChip(100)).toBe(false);
    expect(isRouletteChip(0)).toBe(false);
    expect(isRouletteChip(-5)).toBe(false);
    expect(isRouletteChip(5.5)).toBe(false);
    expect(isRouletteChip('5')).toBe(false);
    expect(isRouletteChip(null)).toBe(false);
  });

  // The phone mirrors the list because src and netlify are separate TypeScript projects.
  // The server is authoritative either way, but a phone offering a chip the server would
  // refuse is a bet that bounces for no reason the player can see.
  it('is the same list the phone offers', () => {
    expect([...PHONE_CHIPS]).toEqual([...ROULETTE_CHIPS]);
  });
});

describe.skipIf(!available)('roulette runs, against a migrated database', () => {
  let db: TestDb;
  let gameId: number;
  let roundId: number;
  const client = () => db as any;

  const RED = 1; // a red, odd, low number — so colour/parity/range bets on it all win

  /** One player's chip on the table, with the stake already taken from their wallet. */
  const placeBet = async (runId: number, playerId: number, betType: string, selection: string, stake: number) => {
    const multiplier = betType === 'NUMBER' ? 36 : 2;
    const { rows } = await db.query(
      `INSERT INTO roulette_bets(roulette_game_id,player_id,bet_type,selection,stake,payout_multiplier,potential_return,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [runId, playerId, betType, selection, stake, multiplier, stake * multiplier, `k-${runId}-${playerId}-${betType}-${selection}-${stake}`],
    );
    const betId = Number(rows[0].id);
    await db.query('UPDATE wallets SET current_balance=current_balance-$1 WHERE player_id=$2', [stake, playerId]);
    await db.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,roulette_game_id,roulette_bet_id,created_by,idempotency_key)
       VALUES($1,$2,$3,'ROULETTE_STAKE','stake',$4,$5,'player',$6)`,
      [gameId, playerId, -stake, runId, betId, `stake-${betId}`],
    );
    return betId;
  };

  const newRun = async (runNumber: number, status = 'OPEN') => {
    const { rows } = await db.query(
      `INSERT INTO roulette_games(game_night_id,round_id,status,run_number) VALUES($1,$2,$3,$4) RETURNING id`,
      [gameId, roundId, status, runNumber],
    );
    return Number(rows[0].id);
  };

  const balance = async (playerId: number) =>
    Number((await db.query('SELECT current_balance::int AS b FROM wallets WHERE player_id=$1', [playerId])).rows[0].b);

  const ledgerSum = async (playerId: number) =>
    Number((await db.query('SELECT COALESCE(SUM(amount),0)::int AS s FROM ledger_entries WHERE player_id=$1', [playerId])).rows[0].s);

  beforeAll(async () => { db = await migratedDb(); gameId = await seedGame(db, 800); });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    // One live roulette table per game night is a partial unique index that predates
    // runs, so the previous test's table stands down before this one starts.
    await db.query(
      `UPDATE roulette_games SET status='CANCELLED' WHERE game_night_id=$1 AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT')`,
      [gameId],
    );
    await db.query(`UPDATE rounds SET status='COMPLETED' WHERE game_night_id=$1 AND status='ACTIVE'`, [gameId]);
    roundId = await addRound(db, gameId, 'ROULETTE');
    await db.query(`UPDATE rounds SET status='ACTIVE',started_at=NOW() WHERE id=$1`, [roundId]);
    await db.query('UPDATE wallets SET current_balance=1000 WHERE game_night_id=$1', [gameId]);
    await db.query('DELETE FROM ledger_entries WHERE game_night_id=$1', [gameId]);
  });

  // ---------------------------------------------------------------------
  // Settlement happens where the result becomes final
  // ---------------------------------------------------------------------
  describe('settlement', () => {
    it('pays the winners and takes nothing more from the losers', async () => {
      const run = await newRun(1, 'SPINNING');
      await placeBet(run, 501, 'COLOR', 'RED', 25);   // wins at 2x → 50 back
      await placeBet(run, 502, 'COLOR', 'BLACK', 10); // loses
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [run, RED]);

      const summary = await settleRouletteRun(client(), gameId, run, 'timer');

      expect(summary.betsSettled).toBe(2);
      expect(await balance(501)).toBe(1000 - 25 + 50);
      expect(await balance(502)).toBe(1000 - 10);
      // The financial invariant, per player: the wallet is what the ledger adds up to.
      expect(await ledgerSum(501)).toBe(25);
      expect(await ledgerSum(502)).toBe(-10);
    });

    it('closes the run and freezes what it cost the room', async () => {
      const run = await newRun(1, 'SPINNING');
      await placeBet(run, 501, 'COLOR', 'RED', 25);
      await placeBet(run, 502, 'COLOR', 'BLACK', 10);
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [run, RED]);

      const summary = await settleRouletteRun(client(), gameId, run, 'timer');

      expect(summary.totalStaked).toBe(35);
      // Gross: the 25 stake comes back inside the 50.
      expect(summary.totalPayout).toBe(50);
      expect(summary.totalPayout - summary.totalStaked).toBe(15);

      const { rows } = await db.query('SELECT status,total_staked,total_payout,participant_count FROM roulette_games WHERE id=$1', [run]);
      expect(rows[0].status).toBe('SETTLED');
      expect(Number(rows[0].total_staked)).toBe(35);
      expect(Number(rows[0].total_payout)).toBe(50);
      expect(Number(rows[0].participant_count)).toBe(2);
    });

    // The guarantee that makes settling on a timer safe: two pollers arriving together,
    // or a retry, must not pay anyone twice.
    it('pays once however many times it runs', async () => {
      const run = await newRun(1, 'SPINNING');
      await placeBet(run, 501, 'NUMBER', String(RED), 5); // wins at 36x → 180
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [run, RED]);

      const first = await settleRouletteRun(client(), gameId, run, 'timer');
      const second = await settleRouletteRun(client(), gameId, run, 'timer');
      const third = await settleRouletteRun(client(), gameId, run, 'timer');

      expect(first.betsSettled).toBe(1);
      expect(second.betsSettled).toBe(0);
      expect(third.betsSettled).toBe(0);
      expect(await balance(501)).toBe(1000 - 5 + 180);

      const payouts = await db.query(
        "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE roulette_game_id=$1 AND transaction_type='ROULETTE_PAYOUT'",
        [run],
      );
      expect(payouts.rows[0].n).toBe(1);
      // And the frozen totals do not drift on a replay.
      expect(second.totalStaked).toBe(first.totalStaked);
      expect(second.totalPayout).toBe(first.totalPayout);
    });

    // Five chips is one participant. This is the number the Admin reads to decide whether
    // the room is in, so it counts people rather than bets.
    it('counts players, not chips', async () => {
      const run = await newRun(1, 'SPINNING');
      for (const stake of ROULETTE_CHIPS) await placeBet(run, 501, 'COLOR', 'RED', stake);
      await placeBet(run, 502, 'COLOR', 'BLACK', 5);
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [run, RED]);

      const summary = await settleRouletteRun(client(), gameId, run, 'timer');

      expect(summary.participantCount).toBe(2);
      expect(summary.totalStaked).toBe(ROULETTE_CHIPS.reduce((a, b) => a + b, 0) + 5);
    });

    it('leaves a refunded chip out of both totals', async () => {
      const run = await newRun(1, 'SPINNING');
      const refunded = await placeBet(run, 502, 'COLOR', 'RED', 25);
      await db.query("UPDATE roulette_bets SET status='REFUNDED' WHERE id=$1", [refunded]);
      await placeBet(run, 501, 'COLOR', 'RED', 10);
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [run, RED]);

      const summary = await settleRouletteRun(client(), gameId, run, 'timer');

      expect(summary.totalStaked).toBe(10);
      expect(summary.participantCount).toBe(1);
    });

    it('refuses a run with no result to settle', async () => {
      const run = await newRun(1, 'LOCKED');
      await expect(settleRouletteRun(client(), gameId, run, 'timer')).rejects.toThrow(/no result/i);
    });
  });

  // ---------------------------------------------------------------------
  // Many runs in one round
  // ---------------------------------------------------------------------
  describe('opening betting again', () => {
    it('adds a run to the same round rather than a round', async () => {
      const first = await newRun(1, 'SPINNING');
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [first, RED]);
      await settleRouletteRun(client(), gameId, first, 'timer');

      const next = await openNextRouletteRun(client(), gameId, roundId);

      expect(next.runNumber).toBe(2);
      const rounds = await db.query('SELECT COUNT(*)::int AS n FROM rounds WHERE game_night_id=$1', [gameId]);
      const runs = await db.query('SELECT COUNT(*)::int AS n FROM roulette_games WHERE round_id=$1', [roundId]);
      expect(runs.rows[0].n).toBe(2);
      // The round is untouched, and still ACTIVE.
      const round = await db.query('SELECT status FROM rounds WHERE id=$1', [roundId]);
      expect(round.rows[0].status).toBe('ACTIVE');
      expect(rounds.rows[0].n).toBeGreaterThan(0);
    });

    it('never lets a bet from one run reach the next', async () => {
      const first = await newRun(1, 'SPINNING');
      await placeBet(first, 501, 'COLOR', 'RED', 25);
      await db.query('UPDATE roulette_games SET result_number=$2 WHERE id=$1', [first, RED]);
      await settleRouletteRun(client(), gameId, first, 'timer');

      const next = await openNextRouletteRun(client(), gameId, roundId);
      await placeBet(next.rouletteGameId, 502, 'COLOR', 'BLACK', 10);
      // Run 2 lands on black this time, so run 1's red bet would have lost here.
      await db.query("UPDATE roulette_games SET status='SPINNING',result_number=2 WHERE id=$1", [next.rouletteGameId]);

      const second = await settleRouletteRun(client(), gameId, next.rouletteGameId, 'timer');

      expect(second.totalStaked).toBe(10);
      expect(second.participantCount).toBe(1);
      // Run 1 kept its own history, settled on its own number.
      const runOne = await db.query('SELECT total_staked,total_payout,result_number FROM roulette_games WHERE id=$1', [first]);
      expect(Number(runOne.rows[0].total_staked)).toBe(25);
      expect(Number(runOne.rows[0].total_payout)).toBe(50);
      expect(Number(runOne.rows[0].result_number)).toBe(RED);
    });

    it('refuses to open a second table beside one that is still live', async () => {
      await newRun(1, 'OPEN');
      await expect(openNextRouletteRun(client(), gameId, roundId)).rejects.toThrow(/still OPEN/);
    });

    // The database says so too, not only the check above — which is what makes a double
    // click safe rather than merely unlikely.
    it('cannot hold two live runs for one round', async () => {
      await newRun(1, 'OPEN');
      await expect(newRun(2, 'OPEN')).rejects.toThrow();
    });

    it('keeps run numbers unique within the round', async () => {
      await newRun(1, 'SETTLED');
      await expect(newRun(1, 'SETTLED')).rejects.toThrow();
    });

    it('runs as many times as the host wants', async () => {
      for (let expected = 1; expected <= 5; expected += 1) {
        const run = await openNextRouletteRun(client(), gameId, roundId);
        expect(run.runNumber).toBe(expected);
        await db.query("UPDATE roulette_games SET status='SPINNING',result_number=$2 WHERE id=$1", [run.rouletteGameId, RED]);
        await settleRouletteRun(client(), gameId, run.rouletteGameId, 'timer');
      }
      const round = await db.query('SELECT status FROM rounds WHERE id=$1', [roundId]);
      expect(round.rows[0].status).toBe('ACTIVE');
    });
  });
});
