-- One shared set of 12 slotmachine symbols instead of 3 x 12.
--
-- Migration 0010 gave each reel its own twelve uploads, which meant 36 files for a
-- machine whose reels are meant to look alike — the Admin had to upload the same
-- artwork three times. In practice every reel uses the same symbols, so the artwork
-- becomes one set of twelve and `reel` disappears from this table.
--
-- What does NOT change: an outcome still names a position per reel, so `AAB` still
-- means position 1 on the first two reels and position 2 on the third. The reels
-- still stop independently. Only the artwork is shared.

-- Collapse first, so nothing already uploaded is thrown away: for each position keep
-- the row from the lowest-numbered reel that has one. A machine configured only on
-- reel 2 or 3 therefore still keeps its images.
DELETE FROM slot_reel_symbols s
USING (
  SELECT game_night_id, position, MIN(reel) AS keep_reel
  FROM slot_reel_symbols
  GROUP BY game_night_id, position
) keep
WHERE s.game_night_id = keep.game_night_id
  AND s.position = keep.position
  AND s.reel <> keep.keep_reel;

-- The primary key is dropped explicitly before the column it contains, so the
-- intent is visible rather than happening as a side effect of DROP COLUMN.
ALTER TABLE slot_reel_symbols DROP CONSTRAINT IF EXISTS slot_reel_symbols_pkey;
-- Dropping the column takes its CHECK (reel BETWEEN 1 AND 3) with it.
ALTER TABLE slot_reel_symbols DROP COLUMN IF EXISTS reel;
ALTER TABLE slot_reel_symbols ADD CONSTRAINT slot_reel_symbols_pkey PRIMARY KEY (game_night_id, position);
