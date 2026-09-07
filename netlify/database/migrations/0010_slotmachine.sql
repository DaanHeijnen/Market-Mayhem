-- Slotmachine: a round content block with its own player-driven betting series.
--
-- Shape of the feature, and why the tables look like this:
--
--   Global (Settings)  reel artwork and the outcome distribution. Both are game-wide
--                      because the same machine is reused by every slot block in the
--                      night, and the Admin configures them once.
--   Per block          title, instructions, max spins per series and an optional
--                      participant allowlist. Those live in the existing
--                      round_blocks.payload — no new table, same as every other type.
--   Per player/series  slot_series: one locked reeks (stake per spin x spins).
--   Per spin           slot_spins: the outcome the server chose, and what it paid.
--
-- The financial model deliberately mirrors prediction deposits rather than roulette
-- chips: locking a series debits the whole total stake at once, so a player cannot
-- commit 50 coins to the machine and spend them elsewhere before spinning. The unspun
-- remainder is logically locked value (stake_per_spin x spins_remaining) and is
-- refunded if the series is cancelled. Each spin's payout is credited in the same
-- transaction that chose the outcome, so there is no unsettled money and no second
-- Admin action to forget.

-- ---------------------------------------------------------------------------
-- Retire the abandoned first slotmachine attempt before building this one.
--
-- Commit 1e3f63f2 ("intro van slot machine") added a migration `0007_slot_machine`
-- with a different design: symbol PNGs stored as BYTEA inside the database, a
-- `slot_settings` table, and play modelled as `slot_sessions` + `slot_spins`. Its
-- source files were removed again in 4c7c66b7, so nothing in the codebase reads
-- those tables any more — but any database the migration reached still has them,
-- and `netlify database status` reports it as "applied but missing on disk".
--
-- That matters because the two designs collide on names: `slot_outcomes`,
-- `slot_spins`, the `slot_spins_spinning_by_time` index, and
-- `ledger_entries.slot_spin_id`. `CREATE TABLE IF NOT EXISTS` silently skips a
-- colliding table and the next statement then fails against the old shape --
-- concretely, `column "round_block_id" does not exist`.
--
-- So the old schema is dropped rather than merged. It holds only abandoned
-- experimental rows: the feature was never finished and its code no longer exists.
--
-- Guarded on artefacts unique to that old design, so this is a no-op on a fresh
-- database and can never touch the tables created below.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name IN ('slot_sessions','slot_settings','slot_symbols'))
     OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'slot_spins' AND column_name = 'slot_session_id')
  THEN
    RAISE NOTICE 'Dropping the abandoned 0007_slot_machine schema before creating the current one';

    -- Dropping these columns also drops the old partial unique indexes that used
    -- them (ledger_unique_slot_spin_payout, ledger_unique_slot_session_action) and
    -- their foreign keys into the old tables. `slot_spin_id` is recreated further
    -- down, pointing at the new slot_spins.
    ALTER TABLE ledger_entries DROP COLUMN IF EXISTS slot_session_id;
    ALTER TABLE ledger_entries DROP COLUMN IF EXISTS slot_spin_id;

    -- CASCADE clears the old tables' own indexes and cross-references. Order is
    -- irrelevant with CASCADE, but spins-before-sessions matches the dependency.
    DROP TABLE IF EXISTS slot_spins CASCADE;
    DROP TABLE IF EXISTS slot_sessions CASCADE;
    DROP TABLE IF EXISTS slot_outcomes CASCADE;
    DROP TABLE IF EXISTS slot_symbols CASCADE;
    DROP TABLE IF EXISTS slot_settings CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS slot_configs (
  game_night_id BIGINT PRIMARY KEY REFERENCES game_nights(id) ON DELETE CASCADE,
  -- The denominator the Admin sets: "totaal aantal kansen". Percentages shown in the
  -- UI are weight / total_weight, and a configuration is only valid when the weights
  -- sum to exactly this number.
  total_weight INTEGER NOT NULL DEFAULT 100 CHECK (total_weight BETWEEN 1 AND 1000000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT 'admin'
);

-- 3 reels x 12 positions. Only the Netlify Blobs key is stored, never the image bytes:
-- reel artwork rides along in the Admin snapshot and the Big Screen snapshot, which are
-- polled all evening. Keys are produced by the existing upload-block-media endpoint and
-- served by block-media, so slot symbols reuse the round-media store rather than adding
-- a second upload path.
CREATE TABLE IF NOT EXISTS slot_reel_symbols (
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  reel INTEGER NOT NULL CHECK (reel BETWEEN 1 AND 3),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 12),
  media_key TEXT NOT NULL CHECK (length(btrim(media_key)) > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_night_id, reel, position)
);

-- One row per configured combination. Sparse on purpose: 12x12x12 is 1728 possible
-- combinations and an Admin configures a handful, so absent rows simply mean weight 0.
CREATE TABLE IF NOT EXISTS slot_outcomes (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  reel1_position INTEGER NOT NULL CHECK (reel1_position BETWEEN 1 AND 12),
  reel2_position INTEGER NOT NULL CHECK (reel2_position BETWEEN 1 AND 12),
  reel3_position INTEGER NOT NULL CHECK (reel3_position BETWEEN 1 AND 12),
  weight INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),
  payout_multiplier NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK (payout_multiplier >= 0 AND payout_multiplier <= 10000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_night_id, reel1_position, reel2_position, reel3_position)
);

CREATE INDEX IF NOT EXISTS slot_outcomes_by_game_weight
  ON slot_outcomes(game_night_id) WHERE weight > 0;

CREATE TABLE IF NOT EXISTS slot_series (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  stake_per_spin INTEGER NOT NULL CHECK (stake_per_spin > 0),
  total_spins INTEGER NOT NULL CHECK (total_spins > 0),
  spins_remaining INTEGER NOT NULL CHECK (spins_remaining >= 0),
  total_stake INTEGER NOT NULL CHECK (total_stake > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED')),
  refunded_spins INTEGER NOT NULL DEFAULT 0 CHECK (refunded_spins >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  -- spins_remaining can never exceed what was paid for, which is what stops a replayed
  -- or racing SPIN from manufacturing extra spins.
  CONSTRAINT slot_series_remaining_within_total CHECK (spins_remaining <= total_spins)
);

-- A player runs at most one live series per slot block. Locking a new reeks is only
-- possible once the previous one is COMPLETED or CANCELLED.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot_series_per_player_block
  ON slot_series(round_block_id, player_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS slot_series_by_block_status ON slot_series(round_block_id, status);
CREATE INDEX IF NOT EXISTS slot_series_by_game_status ON slot_series(game_night_id, status);

CREATE TABLE IF NOT EXISTS slot_spins (
  id BIGSERIAL PRIMARY KEY,
  slot_series_id BIGINT NOT NULL REFERENCES slot_series(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  spin_number INTEGER NOT NULL CHECK (spin_number > 0),
  reel1_position INTEGER NOT NULL CHECK (reel1_position BETWEEN 1 AND 12),
  reel2_position INTEGER NOT NULL CHECK (reel2_position BETWEEN 1 AND 12),
  reel3_position INTEGER NOT NULL CHECK (reel3_position BETWEEN 1 AND 12),
  -- The artwork as it was at spin time. Settings can be re-uploaded later in the
  -- evening; history must still show the symbols the room actually saw.
  reel1_media_key TEXT NOT NULL DEFAULT '',
  reel2_media_key TEXT NOT NULL DEFAULT '',
  reel3_media_key TEXT NOT NULL DEFAULT '',
  stake INTEGER NOT NULL CHECK (stake > 0),
  payout_multiplier NUMERIC(8,3) NOT NULL CHECK (payout_multiplier >= 0),
  payout INTEGER NOT NULL CHECK (payout >= 0),
  -- SPINNING is purely presentational: the outcome above is already final and stored.
  -- The status exists so Admin and phone surfaces can say "spinning" for as long as the
  -- Big Screen animation runs, and is advanced by the same timed sync that reveals a
  -- roulette result.
  status TEXT NOT NULL DEFAULT 'SPINNING' CHECK (status IN ('SPINNING','RESULT')),
  idempotency_key TEXT NOT NULL,
  spun_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slot_series_id, spin_number),
  -- A retried or double-tapped SPIN carries the same key and is answered with the spin
  -- it already produced, rather than consuming another one.
  UNIQUE (slot_series_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS slot_spins_by_block_time ON slot_spins(round_block_id, spun_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS slot_spins_spinning_by_time ON slot_spins(game_night_id, spun_at) WHERE status = 'SPINNING';

-- Ledger attribution, exactly as roulette got in 0005. Money is never tracked anywhere
-- but ledger_entries + wallets; there is no separate slotmachine balance.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS slot_series_id BIGINT REFERENCES slot_series(id) ON DELETE SET NULL;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS slot_spin_id BIGINT REFERENCES slot_spins(id) ON DELETE SET NULL;

-- One stake row and at most one refund row per series; one payout row per spin.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_slot_series_action
  ON ledger_entries (slot_series_id, transaction_type)
  WHERE slot_series_id IS NOT NULL AND transaction_type IN ('SLOT_STAKE','SLOT_REFUND');

CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_slot_spin_action
  ON ledger_entries (slot_spin_id, transaction_type)
  WHERE slot_spin_id IS NOT NULL AND transaction_type = 'SLOT_PAYOUT';

-- SLOTMACHINE joins the authorable content types.
ALTER TABLE round_blocks DROP CONSTRAINT IF EXISTS round_blocks_type_check;
ALTER TABLE round_blocks ADD CONSTRAINT round_blocks_type_check
  CHECK (type IN ('TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER','SLOTMACHINE'));

-- ...and as a projector composition, in the live, staged and previous slots alike.
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE'));

-- Every existing game gets the default denominator, so Settings opens with a total to
-- allocate against rather than an empty form.
INSERT INTO slot_configs (game_night_id)
SELECT id FROM game_nights
ON CONFLICT (game_night_id) DO NOTHING;
