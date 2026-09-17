-- Fotoronde: a configurable submission window with a server-owned deadline.
--
-- Two separate things, deliberately in two places:
--
--   `fotoronde_rounds.submission_duration_minutes`  authored config, edited before the
--                                                   round is played, like slotmachine_rounds
--   `photo_rounds.submission_closes_at`             the runtime deadline, stamped once when
--                                                   the host opens submissions
--
-- Keeping them apart is what makes the deadline stable. Editing the duration afterwards
-- must not move a window that teams are already photographing against, and re-opening is
-- not possible at all (the phase machine is forward-only), so the deadline is written
-- exactly once per round.
--
-- `opened_at` already exists and is the start of the window; there is no second
-- `submission_opened_at`.

CREATE TABLE IF NOT EXISTS fotoronde_rounds (
  round_id BIGINT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  -- How long teams get, in minutes. Bounded at both ends: zero would open a window that
  -- is already shut, and four hours is longer than an evening.
  submission_duration_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (submission_duration_minutes BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fotoronde_rounds_by_game ON fotoronde_rounds(game_night_id);

-- The deadline itself. Nullable: a round that has not been opened has no window, and one
-- the host opened before this migration keeps its open-ended window rather than being
-- retroactively closed.
ALTER TABLE photo_rounds
  ADD COLUMN IF NOT EXISTS submission_closes_at TIMESTAMPTZ;

-- "Which windows are still running" — read by the auto-close sweep on every version poll.
CREATE INDEX IF NOT EXISTS photo_rounds_open_deadline
  ON photo_rounds(submission_closes_at)
  WHERE status = 'OPEN' AND submission_closes_at IS NOT NULL;

-- Every FOTORONDE round gets a settings row, so the editor always has something to edit
-- and the open action always has a duration to read.
INSERT INTO fotoronde_rounds (round_id, game_night_id)
SELECT r.id, r.game_night_id FROM rounds r
WHERE r.type = 'FOTORONDE'
ON CONFLICT (round_id) DO NOTHING;
