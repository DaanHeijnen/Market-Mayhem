-- 0020 — PUBQUIZ, a quiz that is presented page by page
--
-- A PRESENTATIE round is an ordered run of pages the host steps through; a LIVE_QUIZ round
-- is a set of questions the room answers on their phones. A pubquiz is both: each page is
-- a question, the projector shows it large, the phones answer it, and stepping forward
-- opens the next one.
--
-- It gets its own tables rather than a flag on the quiz ones, for three reasons that are
-- worth writing down because the duplication is real:
--
--   1. `assert_round_type` binds each content table to exactly one round type. Sharing
--      `live_quiz_questions` would mean weakening the trigger that makes "one type per
--      round" a database fact rather than a convention.
--   2. Media means something different. A LIVE_QUIZ question's `context_media_key` is
--      evidence shown *after* the reveal; a pubquiz question's image is part of the
--      question and is on screen from the start. One column cannot be both.
--   3. A pubquiz question can be held back from the run, exactly as a presentation page
--      can. A quiz question cannot.
--
-- The *rules* are shared. The phase machine, the participation arithmetic and the reward
-- lookup are pure functions in netlify/lib, and netlify/lib/pubquiz.ts uses them rather
-- than restating them. What is not shared is any table.

-- ---------------------------------------------------------------------------
-- 1. The round type
-- ---------------------------------------------------------------------------
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_type_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_type_check
  CHECK (type IN ('LIVE_QUIZ','PRESENTATIE','PUBQUIZ','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

-- ---------------------------------------------------------------------------
-- 2. Authored content
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pubquiz_questions (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  question TEXT NOT NULL,
  -- Extra text beside the question. Part of the question, so public from the start.
  body TEXT NOT NULL DEFAULT '',
  -- Seeded from the round's default_points and freely overridden per question. The
  -- authored reward; the coins it causes are ledger rows, never a column.
  points INTEGER NOT NULL DEFAULT 10 CHECK (points >= 0),
  -- One optional image, as a Netlify Blobs key. Shown *with* the question — deliberately
  -- not the LIVE_QUIZ context photo, which is a beat after the reveal.
  media_key TEXT,
  media_name TEXT,
  -- NULL means the host closes the question by hand.
  time_limit_seconds INTEGER CHECK (time_limit_seconds IS NULL OR time_limit_seconds BETWEEN 5 AND 600),
  -- Held back from the run, exactly as a presentation page can be: still fully editable
  -- here, skipped by previous/next, and refused by the projector.
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Deferrable so a reorder can renumber in one transaction without colliding with rows
  -- it has not reached yet.
  UNIQUE (round_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS pubquiz_questions_by_round
  ON pubquiz_questions (round_id, sort_order) INCLUDE (hidden);

CREATE TABLE IF NOT EXISTS pubquiz_question_options (
  id BIGSERIAL PRIMARY KEY,
  question_id BIGINT NOT NULL REFERENCES pubquiz_questions(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 5),
  text TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (question_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

-- Exactly one correct option per question, as a database fact.
--
-- This is where PUBQUIZ deliberately differs from LIVE_QUIZ, which allows several. A pub
-- quiz answer is "the" answer: the projector announces one, the player is told whether
-- they got it, and a question with two correct options would make both of those sentences
-- ambiguous. Enforced here rather than only in the endpoint, so no path can author one.
CREATE UNIQUE INDEX IF NOT EXISTS pubquiz_one_correct_option_per_question
  ON pubquiz_question_options (question_id) WHERE is_correct;

CREATE INDEX IF NOT EXISTS pubquiz_options_by_question
  ON pubquiz_question_options (question_id, sort_order);

-- ---------------------------------------------------------------------------
-- 3. Runtime state, beside the authored row and never inside it
-- ---------------------------------------------------------------------------
--
-- One row per authored question. Four phases rather than the quiz's five: scoring happens
-- at the reveal, so there is nothing left to settle afterwards and no SETTLED to sit in.
--
-- `revision` is the optimistic-locking token. Every admin command reads it and writes
-- guarded by it, so a stale REVEAL from a second tab is refused rather than applied.
CREATE TABLE IF NOT EXISTS pubquiz_question_state (
  question_id BIGINT PRIMARY KEY REFERENCES pubquiz_questions(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','OPEN','CLOSED','REVEALED')),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  revealed_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pubquiz_state_by_round ON pubquiz_question_state (round_id, status);

-- ---------------------------------------------------------------------------
-- 4. What the room answered
-- ---------------------------------------------------------------------------
--
-- `(question_id, player_id)` unique is the whole "one answer per player" rule: two taps
-- arriving together would both pass any check the application could write, and only the
-- database can decide which of them lands.
--
-- The chosen option is stored, not whether it was right. Correctness is a property of the
-- option and is derived at reveal, so a host who fixes a mis-marked answer key before
-- revealing changes the score rather than contradicting the stored rows.
CREATE TABLE IF NOT EXISTS pubquiz_answers (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES pubquiz_questions(id) ON DELETE CASCADE,
  option_id BIGINT NOT NULL REFERENCES pubquiz_question_options(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (question_id, player_id)
);

CREATE INDEX IF NOT EXISTS pubquiz_answers_by_question ON pubquiz_answers (question_id, option_id);

-- ---------------------------------------------------------------------------
-- 5. The round cursor and the projector pointer
-- ---------------------------------------------------------------------------
ALTER TABLE round_runtime
  ADD COLUMN IF NOT EXISTS current_pubquiz_question_id BIGINT REFERENCES pubquiz_questions(id) ON DELETE SET NULL;

ALTER TABLE screen_state
  ADD COLUMN IF NOT EXISTS pubquiz_question_id BIGINT REFERENCES pubquiz_questions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_pubquiz_question_id BIGINT REFERENCES pubquiz_questions(id) ON DELETE SET NULL;

-- The new scene, added to the three mode vocabularies that gate it.
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_current_screen_mode_check;
ALTER TABLE game_nights ADD CONSTRAINT game_nights_current_screen_mode_check
  CHECK (current_screen_mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PUBQUIZ_QUESTION','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

-- ---------------------------------------------------------------------------
-- 6. Rewards
-- ---------------------------------------------------------------------------
--
-- Points are coins in this economy, so a pubquiz reward is a ledger row and a wallet move
-- like every other payout. The partial unique index is the business key: one reward per
-- player per question, for all time, whatever a double-clicked reveal does.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS pubquiz_question_id BIGINT REFERENCES pubquiz_questions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_pubquiz_reward
  ON ledger_entries (pubquiz_question_id, player_id, transaction_type)
  WHERE pubquiz_question_id IS NOT NULL AND transaction_type = 'PUBQUIZ_REWARD';

-- ---------------------------------------------------------------------------
-- 7. One type per round, enforced where it cannot be argued with
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS pubquiz_questions_round_type ON pubquiz_questions;
CREATE TRIGGER pubquiz_questions_round_type
  BEFORE INSERT OR UPDATE OF round_id ON pubquiz_questions
  FOR EACH ROW EXECUTE FUNCTION assert_round_type('PUBQUIZ');

INSERT INTO migration_notes (migration, game_night_id, subject, note)
SELECT '0020', id, 'round_types',
  'PUBQUIZ added as a round type. No existing round was changed; pubquiz content lives in ' ||
  'its own tables and shares none with LIVE_QUIZ.'
FROM game_nights;
