-- Rounds become the primary content type.
--
-- Before this migration a round was an untyped container and every piece of content was
-- a row in one generic `round_blocks` table: eleven types sharing a `payload JSONB`, a
-- `sort_order`, and — in the same row — the runtime columns `interactive_status`,
-- `opened_at`, `closed_at`, `revealed_at`, `settled_at`. Authored content and runtime
-- state lived in the same row, and `game_nights.current_round_block_id` was the single
-- execution pointer every type-specific query hung off.
--
-- After it, a round has exactly one `type` and each type owns its content in its own
-- relational tables, with runtime state in separate tables keyed to the authored row.
-- There is no generic payload and no generic block navigation left.
--
-- Nothing is deleted silently. `round_blocks_archive` keeps every block and payload
-- verbatim, and `migration_notes` records each non-trivial decision this migration
-- made — above all which rounds had to be split, because a round that mixed a roulette
-- block with a quiz block cannot become a round with one type without becoming two
-- rounds.

-- ---------------------------------------------------------------------------
-- 0. Archive and decision log
-- ---------------------------------------------------------------------------

-- A verbatim copy, taken before anything is derived from it. This is what makes the
-- conversion auditable: every claim the rest of this migration makes about a block can
-- be checked against the row it was made from.
CREATE TABLE IF NOT EXISTS round_blocks_archive AS
  SELECT *, NOW() AS archived_at FROM round_blocks;

CREATE TABLE IF NOT EXISTS migration_notes (
  id BIGSERIAL PRIMARY KEY,
  migration TEXT NOT NULL,
  game_night_id BIGINT,
  subject TEXT NOT NULL,
  subject_id BIGINT,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 1. rounds gains a type, instructions and a default points value
-- ---------------------------------------------------------------------------

ALTER TABLE rounds
  ADD COLUMN IF NOT EXISTS type TEXT,
  -- Replaces the per-block `payload.body` that every interactive type used for the text
  -- shown on players' phones. One round, one set of instructions.
  ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT '',
  -- The value new content inherits: points per quiz question, credits per Fotoronde
  -- subject, points per correct Pak een Zes prediction. Always overridable per item.
  ADD COLUMN IF NOT EXISTS default_points INTEGER NOT NULL DEFAULT 10
    CHECK (default_points >= 0);

-- `round_number` was always a label rather than an execution pointer, and the new model
-- says so in the name. The unique constraint travels with it.
DO $rename$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'rounds' AND column_name = 'round_number') THEN
    ALTER TABLE rounds RENAME COLUMN round_number TO sort_order;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rounds_game_night_id_round_number_key') THEN
    ALTER TABLE rounds RENAME CONSTRAINT rounds_game_night_id_round_number_key
      TO rounds_game_night_id_sort_order_key;
  END IF;
END
$rename$;

ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_round_number_check;
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_sort_order_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_sort_order_check CHECK (sort_order > 0);

-- ---------------------------------------------------------------------------
-- 2. Authored content tables, one set per round type
-- ---------------------------------------------------------------------------

-- LIVE_QUIZ ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_quiz_questions (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  prompt TEXT NOT NULL,
  -- Extra text shown alongside the question while it is being answered. Part of the
  -- question, so unlike the answer it is public from the start.
  body TEXT NOT NULL DEFAULT '',
  -- Per question, seeded from the round's default_points but freely overridden. This is
  -- the authored reward; the wallet movement it causes is a ledger row, never a column.
  points INTEGER NOT NULL DEFAULT 10 CHECK (points >= 0),
  -- NULL means the host closes the question by hand, which is how every question
  -- behaved before this migration.
  time_limit_seconds INTEGER CHECK (time_limit_seconds IS NULL OR time_limit_seconds BETWEEN 5 AND 600),
  -- Netlify Blobs key. Shown as a separate projector step after the reveal, never before.
  context_media_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS live_quiz_questions_by_round ON live_quiz_questions(round_id, sort_order);

-- Options are rows rather than a JSON array because they have their own ordering and
-- their own correctness flag, and because more than one option may be correct — which a
-- single `correctAnswerIndex` could not express.
CREATE TABLE IF NOT EXISTS live_quiz_question_options (
  id BIGSERIAL PRIMARY KEY,
  question_id BIGINT NOT NULL REFERENCES live_quiz_questions(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 5),
  text TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (question_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS live_quiz_options_by_question ON live_quiz_question_options(question_id, sort_order);
-- Answering a question means "picked an option that is flagged correct", so scoring
-- reads this index rather than scanning every option of the round.
CREATE INDEX IF NOT EXISTS live_quiz_options_correct ON live_quiz_question_options(question_id) WHERE is_correct;

-- PRESENTATIE --------------------------------------------------------------
-- The six block types that had no phone-side flow — TEXT, QUESTION, PICTURE, MUSIC,
-- BUZZER, WAGER — collapse into one ordered slide model. What distinguished them was
-- never a state machine, only which fields they filled in and whether their answer was
-- hidden until the host revealed it, and both of those are fields here.
CREATE TABLE IF NOT EXISTS presentation_slides (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  -- One optional media file, kept as a Netlify Blobs key. The bytes never enter the
  -- database, because slides travel in every polled snapshot.
  media_key TEXT,
  media_kind TEXT CHECK (media_kind IS NULL OR media_kind IN ('IMAGE','AUDIO')),
  media_name TEXT,
  -- The answer line, withheld from every non-admin surface until the host reveals it.
  -- This is where a WAGER block's correctAnswer lands.
  reveal_text TEXT,
  -- For the picture and music rounds, where the title IS the answer.
  hide_title_until_reveal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, sort_order) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT presentation_slides_media_pair CHECK ((media_key IS NULL) = (media_kind IS NULL))
);

CREATE INDEX IF NOT EXISTS presentation_slides_by_round ON presentation_slides(round_id, sort_order);

-- FOTORONDE ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fotoronde_subjects (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  -- The stable identity a submission is filed under. Renaming the label must keep the
  -- photos attached, which is exactly what this key is for.
  subject_key TEXT NOT NULL CHECK (length(btrim(subject_key)) > 0),
  label TEXT NOT NULL,
  -- The suggested award for this subject. The host may still award any amount; this is
  -- what the award field starts at.
  points INTEGER NOT NULL DEFAULT 10 CHECK (points >= 0),
  -- An optional example or reference image for the host. Admin-facing only — it is never
  -- built into a player or projector payload.
  reference_media_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, subject_key),
  UNIQUE (round_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS fotoronde_subjects_by_round ON fotoronde_subjects(round_id, sort_order);

-- SLOTMACHINE --------------------------------------------------------------
-- Per-round settings only. The reel artwork and the outcome distribution are one machine
-- shared by the whole night and stay in slot_configs / slot_reel_symbols /
-- slot_outcome_types, which this migration does not touch.
CREATE TABLE IF NOT EXISTS slotmachine_rounds (
  round_id BIGINT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  max_spins INTEGER NOT NULL DEFAULT 10 CHECK (max_spins BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An allowlist as rows rather than an array of ids in a payload, so a removed player
-- cannot leave a dangling id behind.  No rows at all means everyone plays, which is the
-- usual case and the same meaning the empty array had.
CREATE TABLE IF NOT EXISTS slotmachine_round_participants (
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (round_id, player_id)
);

-- ---------------------------------------------------------------------------
-- 3. Runtime state tables, kept strictly apart from the authored rows above
-- ---------------------------------------------------------------------------

-- The per-round execution cursor that replaces game_nights.current_round_block_id.
-- One row per round rather than one pointer per game: progression belongs to the round
-- being played, and a completed round keeps the cursor it ended on.
--
-- `revision` is the optimistic-locking token. Every admin command that advances this
-- round reads it, and writes guarded by `WHERE revision = $expected`, so a stale NEXT
-- QUESTION from a second admin tab cannot overwrite a newer state.
CREATE TABLE IF NOT EXISTS round_runtime (
  round_id BIGINT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  current_quiz_question_id BIGINT REFERENCES live_quiz_questions(id) ON DELETE SET NULL,
  current_slide_id BIGINT REFERENCES presentation_slides(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per authored question. The phases are the same five the block row carried, but
-- they now live beside the question rather than inside it, so editing a question and
-- running a question are two different writes to two different tables.
CREATE TABLE IF NOT EXISTS live_quiz_question_state (
  question_id BIGINT PRIMARY KEY REFERENCES live_quiz_questions(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'READY'
    CHECK (status IN ('READY','OPEN','CLOSED','REVEALED','SETTLED')),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  revealed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  -- Whether the context photo step is currently on the projector. Runtime, so it resets
  -- with the question rather than being authored.
  context_photo_shown BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_quiz_state_by_round ON live_quiz_question_state(round_id, status);

CREATE TABLE IF NOT EXISTS presentation_slide_state (
  slide_id BIGINT PRIMARY KEY REFERENCES presentation_slides(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  revealed_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 4. Work out which round each block belongs to after the split
-- ---------------------------------------------------------------------------
--
-- A round with one type cannot hold a roulette block and a quiz block at once, so any
-- round that mixed them becomes several rounds. The rule:
--
--   * every DUOLINGO_QUESTION block in a round joins that round's one LIVE_QUIZ segment;
--   * every TEXT/QUESTION/PICTURE/MUSIC/BUZZER/WAGER block joins its one PRESENTATIE
--     segment;
--   * each ROULETTE / SLOTMACHINE / PAK_EEN_ZES / FOTORONDE block becomes a round of its
--     own, because each of those carries one game with its own runtime state.
--
-- Segments keep the order their first block had, the first segment keeps the original
-- round row (and therefore its id, its ledger attribution and its groups), and each
-- further segment becomes a new round placed directly after it.

CREATE TABLE _mig0016_block_map (
  block_id BIGINT PRIMARY KEY,
  game_night_id BIGINT NOT NULL,
  source_round_id BIGINT NOT NULL,
  segment_key TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  target_round_id BIGINT,
  target_type TEXT NOT NULL,
  block_order INTEGER NOT NULL
);

CREATE TABLE _mig0016_round_order (
  round_id BIGINT PRIMARY KEY,
  game_night_id BIGINT NOT NULL,
  order_key NUMERIC NOT NULL
);

WITH typed AS (
  SELECT
    b.id,
    b.game_night_id,
    b.round_id,
    b.sort_order,
    CASE
      WHEN b.type = 'DUOLINGO_QUESTION' THEN 'LIVE_QUIZ'
      WHEN b.type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE') THEN b.type
      ELSE 'PRESENTATIE'
    END AS target_type,
    -- One segment per quiz/presentation group, but one segment per individual game
    -- block: each roulette, slotmachine, Pak een Zes and Fotoronde carries its own
    -- runtime state and so needs its own round.
    CASE
      WHEN b.type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE') THEN b.type || ':' || b.id
      WHEN b.type = 'DUOLINGO_QUESTION' THEN 'LIVE_QUIZ'
      ELSE 'PRESENTATIE'
    END AS segment_key,
    b.sort_order * 1000000 + b.id AS position
  FROM round_blocks b
), segmented AS (
  SELECT
    t.*,
    MIN(t.position) OVER (PARTITION BY t.round_id, t.segment_key) AS segment_start
  FROM typed t
)
INSERT INTO _mig0016_block_map (block_id, game_night_id, source_round_id, segment_key, segment_index, target_type, block_order)
SELECT
  s.id,
  s.game_night_id,
  s.round_id,
  s.segment_key,
  DENSE_RANK() OVER (PARTITION BY s.round_id ORDER BY s.segment_start) - 1,
  s.target_type,
  ROW_NUMBER() OVER (PARTITION BY s.round_id, s.segment_key ORDER BY s.position) - 1
FROM segmented s;

-- The first segment stays on the original round.
UPDATE _mig0016_block_map m SET target_round_id = m.source_round_id WHERE m.segment_index = 0;

UPDATE rounds r
SET type = m.target_type, updated_at = NOW()
FROM (SELECT DISTINCT source_round_id, target_type FROM _mig0016_block_map WHERE segment_index = 0) m
WHERE r.id = m.source_round_id;

-- A round that never had any content has nothing to infer a type from. It becomes an
-- empty PRESENTATIE round rather than being deleted or guessed at.
UPDATE rounds SET type = 'PRESENTATIE', updated_at = NOW() WHERE type IS NULL;

INSERT INTO _mig0016_round_order (round_id, game_night_id, order_key)
SELECT id, game_night_id, sort_order * 1000.0 FROM rounds;

-- Every further segment becomes its own round, named after the type it carries so the
-- host can tell at a glance why their round became two.
DO $mig$
DECLARE
  seg RECORD;
  new_round_id BIGINT;
  new_status TEXT;
  next_sort INTEGER;
BEGIN
  next_sort := 1000000;
  FOR seg IN
    SELECT DISTINCT ON (m.source_round_id, m.segment_index)
      m.source_round_id, m.segment_index, m.segment_key, m.target_type, m.game_night_id,
      r.title, r.description, r.status, r.sort_order
    FROM _mig0016_block_map m
    JOIN rounds r ON r.id = m.source_round_id
    WHERE m.segment_index > 0
    ORDER BY m.source_round_id, m.segment_index
  LOOP
    -- The one-active-round-per-game index allows a single ACTIVE round, and the original
    -- round keeps that status. A split-off piece of an active round therefore starts as
    -- UPCOMING: the host decides when to play it.
    new_status := CASE WHEN seg.status = 'COMPLETED' THEN 'COMPLETED' ELSE 'UPCOMING' END;

    next_sort := next_sort + 1;
    INSERT INTO rounds (game_night_id, sort_order, title, description, status, type, instructions, default_points, created_at, updated_at)
    VALUES (
      seg.game_night_id,
      next_sort,
      left(seg.title || ' — ' || seg.target_type, 200),
      seg.description,
      new_status,
      seg.target_type,
      '',
      10,
      NOW(), NOW()
    )
    RETURNING id INTO new_round_id;

    UPDATE _mig0016_block_map
    SET target_round_id = new_round_id
    WHERE source_round_id = seg.source_round_id AND segment_index = seg.segment_index;

    INSERT INTO _mig0016_round_order (round_id, game_night_id, order_key)
    VALUES (new_round_id, seg.game_night_id, seg.sort_order * 1000.0 + seg.segment_index);

    INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
    VALUES (
      '0016_round_is_the_content', seg.game_night_id, 'round_split', seg.source_round_id,
      format(
        'Round %s ("%s") mixed content types. Its %s content was moved to new round %s ("%s"), status %s.',
        seg.source_round_id, seg.title, seg.target_type, new_round_id,
        seg.title || ' — ' || seg.target_type, new_status
      )
    );
  END LOOP;
END
$mig$;

ALTER TABLE rounds ALTER COLUMN type SET NOT NULL;
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_type_check;
ALTER TABLE rounds ADD CONSTRAINT rounds_type_check
  CHECK (type IN ('LIVE_QUIZ','PRESENTATIE','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

-- ---------------------------------------------------------------------------
-- 5. Convert block payloads into typed rows
-- ---------------------------------------------------------------------------
--
-- Each converted row remembers the block it came from for the length of this migration,
-- which is how the runtime tables below find their new parent. The columns are dropped
-- again at the end: they are scaffolding, not part of the model.

ALTER TABLE live_quiz_questions ADD COLUMN _source_block_id BIGINT;
ALTER TABLE presentation_slides ADD COLUMN _source_block_id BIGINT;

-- LIVE_QUIZ ----------------------------------------------------------------
INSERT INTO live_quiz_questions (
  game_night_id, round_id, sort_order, prompt, body, points, context_media_key,
  created_at, updated_at, _source_block_id
)
SELECT
  b.game_night_id,
  m.target_round_id,
  m.block_order,
  COALESCE(NULLIF(btrim(b.title), ''), 'Vraag'),
  COALESCE(b.payload->>'body', ''),
  -- rewardCoins was the authored reward per question and keeps that meaning as points.
  GREATEST(0, COALESCE((b.payload->>'rewardCoins')::int, 10)),
  NULLIF(btrim(COALESCE(b.payload->>'contextImageKey', '')), ''),
  b.created_at, b.updated_at, b.id
FROM round_blocks b
JOIN _mig0016_block_map m ON m.block_id = b.id
WHERE b.type = 'DUOLINGO_QUESTION';

-- The four answers become four option rows. `correctAnswerIndex` becomes an is_correct
-- flag on one of them — the new model allows several, this data never had more than one.
INSERT INTO live_quiz_question_options (question_id, game_night_id, sort_order, text, is_correct)
SELECT
  q.id,
  q.game_night_id,
  answer.ordinality - 1,
  COALESCE(answer.value #>> '{}', ''),
  (answer.ordinality - 1) = COALESCE((b.payload->>'correctAnswerIndex')::int, 0)
FROM live_quiz_questions q
JOIN round_blocks b ON b.id = q._source_block_id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.payload->'answers') = 'array'
       THEN b.payload->'answers'
       ELSE '["","","",""]'::jsonb END
) WITH ORDINALITY AS answer(value, ordinality)
WHERE answer.ordinality <= 6;

INSERT INTO live_quiz_question_state (
  question_id, game_night_id, round_id, status, opened_at, closed_at, revealed_at, settled_at
)
SELECT
  q.id, q.game_night_id, q.round_id,
  CASE WHEN b.interactive_status IN ('READY','OPEN','CLOSED','REVEALED','SETTLED')
       THEN b.interactive_status ELSE 'READY' END,
  b.opened_at, b.closed_at, b.revealed_at, b.settled_at
FROM live_quiz_questions q
JOIN round_blocks b ON b.id = q._source_block_id;

-- PRESENTATIE --------------------------------------------------------------
-- What made these six types different was which fields they used and whether their
-- answer was secret, so that is what carries across. PICTURE and MUSIC titles are the
-- answer itself, which is why they keep hiding until the host reveals.
INSERT INTO presentation_slides (
  game_night_id, round_id, sort_order, title, body,
  media_key, media_kind, media_name, reveal_text, hide_title_until_reveal,
  created_at, updated_at, _source_block_id
)
SELECT
  b.game_night_id,
  m.target_round_id,
  m.block_order,
  NULLIF(btrim(COALESCE(b.title, '')), ''),
  COALESCE(b.payload->>'body', ''),
  CASE b.type
    WHEN 'PICTURE' THEN NULLIF(btrim(COALESCE(b.payload->>'imageKey', '')), '')
    WHEN 'MUSIC'   THEN NULLIF(btrim(COALESCE(b.payload->>'audioKey', '')), '')
  END,
  CASE
    WHEN b.type = 'PICTURE' AND NULLIF(btrim(COALESCE(b.payload->>'imageKey', '')), '') IS NOT NULL THEN 'IMAGE'
    WHEN b.type = 'MUSIC'   AND NULLIF(btrim(COALESCE(b.payload->>'audioKey', '')), '') IS NOT NULL THEN 'AUDIO'
  END,
  CASE WHEN b.type = 'MUSIC' THEN NULLIF(btrim(COALESCE(b.payload->>'audioName', '')), '') END,
  -- A wager round's correct answer is exactly what reveal_text is for.
  CASE WHEN b.type = 'WAGER' THEN NULLIF(btrim(COALESCE(b.payload->>'correctAnswer', '')), '') END,
  b.type IN ('PICTURE','MUSIC'),
  b.created_at, b.updated_at, b.id
FROM round_blocks b
JOIN _mig0016_block_map m ON m.block_id = b.id
WHERE b.type IN ('TEXT','QUESTION','PICTURE','MUSIC','BUZZER','WAGER');

INSERT INTO presentation_slide_state (slide_id, game_night_id, round_id, revealed_at)
SELECT s.id, s.game_night_id, s.round_id, b.revealed_at
FROM presentation_slides s
JOIN round_blocks b ON b.id = s._source_block_id;

-- FOTORONDE ----------------------------------------------------------------
INSERT INTO fotoronde_subjects (game_night_id, round_id, sort_order, subject_key, label, points)
SELECT
  b.game_night_id,
  m.target_round_id,
  subject.ordinality - 1,
  -- The key is the identity photos are filed under, so it is taken verbatim where the
  -- payload had one. Only a payload without a key falls back to a positional key.
  COALESCE(
    NULLIF(btrim(COALESCE(subject.value->>'key', '')), ''),
    'subject-' || (subject.ordinality - 1)
  ),
  COALESCE(NULLIF(btrim(COALESCE(subject.value->>'label', '')), ''), 'Onderwerp ' || subject.ordinality),
  10
FROM round_blocks b
JOIN _mig0016_block_map m ON m.block_id = b.id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.payload->'subjects') = 'array' AND jsonb_array_length(b.payload->'subjects') > 0
       THEN b.payload->'subjects'
       ELSE '[]'::jsonb END
) WITH ORDINALITY AS subject(value, ordinality)
WHERE b.type = 'FOTORONDE'
ON CONFLICT (round_id, subject_key) DO NOTHING;

-- SLOTMACHINE --------------------------------------------------------------
INSERT INTO slotmachine_rounds (round_id, game_night_id, max_spins)
SELECT
  m.target_round_id, b.game_night_id,
  LEAST(10, GREATEST(1, COALESCE((b.payload->>'maxSpins')::int, 10)))
FROM round_blocks b
JOIN _mig0016_block_map m ON m.block_id = b.id
WHERE b.type = 'SLOTMACHINE'
ON CONFLICT (round_id) DO NOTHING;

-- Only ids that still resolve to a player of this game. An allowlist naming a deleted
-- player would silently shrink who may play, which is worse than dropping the entry and
-- saying so in the notes.
INSERT INTO slotmachine_round_participants (round_id, game_night_id, player_id)
SELECT DISTINCT m.target_round_id, b.game_night_id, p.id
FROM round_blocks b
JOIN _mig0016_block_map m ON m.block_id = b.id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.payload->'allowedPlayerIds') = 'array'
       THEN b.payload->'allowedPlayerIds' ELSE '[]'::jsonb END
) AS allowed(value)
JOIN players p ON p.id = (allowed.value #>> '{}')::bigint AND p.game_night_id = b.game_night_id
WHERE b.type = 'SLOTMACHINE'
ON CONFLICT DO NOTHING;

INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
SELECT '0016_round_is_the_content', b.game_night_id, 'slot_participant_dropped', m.target_round_id,
  format('Slotmachine allowlist on block %s named player %s, who does not exist in this game; the entry was dropped.',
         b.id, allowed.value #>> '{}')
FROM round_blocks b
JOIN _mig0016_block_map m ON m.block_id = b.id
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(b.payload->'allowedPlayerIds') = 'array'
       THEN b.payload->'allowedPlayerIds' ELSE '[]'::jsonb END
) AS allowed(value)
WHERE b.type = 'SLOTMACHINE'
  AND NOT EXISTS (
    SELECT 1 FROM players p
    WHERE p.id = (allowed.value #>> '{}')::bigint AND p.game_night_id = b.game_night_id
  );

-- Round-level authored settings ---------------------------------------------
-- The instruction text every game type kept in `payload.body` is a property of the round
-- now that a round is one game.
UPDATE rounds r
SET instructions = COALESCE(b.payload->>'body', ''), updated_at = NOW()
FROM _mig0016_block_map m
JOIN round_blocks b ON b.id = m.block_id
WHERE r.id = m.target_round_id
  AND b.type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE')
  AND COALESCE(b.payload->>'body', '') <> '';

-- A split-off game round is better named after the block it carries than after the round
-- it was cut out of.
UPDATE rounds r
SET title = left(btrim(b.title), 200), updated_at = NOW()
FROM _mig0016_block_map m
JOIN round_blocks b ON b.id = m.block_id
WHERE r.id = m.target_round_id
  AND m.segment_index > 0
  AND b.type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE')
  AND NULLIF(btrim(COALESCE(b.title, '')), '') IS NOT NULL;

-- Pak een Zes paid one game-wide rate per correct prediction. That is a per-round
-- authored reward now, seeded from the game-wide value so nothing changes in practice.
UPDATE rounds r
SET default_points = GREATEST(0, COALESCE(g.pak_een_zes_points_per_correct, 25)), updated_at = NOW()
FROM game_nights g
WHERE g.id = r.game_night_id AND r.type = 'PAK_EEN_ZES';

-- A quiz round's default is whatever its questions already pay on average, so adding a
-- question to an imported round starts from a familiar number rather than from 10.
UPDATE rounds r
SET default_points = sub.avg_points, updated_at = NOW()
FROM (
  SELECT round_id, GREATEST(0, ROUND(AVG(points))::int) AS avg_points
  FROM live_quiz_questions GROUP BY round_id
) sub
WHERE r.id = sub.round_id;

-- ---------------------------------------------------------------------------
-- 6. Repoint runtime state from blocks to rounds
-- ---------------------------------------------------------------------------
--
-- Every runtime table already carried a `round_id` alongside `round_block_id`, but that
-- id names the round *before* the split and can now be the wrong one. The block map is
-- authoritative, so each table is repointed from it rather than trusting the column that
-- is already there.

UPDATE roulette_games t SET round_id = m.target_round_id, updated_at = NOW()
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

UPDATE slot_series t SET round_id = m.target_round_id
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

UPDATE slot_spins t SET round_id = m.target_round_id
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

UPDATE pak_een_zes_games t SET round_id = m.target_round_id, updated_at = NOW()
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

UPDATE pak_een_zes_draws t SET round_id = m.target_round_id
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

UPDATE photo_rounds t SET round_id = m.target_round_id, updated_at = NOW()
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

UPDATE photo_submissions t SET round_id = m.target_round_id, updated_at = NOW()
FROM _mig0016_block_map m WHERE m.block_id = t.round_block_id;

-- Ledger attribution follows the game it paid for. Leaving it on the pre-split round
-- would leave a SLOT_PAYOUT filed under a round whose slot series now lives elsewhere,
-- which is a worse kind of wrong than a renumbered round.
UPDATE ledger_entries l SET attributed_round_id = m.target_round_id
FROM _mig0016_block_map m
WHERE m.block_id = l.round_block_id AND l.attributed_round_id IS DISTINCT FROM m.target_round_id;

INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
SELECT DISTINCT '0016_round_is_the_content', m.game_night_id, 'ledger_reattributed', m.target_round_id,
  format('Ledger rows attributed to block %s were re-attributed to round %s after the split.', m.block_id, m.target_round_id)
FROM _mig0016_block_map m
JOIN ledger_entries l ON l.round_block_id = m.block_id
WHERE m.segment_index > 0;

-- The one-live-game-per-block indexes become one-live-game-per-round.
DROP INDEX IF EXISTS one_live_pak_een_zes_per_block;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_pak_een_zes_per_round
  ON pak_een_zes_games(round_id)
  WHERE status IN ('READY','PREDICTING','LOCKED','DRAWING');

DROP INDEX IF EXISTS one_photo_round_per_block;
CREATE UNIQUE INDEX IF NOT EXISTS one_photo_round_per_round
  ON photo_rounds(round_id);

DROP INDEX IF EXISTS one_active_slot_series_per_player_block;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot_series_per_player_round
  ON slot_series(round_id, player_id)
  WHERE status = 'ACTIVE';

DROP INDEX IF EXISTS slot_series_by_block_status;
CREATE INDEX IF NOT EXISTS slot_series_by_round_status ON slot_series(round_id, status);
DROP INDEX IF EXISTS slot_spins_by_block_time;
CREATE INDEX IF NOT EXISTS slot_spins_by_round_time ON slot_spins(round_id, spun_at DESC, id DESC);

-- Quiz answers -------------------------------------------------------------
-- `round_question_answers` becomes `quiz_answers`, keyed to the question rather than to
-- the block, and to the option the player picked rather than to an index into a JSON
-- array that no longer exists.
ALTER TABLE round_question_answers RENAME TO quiz_answers;

ALTER TABLE quiz_answers
  ADD COLUMN IF NOT EXISTS question_id BIGINT REFERENCES live_quiz_questions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS option_id BIGINT REFERENCES live_quiz_question_options(id) ON DELETE CASCADE;

UPDATE quiz_answers a SET question_id = q.id
FROM live_quiz_questions q WHERE q._source_block_id = a.round_block_id;

UPDATE quiz_answers a SET option_id = o.id
FROM live_quiz_question_options o
WHERE o.question_id = a.question_id AND o.sort_order = a.selected_answer;

-- An answer whose question did not survive has nothing left to mean.
DELETE FROM quiz_answers WHERE question_id IS NULL;

INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
SELECT '0016_round_is_the_content', game_night_id, 'quiz_answers_without_option', question_id,
  format('Answer %s pointed at answer index %s, which no option row matched; the answer is kept but scores as incorrect.', id, selected_answer)
FROM quiz_answers WHERE option_id IS NULL;

ALTER TABLE quiz_answers ALTER COLUMN question_id SET NOT NULL;
ALTER TABLE quiz_answers DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE quiz_answers DROP COLUMN IF EXISTS selected_answer;
ALTER TABLE quiz_answers DROP CONSTRAINT IF EXISTS round_question_answers_round_block_id_player_id_key;
ALTER TABLE quiz_answers DROP CONSTRAINT IF EXISTS quiz_answers_question_player_key;
ALTER TABLE quiz_answers ADD CONSTRAINT quiz_answers_question_player_key UNIQUE (question_id, player_id);
CREATE INDEX IF NOT EXISTS quiz_answers_by_question ON quiz_answers(question_id);

-- Ledger: question rewards key off the question ------------------------------
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS quiz_question_id BIGINT REFERENCES live_quiz_questions(id) ON DELETE SET NULL;

UPDATE ledger_entries l SET quiz_question_id = q.id
FROM live_quiz_questions q WHERE q._source_block_id = l.round_block_id;

DROP INDEX IF EXISTS ledger_unique_question_reward;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_quiz_reward
  ON ledger_entries(quiz_question_id, player_id, transaction_type)
  WHERE quiz_question_id IS NOT NULL AND transaction_type = 'QUESTION_REWARD';

-- ---------------------------------------------------------------------------
-- 7. Screen state: typed pointers instead of a JSON blockId
-- ---------------------------------------------------------------------------
--
-- Presentation stays independent of progression — starting a round still changes nothing
-- here — but what it points at is now a column with a foreign key rather than a number
-- fished out of a JSON payload.

ALTER TABLE screen_state
  ADD COLUMN IF NOT EXISTS quiz_question_id BIGINT REFERENCES live_quiz_questions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS slide_id BIGINT REFERENCES presentation_slides(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staged_quiz_question_id BIGINT REFERENCES live_quiz_questions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staged_slide_id BIGINT REFERENCES presentation_slides(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_quiz_question_id BIGINT REFERENCES live_quiz_questions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS previous_slide_id BIGINT REFERENCES presentation_slides(id) ON DELETE SET NULL;

-- Carry whatever was on screen across to the new pointers before the old mode names stop
-- being legal values.
UPDATE screen_state s SET quiz_question_id = q.id
FROM live_quiz_questions q WHERE q._source_block_id = (s.payload->>'blockId')::bigint;
UPDATE screen_state s SET slide_id = p.id
FROM presentation_slides p WHERE p._source_block_id = (s.payload->>'blockId')::bigint;
UPDATE screen_state s SET staged_quiz_question_id = q.id
FROM live_quiz_questions q WHERE q._source_block_id = (s.staged_payload->>'blockId')::bigint;
UPDATE screen_state s SET staged_slide_id = p.id
FROM presentation_slides p WHERE p._source_block_id = (s.staged_payload->>'blockId')::bigint;
UPDATE screen_state s SET previous_quiz_question_id = q.id
FROM live_quiz_questions q WHERE q._source_block_id = (s.previous_payload->>'blockId')::bigint;
UPDATE screen_state s SET previous_slide_id = p.id
FROM presentation_slides p WHERE p._source_block_id = (s.previous_payload->>'blockId')::bigint;

-- The round each pointer belongs to follows the split too.
UPDATE screen_state s SET round_id = q.round_id FROM live_quiz_questions q WHERE q.id = s.quiz_question_id;
UPDATE screen_state s SET round_id = p.round_id FROM presentation_slides p WHERE p.id = s.slide_id;
UPDATE screen_state s SET staged_round_id = q.round_id FROM live_quiz_questions q WHERE q.id = s.staged_quiz_question_id;
UPDATE screen_state s SET staged_round_id = p.round_id FROM presentation_slides p WHERE p.id = s.staged_slide_id;
UPDATE screen_state s SET previous_round_id = q.round_id FROM live_quiz_questions q WHERE q.id = s.previous_quiz_question_id;
UPDATE screen_state s SET previous_round_id = p.round_id FROM presentation_slides p WHERE p.id = s.previous_slide_id;

-- The old mode names stop being legal in a moment, so the constraints come off before
-- the rows are rewritten rather than after.
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_mode_check;
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_staged_mode_check;
ALTER TABLE screen_state DROP CONSTRAINT IF EXISTS screen_state_previous_mode_check;

-- A pointer at one of the four game blocks follows that block to the round it became,
-- so a staged roulette stays a staged roulette instead of collapsing to the dashboard.
UPDATE screen_state s SET mode = m.target_type, round_id = m.target_round_id
FROM _mig0016_block_map m
WHERE m.block_id = (s.payload->>'blockId')::bigint
  AND m.target_type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE');
UPDATE screen_state s SET staged_mode = m.target_type, staged_round_id = m.target_round_id
FROM _mig0016_block_map m
WHERE m.block_id = (s.staged_payload->>'blockId')::bigint
  AND m.target_type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE');
UPDATE screen_state s SET previous_mode = m.target_type, previous_round_id = m.target_round_id
FROM _mig0016_block_map m
WHERE m.block_id = (s.previous_payload->>'blockId')::bigint
  AND m.target_type IN ('ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE');

-- ROUND_BLOCK split into the two scenes that can actually present a round: a quiz
-- question and a presentation slide. What is left over pointed at nothing that survived,
-- so it falls back to the dashboard with no round attached.
UPDATE screen_state SET mode = CASE
  WHEN mode = 'ROUND_BLOCK' AND quiz_question_id IS NOT NULL THEN 'QUIZ_QUESTION'
  WHEN mode = 'ROUND_BLOCK' AND slide_id IS NOT NULL THEN 'SLIDE'
  WHEN mode = 'ROUND_BLOCK' THEN 'DASHBOARD'
  ELSE mode END;
UPDATE screen_state SET round_id = NULL WHERE mode = 'DASHBOARD';
UPDATE screen_state SET staged_mode = CASE
  WHEN staged_mode = 'ROUND_BLOCK' AND staged_quiz_question_id IS NOT NULL THEN 'QUIZ_QUESTION'
  WHEN staged_mode = 'ROUND_BLOCK' AND staged_slide_id IS NOT NULL THEN 'SLIDE'
  WHEN staged_mode = 'ROUND_BLOCK' THEN 'DASHBOARD'
  ELSE staged_mode END;
UPDATE screen_state SET staged_round_id = NULL WHERE staged_mode = 'DASHBOARD';
UPDATE screen_state SET previous_mode = CASE
  WHEN previous_mode = 'ROUND_BLOCK' AND previous_quiz_question_id IS NOT NULL THEN 'QUIZ_QUESTION'
  WHEN previous_mode = 'ROUND_BLOCK' AND previous_slide_id IS NOT NULL THEN 'SLIDE'
  WHEN previous_mode = 'ROUND_BLOCK' THEN 'DASHBOARD'
  ELSE previous_mode END;
UPDATE screen_state SET previous_round_id = NULL WHERE previous_mode = 'DASHBOARD';

-- blockId is gone from the payload; what stays is genuinely presentational — which photo
-- of a Fotoronde is currently enlarged on the projector.
UPDATE screen_state SET
  payload = (payload - 'blockId') - 'questionContextPhotoBlockId',
  staged_payload = (staged_payload - 'blockId') - 'questionContextPhotoBlockId',
  previous_payload = (previous_payload - 'blockId') - 'questionContextPhotoBlockId';

ALTER TABLE screen_state ADD CONSTRAINT screen_state_mode_check
  CHECK (mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
ALTER TABLE screen_state ADD CONSTRAINT screen_state_staged_mode_check
  CHECK (staged_mode IS NULL OR staged_mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));
ALTER TABLE screen_state ADD CONSTRAINT screen_state_previous_mode_check
  CHECK (previous_mode IS NULL OR previous_mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));


ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_current_screen_mode_check;
UPDATE game_nights SET current_screen_mode = 'DASHBOARD' WHERE current_screen_mode = 'ROUND_BLOCK';
ALTER TABLE game_nights ADD CONSTRAINT game_nights_current_screen_mode_check
  CHECK (current_screen_mode IN ('DASHBOARD','QUIZ_QUESTION','SLIDE','PREDICTIONS_OPEN','PREDICTION_LOCKED','PREDICTION_RESULT','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'));

-- ---------------------------------------------------------------------------
-- 8. Seed the per-round runtime cursor
-- ---------------------------------------------------------------------------

INSERT INTO round_runtime (round_id, game_night_id)
SELECT id, game_night_id FROM rounds
ON CONFLICT (round_id) DO NOTHING;

-- An upgraded game opens on the step it was already on.
UPDATE round_runtime rt SET current_quiz_question_id = s.quiz_question_id
FROM screen_state s WHERE s.game_night_id = rt.game_night_id AND s.quiz_question_id IS NOT NULL
  AND rt.round_id = (SELECT round_id FROM live_quiz_questions WHERE id = s.quiz_question_id);
UPDATE round_runtime rt SET current_slide_id = s.slide_id
FROM screen_state s WHERE s.game_night_id = rt.game_night_id AND s.slide_id IS NOT NULL
  AND rt.round_id = (SELECT round_id FROM presentation_slides WHERE id = s.slide_id);

-- Otherwise the cursor sits on the round's first item, so a round that has never been
-- played still has somewhere to start.
UPDATE round_runtime rt SET current_quiz_question_id = first.id
FROM (SELECT DISTINCT ON (round_id) round_id, id FROM live_quiz_questions ORDER BY round_id, sort_order, id) first
WHERE first.round_id = rt.round_id AND rt.current_quiz_question_id IS NULL;
UPDATE round_runtime rt SET current_slide_id = first.id
FROM (SELECT DISTINCT ON (round_id) round_id, id FROM presentation_slides ORDER BY round_id, sort_order, id) first
WHERE first.round_id = rt.round_id AND rt.current_slide_id IS NULL;

-- ---------------------------------------------------------------------------
-- 9. Renumber rounds so the split ones sit where their content used to be
-- ---------------------------------------------------------------------------
--
-- Two passes, because (game_night_id, sort_order) is unique and a single UPDATE would
-- collide with the rows it has not renumbered yet.

UPDATE rounds SET sort_order = sort_order + 2000000;

UPDATE rounds r SET sort_order = ranked.position, updated_at = NOW()
FROM (
  SELECT o.round_id, ROW_NUMBER() OVER (PARTITION BY o.game_night_id ORDER BY o.order_key, o.round_id) AS position
  FROM _mig0016_round_order o
) ranked
WHERE r.id = ranked.round_id;

-- Defensive: a round that somehow never reached the ordering table still needs a number
-- inside the normal range, placed after everything that did.
WITH highest AS (
  SELECT game_night_id, COALESCE(MAX(sort_order), 0) AS top
  FROM rounds WHERE sort_order < 2000000 GROUP BY game_night_id
), leftovers AS (
  SELECT r.id, r.game_night_id,
         ROW_NUMBER() OVER (PARTITION BY r.game_night_id ORDER BY r.id) AS offset_position
  FROM rounds r WHERE r.sort_order >= 2000000
)
UPDATE rounds r
SET sort_order = COALESCE(h.top, 0) + l.offset_position, updated_at = NOW()
FROM leftovers l LEFT JOIN highest h ON h.game_night_id = l.game_night_id
WHERE r.id = l.id;

-- ---------------------------------------------------------------------------
-- 10. Drop the block architecture
-- ---------------------------------------------------------------------------
--
-- Everything above has taken what it needs. `round_blocks_archive` keeps the originals,
-- so this removes the model, not the record.

ALTER TABLE ledger_entries DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE roulette_games DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE slot_series DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE slot_spins DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE pak_een_zes_games DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE pak_een_zes_draws DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE photo_rounds DROP COLUMN IF EXISTS round_block_id;
ALTER TABLE photo_submissions DROP COLUMN IF EXISTS round_block_id;

ALTER TABLE game_nights DROP CONSTRAINT IF EXISTS game_nights_current_round_block_fk;
ALTER TABLE game_nights DROP COLUMN IF EXISTS current_round_block_id;

-- Pak een Zes pays a per-round rate now, read from rounds.default_points.
ALTER TABLE game_nights DROP COLUMN IF EXISTS pak_een_zes_points_per_correct;

DROP TABLE IF EXISTS round_blocks CASCADE;

ALTER TABLE live_quiz_questions DROP COLUMN _source_block_id;
ALTER TABLE presentation_slides DROP COLUMN _source_block_id;

DROP TABLE _mig0016_block_map;
DROP TABLE _mig0016_round_order;

-- ---------------------------------------------------------------------------
-- 11. Invariants the new model depends on
-- ---------------------------------------------------------------------------

-- Unchanged in meaning, restated here because it is the invariant the round lifecycle
-- is built on and this migration is where rounds became the primary object.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_round_per_game
  ON rounds(game_night_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS rounds_by_game_type ON rounds(game_night_id, type, sort_order);

-- Content may only hang off a round of the matching type. Enforced with a trigger rather
-- than a CHECK because the type lives on the parent row; without it a quiz question could
-- be inserted against a roulette round and no constraint would object.
CREATE OR REPLACE FUNCTION assert_round_type() RETURNS TRIGGER AS $fn$
DECLARE
  actual TEXT;
  expected TEXT := TG_ARGV[0];
BEGIN
  SELECT type INTO actual FROM rounds WHERE id = NEW.round_id;
  IF actual IS NULL THEN
    RAISE EXCEPTION 'Round % does not exist', NEW.round_id;
  END IF;
  IF actual <> expected THEN
    RAISE EXCEPTION '% content cannot be added to a % round', expected, actual
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS live_quiz_questions_round_type ON live_quiz_questions;
CREATE TRIGGER live_quiz_questions_round_type
  BEFORE INSERT OR UPDATE OF round_id ON live_quiz_questions
  FOR EACH ROW EXECUTE FUNCTION assert_round_type('LIVE_QUIZ');

DROP TRIGGER IF EXISTS presentation_slides_round_type ON presentation_slides;
CREATE TRIGGER presentation_slides_round_type
  BEFORE INSERT OR UPDATE OF round_id ON presentation_slides
  FOR EACH ROW EXECUTE FUNCTION assert_round_type('PRESENTATIE');

DROP TRIGGER IF EXISTS fotoronde_subjects_round_type ON fotoronde_subjects;
CREATE TRIGGER fotoronde_subjects_round_type
  BEFORE INSERT OR UPDATE OF round_id ON fotoronde_subjects
  FOR EACH ROW EXECUTE FUNCTION assert_round_type('FOTORONDE');

DROP TRIGGER IF EXISTS slotmachine_rounds_round_type ON slotmachine_rounds;
CREATE TRIGGER slotmachine_rounds_round_type
  BEFORE INSERT OR UPDATE OF round_id ON slotmachine_rounds
  FOR EACH ROW EXECUTE FUNCTION assert_round_type('SLOTMACHINE');

-- A summary line per game, so the host can be told what happened to their evening
-- rather than discovering it.
INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
SELECT '0016_round_is_the_content', g.id, 'summary', g.id,
  format('Converted to typed rounds: %s rounds, %s quiz questions, %s slides, %s Fotoronde subjects.',
    (SELECT COUNT(*) FROM rounds WHERE game_night_id = g.id),
    (SELECT COUNT(*) FROM live_quiz_questions WHERE game_night_id = g.id),
    (SELECT COUNT(*) FROM presentation_slides WHERE game_night_id = g.id),
    (SELECT COUNT(*) FROM fotoronde_subjects WHERE game_night_id = g.id))
FROM game_nights g;
