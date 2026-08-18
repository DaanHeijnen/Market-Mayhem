-- Market Mayhem full game model. This migration intentionally builds on the
-- deployed v1-v4 history rather than rewriting it.

ALTER TABLE game_nights
  ADD COLUMN IF NOT EXISTS prediction_duration_seconds INTEGER NOT NULL DEFAULT 90 CHECK (prediction_duration_seconds BETWEEN 5 AND 86400),
  ADD COLUMN IF NOT EXISTS minimum_prediction_stake INTEGER NOT NULL DEFAULT 5 CHECK (minimum_prediction_stake > 0),
  ADD COLUMN IF NOT EXISTS maximum_prediction_stake INTEGER NOT NULL DEFAULT 500 CHECK (maximum_prediction_stake > 0),
  ADD COLUMN IF NOT EXISTS maximum_wallet_percentage INTEGER CHECK (maximum_wallet_percentage BETWEEN 1 AND 100);

ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_stake_range_check;
ALTER TABLE game_nights ADD CONSTRAINT game_nights_stake_range_check
  CHECK (maximum_prediction_stake >= minimum_prediction_stake);

CREATE TABLE IF NOT EXISTS round_blocks (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('TEXT','QUESTION','ROULETTE')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  title TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, sort_order)
);

ALTER TABLE game_nights ADD COLUMN IF NOT EXISTS current_round_block_id BIGINT;
ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_current_round_block_fk;
ALTER TABLE game_nights ADD CONSTRAINT game_nights_current_round_block_fk
  FOREIGN KEY (current_round_block_id) REFERENCES round_blocks(id) ON DELETE SET NULL;

-- Preserve useful legacy market data while replacing the obsolete crowd-vote
-- state machine. Existing BETTING markets become OPEN; voting/calculating
-- markets return to DRAFT because their derived odds are no longer authoritative.
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_status_check;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ;

UPDATE predictions
SET opened_at = COALESCE(opened_at, betting_opened_at),
    closes_at = COALESCE(
      closes_at,
      betting_closed_at,
      betting_opened_at + INTERVAL '90 seconds'
    );

UPDATE predictions SET status = CASE
  WHEN status = 'BETTING' THEN 'OPEN'
  WHEN status IN ('VOTING','CALCULATING') THEN 'DRAFT'
  ELSE status
END;

ALTER TABLE predictions ADD CONSTRAINT predictions_status_check
  CHECK (status IN ('DRAFT','SCHEDULED','OPEN','LOCKED','RESULT','SETTLED','CANCELLED'));

DROP INDEX IF EXISTS one_visible_prediction_per_game;
DROP INDEX IF EXISTS votes_by_prediction;
DROP TABLE IF EXISTS prediction_votes;

ALTER TABLE predictions
  DROP COLUMN IF EXISTS crowd_yes_probability,
  DROP COLUMN IF EXISTS crowd_no_probability,
  DROP COLUMN IF EXISTS voting_opened_at,
  DROP COLUMN IF EXISTS voting_closed_at,
  DROP COLUMN IF EXISTS betting_opened_at,
  DROP COLUMN IF EXISTS betting_closed_at,
  DROP COLUMN IF EXISTS visible_to_players;

UPDATE predictions SET yes_odds=LEAST(1000.000,GREATEST(1.001,COALESCE(yes_odds,2.000)));
UPDATE predictions SET no_odds=LEAST(1000.000,GREATEST(1.001,COALESCE(no_odds,2.000)));
ALTER TABLE predictions ALTER COLUMN yes_odds SET NOT NULL;
ALTER TABLE predictions ALTER COLUMN no_odds SET NOT NULL;
ALTER TABLE predictions ALTER COLUMN yes_odds SET DEFAULT 2.000;
ALTER TABLE predictions ALTER COLUMN no_odds SET DEFAULT 2.000;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_yes_odds_check;
ALTER TABLE predictions DROP CONSTRAINT IF EXISTS predictions_no_odds_check;
ALTER TABLE predictions ADD CONSTRAINT predictions_yes_odds_check CHECK (yes_odds >= 1.001 AND yes_odds <= 1000);
ALTER TABLE predictions ADD CONSTRAINT predictions_no_odds_check CHECK (no_odds >= 1.001 AND no_odds <= 1000);

CREATE TABLE IF NOT EXISTS roulette_games (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPEN','LOCKED','RESULT','SETTLED','CANCELLED')),
  result_number INTEGER CHECK (result_number BETWEEN 0 AND 36),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  spun_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roulette_bets (
  id BIGSERIAL PRIMARY KEY,
  roulette_game_id BIGINT NOT NULL REFERENCES roulette_games(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('NUMBER','COLOR','PARITY','RANGE')),
  selection TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake > 0),
  payout_multiplier NUMERIC(8,3) NOT NULL CHECK (payout_multiplier > 0),
  potential_return INTEGER NOT NULL CHECK (potential_return >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WON','LOST','REFUNDED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS roulette_game_id BIGINT REFERENCES roulette_games(id) ON DELETE SET NULL;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS roulette_bet_id BIGINT REFERENCES roulette_bets(id) ON DELETE SET NULL;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS public_visible BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_roulette_bet_action
  ON ledger_entries (roulette_bet_id, transaction_type)
  WHERE roulette_bet_id IS NOT NULL AND transaction_type IN ('ROULETTE_STAKE','ROULETTE_PAYOUT','ROULETTE_REFUND');

CREATE INDEX IF NOT EXISTS round_blocks_by_round_order ON round_blocks(round_id, sort_order);
CREATE INDEX IF NOT EXISTS predictions_by_round_status ON predictions(round_id, status);
CREATE INDEX IF NOT EXISTS open_predictions_by_deadline ON predictions(game_night_id, closes_at) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS roulette_games_by_game_status ON roulette_games(game_night_id, status);
CREATE INDEX IF NOT EXISTS roulette_bets_by_game ON roulette_bets(roulette_game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_by_game_round_date ON ledger_entries(game_night_id, attributed_round_id, created_at DESC);

-- At most one live roulette spin at a time per game.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_roulette_per_game
  ON roulette_games(game_night_id)
  WHERE status IN ('OPEN','LOCKED','RESULT');

-- Retire legacy broadcast compositions before tightening the check constraint.
UPDATE screen_state SET mode='DASHBOARD', prediction_id=NULL, payload='{}'::jsonb
WHERE mode IN ('PREDICTION_VOTING','CROWD_REVEAL','BETTING_OPEN');
UPDATE screen_state SET mode='PREDICTION_RESULT' WHERE mode='PREDICTION_RESULT';
UPDATE screen_state SET mode='DASHBOARD', round_id=NULL WHERE mode='ROUND_STARTED';
UPDATE game_nights SET current_screen_mode='DASHBOARD'
WHERE current_screen_mode IN ('ROUND_STARTED','PREDICTION_VOTING','CROWD_REVEAL','BETTING_OPEN');

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE'));

-- Legacy team/codeword/timer/avatar columns are intentionally left intact.
-- They are not used by the current product, but dropping unrelated historical
-- data during this migration would be unnecessarily destructive.
