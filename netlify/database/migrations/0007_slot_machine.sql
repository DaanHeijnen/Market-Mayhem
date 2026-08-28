-- Slot machine: admin-configured reel artwork, weighted outcome distribution,
-- payout multipliers and player spin series. Builds on migrations 0001-0006.
-- Reels are fixed at 3 x 12 symbols, so the outcome space is exactly 1728
-- combinations. Outcome rows are stored sparsely: only combinations that carry
-- a weight or a payout exist, and the weighted randomizer walks that set.

CREATE TABLE IF NOT EXISTS slot_settings (
  game_night_id BIGINT PRIMARY KEY REFERENCES game_nights(id) ON DELETE CASCADE,
  total_probability_pool INTEGER NOT NULL DEFAULT 100,
  maximum_spins INTEGER NOT NULL DEFAULT 20,
  minimum_stake INTEGER NOT NULL DEFAULT 1,
  maximum_stake INTEGER NOT NULL DEFAULT 500,
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE slot_settings DROP CONSTRAINT IF EXISTS slot_settings_pool_check;
ALTER TABLE slot_settings DROP CONSTRAINT IF EXISTS slot_settings_maximum_spins_check;
ALTER TABLE slot_settings DROP CONSTRAINT IF EXISTS slot_settings_minimum_stake_check;
ALTER TABLE slot_settings DROP CONSTRAINT IF EXISTS slot_settings_maximum_stake_check;
ALTER TABLE slot_settings DROP CONSTRAINT IF EXISTS slot_settings_stake_range_check;
ALTER TABLE slot_settings ADD CONSTRAINT slot_settings_pool_check CHECK (total_probability_pool BETWEEN 1 AND 1000000);
ALTER TABLE slot_settings ADD CONSTRAINT slot_settings_maximum_spins_check CHECK (maximum_spins BETWEEN 1 AND 500);
ALTER TABLE slot_settings ADD CONSTRAINT slot_settings_minimum_stake_check CHECK (minimum_stake > 0);
ALTER TABLE slot_settings ADD CONSTRAINT slot_settings_maximum_stake_check CHECK (maximum_stake > 0);
ALTER TABLE slot_settings ADD CONSTRAINT slot_settings_stake_range_check CHECK (maximum_stake >= minimum_stake);

-- Reel artwork lives in the database because Netlify Functions have no durable
-- writable filesystem. Bytes are served by a dedicated endpoint so that the
-- polled state snapshots stay small.
CREATE TABLE IF NOT EXISTS slot_symbols (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  reel SMALLINT NOT NULL,
  symbol_position SMALLINT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  byte_size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  image_data BYTEA NOT NULL,
  original_filename TEXT,
  updated_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE slot_symbols DROP CONSTRAINT IF EXISTS slot_symbols_reel_check;
ALTER TABLE slot_symbols DROP CONSTRAINT IF EXISTS slot_symbols_position_check;
ALTER TABLE slot_symbols DROP CONSTRAINT IF EXISTS slot_symbols_content_type_check;
ALTER TABLE slot_symbols DROP CONSTRAINT IF EXISTS slot_symbols_byte_size_check;
ALTER TABLE slot_symbols ADD CONSTRAINT slot_symbols_reel_check CHECK (reel BETWEEN 1 AND 3);
ALTER TABLE slot_symbols ADD CONSTRAINT slot_symbols_position_check CHECK (symbol_position BETWEEN 1 AND 12);
ALTER TABLE slot_symbols ADD CONSTRAINT slot_symbols_content_type_check CHECK (content_type = 'image/png');
ALTER TABLE slot_symbols ADD CONSTRAINT slot_symbols_byte_size_check CHECK (byte_size > 0 AND byte_size <= 1048576);

CREATE UNIQUE INDEX IF NOT EXISTS slot_symbols_unique_slot
  ON slot_symbols (game_night_id, reel, symbol_position);

CREATE TABLE IF NOT EXISTS slot_outcomes (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  reel1_position SMALLINT NOT NULL,
  reel2_position SMALLINT NOT NULL,
  reel3_position SMALLINT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  payout_multiplier NUMERIC(8,2) NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE slot_outcomes DROP CONSTRAINT IF EXISTS slot_outcomes_reel1_check;
ALTER TABLE slot_outcomes DROP CONSTRAINT IF EXISTS slot_outcomes_reel2_check;
ALTER TABLE slot_outcomes DROP CONSTRAINT IF EXISTS slot_outcomes_reel3_check;
ALTER TABLE slot_outcomes DROP CONSTRAINT IF EXISTS slot_outcomes_weight_check;
ALTER TABLE slot_outcomes DROP CONSTRAINT IF EXISTS slot_outcomes_payout_check;
ALTER TABLE slot_outcomes ADD CONSTRAINT slot_outcomes_reel1_check CHECK (reel1_position BETWEEN 1 AND 12);
ALTER TABLE slot_outcomes ADD CONSTRAINT slot_outcomes_reel2_check CHECK (reel2_position BETWEEN 1 AND 12);
ALTER TABLE slot_outcomes ADD CONSTRAINT slot_outcomes_reel3_check CHECK (reel3_position BETWEEN 1 AND 12);
ALTER TABLE slot_outcomes ADD CONSTRAINT slot_outcomes_weight_check CHECK (weight >= 0);
ALTER TABLE slot_outcomes ADD CONSTRAINT slot_outcomes_payout_check CHECK (payout_multiplier >= 0 AND payout_multiplier <= 10000);

CREATE UNIQUE INDEX IF NOT EXISTS slot_outcomes_unique_combination
  ON slot_outcomes (game_night_id, reel1_position, reel2_position, reel3_position);
CREATE INDEX IF NOT EXISTS slot_outcomes_weighted
  ON slot_outcomes (game_night_id, reel1_position, reel2_position, reel3_position)
  WHERE weight > 0;

CREATE TABLE IF NOT EXISTS slot_sessions (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  stake_per_spin INTEGER NOT NULL,
  total_spins INTEGER NOT NULL,
  remaining_spins INTEGER NOT NULL,
  total_stake INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

ALTER TABLE slot_sessions DROP CONSTRAINT IF EXISTS slot_sessions_stake_check;
ALTER TABLE slot_sessions DROP CONSTRAINT IF EXISTS slot_sessions_total_spins_check;
ALTER TABLE slot_sessions DROP CONSTRAINT IF EXISTS slot_sessions_remaining_check;
ALTER TABLE slot_sessions DROP CONSTRAINT IF EXISTS slot_sessions_total_stake_check;
ALTER TABLE slot_sessions DROP CONSTRAINT IF EXISTS slot_sessions_status_check;
ALTER TABLE slot_sessions ADD CONSTRAINT slot_sessions_stake_check CHECK (stake_per_spin > 0);
ALTER TABLE slot_sessions ADD CONSTRAINT slot_sessions_total_spins_check CHECK (total_spins > 0);
ALTER TABLE slot_sessions ADD CONSTRAINT slot_sessions_remaining_check CHECK (remaining_spins >= 0 AND remaining_spins <= total_spins);
ALTER TABLE slot_sessions ADD CONSTRAINT slot_sessions_total_stake_check CHECK (total_stake > 0);
ALTER TABLE slot_sessions ADD CONSTRAINT slot_sessions_status_check CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED'));

-- One slot machine is presented on one Big Screen, so exactly one financially
-- live series may exist per game night.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot_session_per_game
  ON slot_sessions (game_night_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS slot_sessions_unique_idempotency
  ON slot_sessions (game_night_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS slot_sessions_by_player ON slot_sessions (player_id, id DESC);

CREATE TABLE IF NOT EXISTS slot_spins (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  slot_session_id BIGINT NOT NULL REFERENCES slot_sessions(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  spin_number INTEGER NOT NULL,
  stake INTEGER NOT NULL,
  reel1_position SMALLINT NOT NULL,
  reel2_position SMALLINT NOT NULL,
  reel3_position SMALLINT NOT NULL,
  payout_multiplier NUMERIC(8,2) NOT NULL DEFAULT 0,
  payout_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SPINNING',
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revealed_at TIMESTAMPTZ
);

ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_spin_number_check;
ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_stake_check;
ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_reel1_check;
ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_reel2_check;
ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_reel3_check;
ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_payout_check;
ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_status_check;
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_spin_number_check CHECK (spin_number > 0);
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_stake_check CHECK (stake > 0);
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_reel1_check CHECK (reel1_position BETWEEN 1 AND 12);
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_reel2_check CHECK (reel2_position BETWEEN 1 AND 12);
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_reel3_check CHECK (reel3_position BETWEEN 1 AND 12);
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_payout_check CHECK (payout_amount >= 0 AND payout_multiplier >= 0);
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_status_check CHECK (status IN ('SPINNING','RESULT'));

CREATE UNIQUE INDEX IF NOT EXISTS slot_spins_unique_number
  ON slot_spins (slot_session_id, spin_number);
CREATE UNIQUE INDEX IF NOT EXISTS slot_spins_unique_idempotency
  ON slot_spins (game_night_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS slot_spins_spinning_by_time
  ON slot_spins (game_night_id, created_at) WHERE status = 'SPINNING';
CREATE INDEX IF NOT EXISTS slot_spins_recent ON slot_spins (game_night_id, id DESC);

-- Ledger attribution for slot money movement.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS slot_session_id BIGINT REFERENCES slot_sessions(id) ON DELETE SET NULL;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS slot_spin_id BIGINT REFERENCES slot_spins(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_slot_spin_payout
  ON ledger_entries (slot_spin_id, transaction_type)
  WHERE slot_spin_id IS NOT NULL AND transaction_type = 'SLOT_PAYOUT';
CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_slot_session_action
  ON ledger_entries (slot_session_id, transaction_type)
  WHERE slot_session_id IS NOT NULL AND transaction_type IN ('SLOT_DEPOSIT','SLOT_REFUND');

INSERT INTO slot_settings (game_night_id)
SELECT id FROM game_nights
ON CONFLICT (game_night_id) DO NOTHING;
