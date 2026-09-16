-- Pak een Zes: a round content block where players first predict which four of them
-- will draw a six, then take turns drawing from a real 52-card deck until all four
-- sixes are out.
--
-- No money moves in this game, so there is no wallet or ledger involvement. What does
-- matter is that everything stays recorded: this step deliberately builds no scoring,
-- but the predictions and the six events are stored so a points system can be added
-- later without replaying the evening.

CREATE TABLE IF NOT EXISTS pak_een_zes_games (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'READY',
  -- Walks the fixed turn order and wraps: the game ends when the sixes run out, not
  -- when everyone has had a turn, so players often go round more than once.
  turn_index INTEGER NOT NULL DEFAULT 0 CHECK (turn_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  predictions_opened_at TIMESTAMPTZ,
  predictions_closed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pak_een_zes_games DROP CONSTRAINT IF EXISTS pak_een_zes_games_status_check;
ALTER TABLE pak_een_zes_games ADD CONSTRAINT pak_een_zes_games_status_check
  CHECK (status IN ('READY','PREDICTING','LOCKED','DRAWING','FINISHED','CANCELLED'));

-- One live game per block, so re-showing a block cannot silently start a second one
-- alongside the first.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_pak_een_zes_per_block
  ON pak_een_zes_games(round_block_id)
  WHERE status IN ('READY','PREDICTING','LOCKED','DRAWING');

CREATE INDEX IF NOT EXISTS pak_een_zes_games_by_game_status ON pak_een_zes_games(game_night_id, status);

-- The turn order, frozen when the host starts the game. Stored rather than derived so
-- a player joining or leaving mid-game cannot reshuffle whose turn it is.
CREATE TABLE IF NOT EXISTS pak_een_zes_participants (
  pak_een_zes_game_id BIGINT NOT NULL REFERENCES pak_een_zes_games(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  turn_order INTEGER NOT NULL CHECK (turn_order >= 0),
  PRIMARY KEY (pak_een_zes_game_id, player_id),
  UNIQUE (pak_een_zes_game_id, turn_order)
);

-- Four ordered picks per player, one row per slot.
--
-- Per slot rather than an array precisely because duplicates are allowed: "Daan, Twan,
-- Daan, Bas" is a valid prediction and must stay four picks, not collapse to three
-- names. Picking yourself is allowed too, so there is no constraint against it.
CREATE TABLE IF NOT EXISTS pak_een_zes_predictions (
  pak_een_zes_game_id BIGINT NOT NULL REFERENCES pak_een_zes_games(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 4),
  predicted_player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pak_een_zes_game_id, player_id, slot)
);

-- Answers "who did people back?" for a future scoring pass without scanning the table.
CREATE INDEX IF NOT EXISTS pak_een_zes_predictions_by_pick
  ON pak_een_zes_predictions(pak_een_zes_game_id, predicted_player_id);

-- Every card that left the deck, in order.
--
-- The drawn rows *are* the deck's history: what remains is derived from them, so a
-- replayed request cannot resurrect a card. `is_six` is stored rather than derived so
-- the six events stay queryable even if the rank vocabulary were ever to change.
CREATE TABLE IF NOT EXISTS pak_een_zes_draws (
  id BIGSERIAL PRIMARY KEY,
  pak_een_zes_game_id BIGINT NOT NULL REFERENCES pak_een_zes_games(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  draw_number INTEGER NOT NULL CHECK (draw_number > 0),
  rank TEXT NOT NULL,
  suit TEXT NOT NULL,
  is_six BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A card leaves the deck once. This is the hard guarantee behind "no repeats",
  -- independent of any application logic.
  UNIQUE (pak_een_zes_game_id, rank, suit),
  UNIQUE (pak_een_zes_game_id, draw_number),
  -- A retried or double-tapped KAART PAKKEN carries the same key and is answered with
  -- the card it already drew, rather than taking another one.
  UNIQUE (pak_een_zes_game_id, idempotency_key)
);

ALTER TABLE pak_een_zes_draws DROP CONSTRAINT IF EXISTS pak_een_zes_draws_rank_check;
ALTER TABLE pak_een_zes_draws ADD CONSTRAINT pak_een_zes_draws_rank_check
  CHECK (rank IN ('2','3','4','5','6','7','8','9','10','J','Q','K','A'));

ALTER TABLE pak_een_zes_draws DROP CONSTRAINT IF EXISTS pak_een_zes_draws_suit_check;
ALTER TABLE pak_een_zes_draws ADD CONSTRAINT pak_een_zes_draws_suit_check
  CHECK (suit IN ('HEARTS','DIAMONDS','CLUBS','SPADES'));

-- Keeps `is_six` honest, so a six event can never be recorded against a non-six.
ALTER TABLE pak_een_zes_draws DROP CONSTRAINT IF EXISTS pak_een_zes_draws_is_six_check;
ALTER TABLE pak_een_zes_draws ADD CONSTRAINT pak_een_zes_draws_is_six_check
  CHECK (is_six = (rank = '6'));

CREATE INDEX IF NOT EXISTS pak_een_zes_draws_by_game_order
  ON pak_een_zes_draws(pak_een_zes_game_id, draw_number);

-- The scoring question this whole feature exists to make answerable later: which player
-- drew a six, which suit, on which draw, and how often the same player did it.
CREATE INDEX IF NOT EXISTS pak_een_zes_sixes_by_player
  ON pak_een_zes_draws(game_night_id, player_id) WHERE is_six;

-- PAK_EEN_ZES joins the authorable content types.
ALTER TABLE round_blocks DROP CONSTRAINT IF EXISTS round_blocks_type_check;
ALTER TABLE round_blocks ADD CONSTRAINT round_blocks_type_check
  CHECK (type IN ('TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER','SLOTMACHINE','PAK_EEN_ZES'));

-- ...and as a projector composition, in the live, staged and previous slots alike.
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES'));
