-- Pay for patterns, not for pictures.
--
-- Migrations 0010/0011 configured a chance and a payout per *specific* symbol
-- combination, which meant `AAA` was three copies of one particular image and, in
-- principle, 1728 rows to manage. This replaces that with five fixed outcome types.
-- The Admin sets a chance and a payout per type; the server draws a type and only then
-- invents a 3x3 field matching it, choosing the symbols and positions at random.
--
-- So the configuration no longer mentions images at all: "three alike on a line" has
-- one chance and one payout, whichever of the twelve symbols happens to fill it.

CREATE TABLE IF NOT EXISTS slot_outcome_types (
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  outcome_type TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),
  payout_multiplier NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK (payout_multiplier >= 0 AND payout_multiplier <= 10000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_night_id, outcome_type)
);

-- The five categories are product, not configuration: the Admin tunes their chance and
-- payout but cannot invent a sixth or delete one.
ALTER TABLE slot_outcome_types DROP CONSTRAINT IF EXISTS slot_outcome_types_type_check;
ALTER TABLE slot_outcome_types ADD CONSTRAINT slot_outcome_types_type_check
  CHECK (outcome_type IN ('NO_WIN','TWO_SPLIT','TWO_ADJACENT','THREE_LINE','THREE_ANYWHERE'));

-- Paying out on "no win" would contradict the category, so zero is enforced here rather
-- than only in the endpoint.
ALTER TABLE slot_outcome_types DROP CONSTRAINT IF EXISTS slot_outcome_types_no_win_payout_check;
ALTER TABLE slot_outcome_types ADD CONSTRAINT slot_outcome_types_no_win_payout_check
  CHECK (outcome_type <> 'NO_WIN' OR payout_multiplier = 0);

-- Seed every game with the worked example from the brief, which sums to the default
-- total of 100. A game therefore starts with a valid, playable distribution instead of
-- an empty table the host has to discover is unusable.
INSERT INTO slot_outcome_types (game_night_id, outcome_type, weight, payout_multiplier)
SELECT g.id, seed.outcome_type, seed.weight, seed.payout_multiplier
FROM game_nights g
CROSS JOIN (VALUES
  ('NO_WIN',          60, 0.000),
  ('TWO_SPLIT',       20, 1.400),
  ('TWO_ADJACENT',    10, 1.800),
  ('THREE_LINE',       7, 3.000),
  ('THREE_ANYWHERE',   3, 5.000)
) AS seed(outcome_type, weight, payout_multiplier)
WHERE NOT EXISTS (
  SELECT 1 FROM slot_outcome_types existing
  WHERE existing.game_night_id = g.id AND existing.outcome_type = seed.outcome_type
);

-- The per-combination table has no successor: its rows described chances for specific
-- images, which is exactly the idea being removed. Nothing references it — ledger
-- attribution was always to the spin, never to the combination.
DROP TABLE IF EXISTS slot_outcomes;

-- A spin now records the whole visible field and which category it landed in.
--
-- `grid` holds 3 rows x 3 cells of {p: position, k: media key}. The media keys are
-- snapshotted, as before, so history still shows the artwork the room actually saw even
-- after Settings is re-uploaded.
-- `win_cells` holds the [row, column] pairs the projector highlights.
-- The existing reel1/2/3 columns keep their meaning as the main row — the row that
-- decides the two-alike categories.
ALTER TABLE slot_spins ADD COLUMN IF NOT EXISTS outcome_type TEXT NOT NULL DEFAULT 'NO_WIN';
ALTER TABLE slot_spins ADD COLUMN IF NOT EXISTS grid JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE slot_spins ADD COLUMN IF NOT EXISTS win_cells JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE slot_spins DROP CONSTRAINT IF EXISTS slot_spins_outcome_type_check;
ALTER TABLE slot_spins ADD CONSTRAINT slot_spins_outcome_type_check
  CHECK (outcome_type IN ('NO_WIN','TWO_SPLIT','TWO_ADJACENT','THREE_LINE','THREE_ANYWHERE'));

-- History reads group spins by category, so this index carries the Big Screen's recent
-- list and any later "what did the machine actually pay" question.
CREATE INDEX IF NOT EXISTS slot_spins_by_outcome_type ON slot_spins(game_night_id, outcome_type);
