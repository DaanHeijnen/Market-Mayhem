-- Player-submitted prediction requests, from the Admin UX redesign: a player
-- proposes a market from their phone, the Admin approves or denies it with a
-- reason, and the Admin panel surfaces pending ones for review.
--
-- Approval deliberately does NOT create a market. The design's player-facing copy
-- is "Approved · waiting for prediction to go live", so approving only signals
-- intent; the Admin still authors the market on the Predictions page with its own
-- odds and stake limits.
--
-- The submission limits (max 2 per player, 1 hour between submissions) are
-- enforced in the endpoint rather than by constraints, because both are relative
-- to the requesting player and need to return a useful error rather than a
-- constraint violation. The index below is what makes those checks cheap.

CREATE TABLE IF NOT EXISTS prediction_requests (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

ALTER TABLE prediction_requests DROP CONSTRAINT IF EXISTS prediction_requests_status_check;
ALTER TABLE prediction_requests ADD CONSTRAINT prediction_requests_status_check
  CHECK (status IN ('PENDING','APPROVED','DENIED'));

-- A denial is only meaningful with a reason; the design makes the reason field
-- mandatory before CONFIRM DENY is accepted.
ALTER TABLE prediction_requests DROP CONSTRAINT IF EXISTS prediction_requests_denied_reason_check;
ALTER TABLE prediction_requests ADD CONSTRAINT prediction_requests_denied_reason_check
  CHECK (status <> 'DENIED' OR length(btrim(reason)) > 0);

ALTER TABLE prediction_requests DROP CONSTRAINT IF EXISTS prediction_requests_question_check;
ALTER TABLE prediction_requests ADD CONSTRAINT prediction_requests_question_check
  CHECK (length(btrim(question)) > 0 AND length(question) <= 300);

-- Serves both the Admin "needs review" panel and the per-player cap/cooldown checks.
CREATE INDEX IF NOT EXISTS prediction_requests_game_status_idx
  ON prediction_requests(game_night_id, status);
CREATE INDEX IF NOT EXISTS prediction_requests_player_created_idx
  ON prediction_requests(player_id, created_at DESC);
