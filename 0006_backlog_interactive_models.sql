-- Backlog batch: prediction-specific controls, round groups, interactive live
-- questions, roulette spin state, and richer ledger attribution. This migration
-- builds on deployed migrations 0001-0005 and intentionally leaves legacy
-- columns in place when dropping them would risk historical data.


ALTER TABLE players ADD COLUMN IF NOT EXISTS starting_balance_snapshot INTEGER;
UPDATE players p
SET starting_balance_snapshot = COALESCE(
  starting_balance_snapshot,
  (SELECT SUM(l.amount)::int FROM ledger_entries l WHERE l.player_id=p.id AND l.transaction_type='STARTING_BALANCE'),
  (SELECT (w.current_balance - COALESCE(SUM(l.amount),0))::int
   FROM wallets w
   LEFT JOIN ledger_entries l ON l.player_id=w.player_id
   WHERE w.player_id=p.id
   GROUP BY w.current_balance),
  g.starting_balance
)
FROM game_nights g
WHERE g.id=p.game_night_id;
ALTER TABLE players ALTER COLUMN starting_balance_snapshot SET NOT NULL;
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_starting_balance_snapshot_check;
ALTER TABLE players ADD CONSTRAINT players_starting_balance_snapshot_check CHECK (starting_balance_snapshot >= 0);

ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS probability_yes NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS prediction_time_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS minimum_stake INTEGER,
  ADD COLUMN IF NOT EXISTS maximum_stake INTEGER;

UPDATE predictions p
SET probability_yes = COALESCE(
      probability_yes,
      CASE
        WHEN yes_odds IS NOT NULL AND yes_odds > 0 THEN LEAST(0.99, GREATEST(0.01, 1 / yes_odds))
        ELSE 0.50
      END
    ),
    prediction_time_seconds = COALESCE(prediction_time_seconds, g.prediction_duration_seconds, 90),
    minimum_stake = COALESCE(minimum_stake, g.minimum_prediction_stake, 5),
    maximum_stake = COALESCE(maximum_stake, g.maximum_prediction_stake, 500)
FROM game_nights g
WHERE g.id = p.game_night_id;

ALTER TABLE predictions
  ALTER COLUMN probability_yes SET DEFAULT 0.50,
  ALTER COLUMN probability_yes SET NOT NULL,
  ALTER COLUMN prediction_time_seconds SET DEFAULT 90,
  ALTER COLUMN prediction_time_seconds SET NOT NULL,
  ALTER COLUMN minimum_stake SET DEFAULT 5,
  ALTER COLUMN minimum_stake SET NOT NULL,
  ALTER COLUMN maximum_stake SET DEFAULT 500,
  ALTER COLUMN maximum_stake SET NOT NULL;

ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_probability_yes_check;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_prediction_time_seconds_check;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_minimum_stake_check;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_maximum_stake_check;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_stake_range_check;
ALTER TABLE predictions ADD CONSTRAINT predictions_probability_yes_check CHECK (probability_yes BETWEEN 0.01 AND 0.99);
ALTER TABLE predictions ADD CONSTRAINT predictions_prediction_time_seconds_check CHECK (prediction_time_seconds BETWEEN 5 AND 86400);
ALTER TABLE predictions ADD CONSTRAINT predictions_minimum_stake_check CHECK (minimum_stake > 0);
ALTER TABLE predictions ADD CONSTRAINT predictions_maximum_stake_check CHECK (maximum_stake > 0);
ALTER TABLE predictions ADD CONSTRAINT predictions_stake_range_check CHECK (maximum_stake >= minimum_stake);

-- Keep the old game-level prediction timing/stake columns for upgrade safety,
-- but production code no longer uses them after this migration.

ALTER TABLE round_blocks DROP CONSTRAINT IF EXISTS round_blocks_type_check;
ALTER TABLE round_blocks ADD CONSTRAINT round_blocks_type_check
  CHECK (type IN ('TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION'));
ALTER TABLE round_blocks
  ADD COLUMN IF NOT EXISTS interactive_status TEXT,
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revealed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE round_blocks DROP CONSTRAINT IF EXISTS round_blocks_interactive_status_check;
ALTER TABLE round_blocks ADD CONSTRAINT round_blocks_interactive_status_check
  CHECK (interactive_status IS NULL OR interactive_status IN ('READY','OPEN','CLOSED','REVEALED','SETTLED'));
UPDATE round_blocks SET interactive_status='READY' WHERE type='DUOLINGO_QUESTION' AND interactive_status IS NULL;

CREATE TABLE IF NOT EXISTS round_groups (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(round_id, name)
);

CREATE TABLE IF NOT EXISTS round_group_members (
  group_id BIGINT NOT NULL REFERENCES round_groups(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(group_id, player_id),
  UNIQUE(round_id, player_id)
);

CREATE TABLE IF NOT EXISTS round_question_answers (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  round_block_id BIGINT NOT NULL REFERENCES round_blocks(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  selected_answer INTEGER NOT NULL CHECK (selected_answer BETWEEN 0 AND 3),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(round_block_id, player_id)
);

ALTER TABLE roulette_games DROP CONSTRAINT IF EXISTS roulette_games_status_check;
ALTER TABLE roulette_games ADD CONSTRAINT roulette_games_status_check
  CHECK (status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT','SETTLED','CANCELLED'));

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS round_group_id BIGINT REFERENCES round_groups(id) ON DELETE SET NULL;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_question_reward
  ON ledger_entries(round_block_id, player_id, transaction_type)
  WHERE round_block_id IS NOT NULL AND transaction_type='QUESTION_REWARD';
CREATE INDEX IF NOT EXISTS round_groups_by_round ON round_groups(round_id, id);
CREATE INDEX IF NOT EXISTS round_group_members_by_player ON round_group_members(player_id, group_id);
CREATE INDEX IF NOT EXISTS round_question_answers_by_block ON round_question_answers(round_block_id, submitted_at, id);
CREATE INDEX IF NOT EXISTS roulette_spinning_by_time ON roulette_games(game_night_id, spun_at) WHERE status='SPINNING';
CREATE INDEX IF NOT EXISTS predictions_open_by_game_deadline_v2 ON predictions(game_night_id, closes_at) WHERE status='OPEN';

CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_prediction_deposit
  ON ledger_entries(bet_id, transaction_type)
  WHERE bet_id IS NOT NULL AND transaction_type='PREDICTION_DEPOSIT';

DROP INDEX IF EXISTS one_live_roulette_per_game;
CREATE UNIQUE INDEX one_live_roulette_per_game
  ON roulette_games(game_night_id)
  WHERE status IN ('OPEN','LOCKED','SPINNING','RESULT');
