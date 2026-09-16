-- Fotoronde: a round content block where each team submits one photo per subject and
-- the Admin awards credits per photo, split across that team's members.
--
-- "Team" here means a round group (`round_groups` / `round_group_members`), which is the
-- live team system — a player belongs to at most one group per round, so the app can
-- derive a player's team from their session rather than asking them to pick one. The
-- legacy `teams` table is untouched; nothing reads it.
--
-- Credits are real coins: they land in wallets through the existing ledger, the same way
-- a group adjustment does, so this adds no second currency.

CREATE TABLE IF NOT EXISTS photo_rounds (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE photo_rounds DROP CONSTRAINT IF EXISTS photo_rounds_status_check;
ALTER TABLE photo_rounds ADD CONSTRAINT photo_rounds_status_check
  CHECK (status IN ('DRAFT','OPEN','CLOSED','COMPLETED'));

-- One photo round per block, whatever phase it is in. Unlike the other games there is no
-- "start over": the photos and the credits awarded for them are history, so re-showing
-- the block returns to the same round rather than opening a second one.
CREATE UNIQUE INDEX IF NOT EXISTS one_photo_round_per_block
  ON photo_rounds(round_block_id);

CREATE INDEX IF NOT EXISTS photo_rounds_by_game_status ON photo_rounds(game_night_id, status);

CREATE TABLE IF NOT EXISTS photo_submissions (
  id BIGSERIAL PRIMARY KEY,
  photo_round_id BIGINT NOT NULL REFERENCES photo_rounds(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  round_block_id BIGINT REFERENCES round_blocks(id) ON DELETE SET NULL,
  -- The subject's stable key from the block payload, not its label: renaming a subject
  -- must keep its photos attached.
  subject_key TEXT NOT NULL CHECK (length(btrim(subject_key)) > 0),
  -- The team. Cascades with the group, because a submission on behalf of a team that no
  -- longer exists has nobody to pay.
  group_id BIGINT NOT NULL REFERENCES round_groups(id) ON DELETE CASCADE,
  -- Who pressed upload. SET NULL rather than cascade: deactivating or removing a player
  -- must not erase their team's photo or the credits it earned.
  uploaded_by BIGINT REFERENCES players(id) ON DELETE SET NULL,
  -- Only the Netlify Blobs key, never the bytes: submissions travel in the Admin and
  -- Big Screen snapshots, which are polled all evening.
  media_key TEXT NOT NULL CHECK (length(btrim(media_key)) > 0),
  credits_awarded INTEGER CHECK (credits_awarded IS NULL OR credits_awarded >= 0),
  awarded_at TIMESTAMPTZ,
  awarded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One active photo per team per subject. Replacing updates this row rather than
  -- inserting a second, so "Team X cannot hold two photos for Iets moois" is a database
  -- guarantee rather than an application promise.
  UNIQUE (photo_round_id, subject_key, group_id)
);

CREATE INDEX IF NOT EXISTS photo_submissions_by_round_subject
  ON photo_submissions(photo_round_id, subject_key);
CREATE INDEX IF NOT EXISTS photo_submissions_by_group
  ON photo_submissions(group_id);
-- "Which submissions are still unjudged" — the Admin's working list.
CREATE INDEX IF NOT EXISTS photo_submissions_unjudged
  ON photo_submissions(photo_round_id) WHERE credits_awarded IS NULL;

-- Ledger attribution, so a payout traces back to the exact photo that earned it.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS photo_submission_id BIGINT REFERENCES photo_submissions(id) ON DELETE SET NULL;

-- At most one reward per player per photo. This is what makes a double payout impossible
-- rather than merely guarded against: awarding twice hits this index instead of crediting
-- again, even if the Admin double-clicks or the request is retried.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_photo_submission_reward
  ON ledger_entries (photo_submission_id, player_id)
  WHERE photo_submission_id IS NOT NULL AND transaction_type = 'PHOTO_ROUND_REWARD';

CREATE INDEX IF NOT EXISTS ledger_photo_by_submission
  ON ledger_entries (photo_submission_id) WHERE photo_submission_id IS NOT NULL;

-- FOTORONDE joins the authorable content types.
ALTER TABLE round_blocks DROP CONSTRAINT IF EXISTS round_blocks_type_check;
ALTER TABLE round_blocks ADD CONSTRAINT round_blocks_type_check
  CHECK (type IN ('TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

-- ...and as a projector composition, in the live, staged and previous slots alike.
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','ROUND_BLOCK','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
