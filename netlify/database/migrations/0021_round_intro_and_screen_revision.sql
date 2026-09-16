-- 0021 — every round opens with an intro, and the screen counts its own changes
--
-- Two things, both in service of one idea: a game night should read as one chronological
-- story that the host walks through with a single VOLGENDE.
--
-- ---------------------------------------------------------------------------
-- 1. ROUND_INTRO
-- ---------------------------------------------------------------------------
--
-- A round now opens on a title card rather than on its first question. That card is a
-- *state of the round*, not a row: it is drawn from `rounds.title`, `description`,
-- `instructions` and `type`, which the host already fills in. Adding an intro table would
-- mean authoring the same words twice and keeping them in step.
--
-- So the only schema this needs is permission for the pointer to say so. `screen_state`
-- already carries `round_id`; ROUND_INTRO is the mode that means "the round itself".
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','ROUND_INTRO','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','ROUND_INTRO','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','ROUND_INTRO','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_current_screen_mode_check;
ALTER TABLE game_nights ADD CONSTRAINT game_nights_current_screen_mode_check
  CHECK (current_screen_mode IN ('DASHBOARD','ROUND_INTRO','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

-- ---------------------------------------------------------------------------
-- 2. The screen's own revision
-- ---------------------------------------------------------------------------
--
-- Navigation is now one pair of buttons that moves the projector through everything —
-- intro, pages, reveals, questions, round end. The thing being stepped is the screen, so
-- the thing a stale step has to be checked against is the screen.
--
-- `round_runtime.revision` was the guard until now and it is not enough any more: the
-- intro and the round-completing step do not belong to any item inside a round, so they
-- move the projector without moving a round cursor. Two tabs could both step from the
-- intro and both succeed.
--
-- Every write through `setScreen` bumps this. A VOLGENDE carries the number the Admin was
-- looking at, and a step from a tab that has fallen behind is refused rather than dragging
-- the room back to where that tab thought the evening was.
ALTER TABLE screen_state ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

INSERT INTO migration_notes (migration, game_night_id, subject, note)
SELECT '0021', id, 'screen_state',
  'Rounds now open on a ROUND_INTRO card drawn from the round''s own title, description ' ||
  'and instructions. screen_state.revision guards the central VOLGENDE/VORIGE against ' ||
  'stale admin tabs.'
FROM game_nights;
