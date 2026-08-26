-- Widen round_blocks.type for the four content types added by the Admin UX
-- redesign: picture rounds, music rounds, buzzer rounds and wager rounds.
--
-- Additive only. Existing rows keep their type, and the four new values are
-- simply now permitted.
--
-- Payload keys used by the new types (all optional, all stored in the existing
-- payload JSONB):
--   PICTURE : imageKey        - Netlify Blobs key, never the image bytes
--   MUSIC   : audioKey        - Netlify Blobs key
--             audioName       - original filename, shown to the Admin
--   WAGER   : correctAnswer   - free text, used to judge who wins their wager
--
-- BUZZER and WAGER are authorable and presentable but have no phone-side
-- interaction yet, matching the redesign, which specifies none for them.

ALTER TABLE round_blocks DROP CONSTRAINT IF EXISTS round_blocks_type_check;
ALTER TABLE round_blocks ADD CONSTRAINT round_blocks_type_check
  CHECK (type IN ('TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER'));
