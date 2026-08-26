-- Staged and previous screen slots, for the presenter model in the Admin UX
-- redesign: the host stages a step, previews it, then pushes it live.
--
-- Before this migration screen_state held exactly one pointer, so there was
-- nowhere to put a step the host had chosen but not yet shown. These columns
-- mirror the existing live columns rather than introducing a second table, so
-- getAdminState reads them from the screen_state row it already fetches and the
-- change costs no extra query.
--
--   staged_*   what GO LIVE will promote to live
--   previous_* what BACK TO RUN OF SHOW restores after a temporary detour to the
--              market dashboard. Showing the dashboard must not lose the host's
--              place in the round, and must not touch game state.

ALTER TABLE screen_state
  ADD COLUMN IF NOT EXISTS staged_mode TEXT,
  ADD COLUMN IF NOT EXISTS staged_round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staged_prediction_id BIGINT REFERENCES predictions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staged_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS previous_mode TEXT,
  ADD COLUMN IF NOT EXISTS previous_round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_prediction_id BIGINT REFERENCES predictions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Same allowed values as the live mode column, plus NULL for "nothing staged".
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE'));

-- Seed the staged slot from whatever is currently live, so an upgraded game opens
-- with the preview pane showing the current step rather than an empty card.
UPDATE screen_state
SET staged_mode = mode,
    staged_round_id = round_id,
    staged_prediction_id = prediction_id,
    staged_payload = payload
WHERE staged_mode IS NULL;
