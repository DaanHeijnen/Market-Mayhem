-- Pak een Zes scoring: one Admin-set amount per correct prediction.
--
-- Migration 0013 deliberately stored the predictions and the six events without scoring
-- them. This turns that record into a payout, using the same wallet + ledger path every
-- other reward in the game uses — a live question's `QUESTION_REWARD` is the direct
-- precedent, including how it guarantees it cannot pay twice.

-- One game-wide value: not per player, per six or per prediction slot. Lives on
-- game_nights beside the other game-level settings the Admin edits.
ALTER TABLE game_nights
  ADD COLUMN IF NOT EXISTS pak_een_zes_points_per_correct INTEGER NOT NULL DEFAULT 25;

ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_pak_een_zes_points_check;
ALTER TABLE game_nights ADD CONSTRAINT game_nights_pak_een_zes_points_check
  CHECK (pak_een_zes_points_per_correct BETWEEN 0 AND 1000000);

-- The rate as it stood when this game paid out. Snapshotted so changing Settings later
-- never rewrites what a finished game awarded — the same reason a bet keeps its odds
-- snapshot rather than recalculating from a later slider value.
ALTER TABLE pak_een_zes_games
  ADD COLUMN IF NOT EXISTS points_per_correct INTEGER;

-- Ledger attribution, so a reward can be traced back to the game that produced it.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS pak_een_zes_game_id BIGINT REFERENCES pak_een_zes_games(id) ON DELETE SET NULL;

-- At most one reward per player per game. This is what makes double payout impossible
-- rather than merely unlikely: the award runs inside the same transaction as the final
-- six, and a retry hits this index instead of crediting again.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_pak_een_zes_reward
  ON ledger_entries (pak_een_zes_game_id, player_id)
  WHERE pak_een_zes_game_id IS NOT NULL AND transaction_type = 'PAK_EEN_ZES_REWARD';

CREATE INDEX IF NOT EXISTS ledger_pak_een_zes_by_game
  ON ledger_entries (pak_een_zes_game_id) WHERE pak_een_zes_game_id IS NOT NULL;
