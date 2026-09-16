-- 0019 — a roulette round holds many spins
--
-- A ROULETTE round used to be one table: `enterRound` created a single draft game and
-- once it settled there was nothing live left, so the round was functionally over after
-- one spin. The host wants to run the wheel several times in an evening without leaving
-- the round, so the row in `roulette_games` becomes a *run* within the round rather than
-- the round's only game.
--
-- Nothing is deleted or rewritten: every existing roulette game becomes run 1 of its
-- round, with its bets and its ledger entries exactly where they were.
ALTER TABLE roulette_games ADD COLUMN IF NOT EXISTS run_number INTEGER;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY round_id ORDER BY id) AS n
  FROM roulette_games WHERE round_id IS NOT NULL
)
UPDATE roulette_games g SET run_number = o.n FROM ordered o WHERE g.id = o.id AND g.run_number IS NULL;
UPDATE roulette_games SET run_number = 1 WHERE run_number IS NULL;

ALTER TABLE roulette_games ALTER COLUMN run_number SET NOT NULL;
ALTER TABLE roulette_games DROP CONSTRAINT IF EXISTS roulette_games_run_number_check;
ALTER TABLE roulette_games ADD CONSTRAINT roulette_games_run_number_check CHECK (run_number >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS roulette_run_number_per_round
  ON roulette_games (round_id, run_number) WHERE round_id IS NOT NULL;

-- At most one run of a round may be live at a time. This is what makes OPEN BETTING
-- AGAIN safe against a double click: the second insert collides rather than opening a
-- second table that players could split their chips across.
--
-- Created conditionally. A database that somehow already holds two live runs for one
-- round would fail the index, and a migration that aborts is worse than one that says
-- what it could not do — the endpoint's row lock still serialises the path either way.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM roulette_games
    WHERE round_id IS NOT NULL AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT')
    GROUP BY round_id HAVING COUNT(*) > 1
  ) THEN
    INSERT INTO migration_notes (migration, game_night_id, subject, note)
    VALUES ('0019', NULL, 'roulette_games',
      'Some round already has more than one live roulette run, so one_live_roulette_run_per_round was not created. ' ||
      'Settle or cancel the extra runs and create the index by hand to restore the invariant.');
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_roulette_run_per_round
      ON roulette_games (round_id)
      WHERE round_id IS NOT NULL AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The financial outcome of a run, frozen when it settles
-- ---------------------------------------------------------------------------
--
-- Derivable from the run's bets, and stored anyway. Two reasons. The projector reads this
-- on its hottest path and a public snapshot should not be running aggregates over a bet
-- table to draw a summary card. And a run's result is history the moment it settles:
-- a later refund, correction or deleted player must not silently change what the room was
-- told the spin paid out.
--
-- `total_payout` is gross — stake returned plus winnings, which is what the ledger moved.
-- The net figure is the subtraction and is deliberately not stored, so the two can never
-- disagree about which is which.
ALTER TABLE roulette_games ADD COLUMN IF NOT EXISTS total_staked INTEGER NOT NULL DEFAULT 0 CHECK (total_staked >= 0);
ALTER TABLE roulette_games ADD COLUMN IF NOT EXISTS total_payout INTEGER NOT NULL DEFAULT 0 CHECK (total_payout >= 0);
-- Unique players who placed at least one bet in the run. A player with five chips is one
-- participant, which is the number the host actually wants to see.
ALTER TABLE roulette_games ADD COLUMN IF NOT EXISTS participant_count INTEGER NOT NULL DEFAULT 0 CHECK (participant_count >= 0);

-- Backfill the runs that already finished, so their history reads the same as a run
-- settled from now on. Cancelled runs paid nothing and staked nothing that was kept.
UPDATE roulette_games g SET
  total_staked = COALESCE(b.staked, 0),
  total_payout = COALESCE(b.payout, 0),
  participant_count = COALESCE(b.participants, 0)
FROM (
  SELECT rb.roulette_game_id AS id,
         SUM(rb.stake) FILTER (WHERE rb.status IN ('WON','LOST'))::int AS staked,
         SUM(rb.potential_return) FILTER (WHERE rb.status = 'WON')::int AS payout,
         COUNT(DISTINCT rb.player_id) FILTER (WHERE rb.status IN ('WON','LOST'))::int AS participants
  FROM roulette_bets rb GROUP BY rb.roulette_game_id
) b
WHERE g.id = b.id AND g.status = 'SETTLED';

CREATE INDEX IF NOT EXISTS roulette_runs_by_round ON roulette_games (round_id, run_number DESC);

-- ---------------------------------------------------------------------------
-- The staged screen slot is retired
-- ---------------------------------------------------------------------------
--
-- Preview → Go Live is replaced by LIVE plus a preview of the next state, where pressing
-- NEXT puts that state on the projector immediately. There is no longer an intermediate
-- slot for something the host has chosen but not shown.
--
-- The columns are emptied rather than dropped. They cost nothing, dropping them is
-- irreversible, and a deploy that has to be rolled back should not take the old flow's
-- data with it. Nothing reads them after this migration.
UPDATE screen_state SET
  staged_mode = NULL, staged_round_id = NULL, staged_prediction_id = NULL,
  staged_quiz_question_id = NULL, staged_slide_id = NULL, staged_payload = '{}'::jsonb
WHERE staged_mode IS NOT NULL;

INSERT INTO migration_notes (migration, game_night_id, subject, note)
SELECT '0019', id, 'screen_state',
  'The staged screen slot was cleared: Preview -> Go Live is replaced by LIVE plus a next-state preview. ' ||
  'The staged_* columns are kept but unread.'
FROM game_nights;
