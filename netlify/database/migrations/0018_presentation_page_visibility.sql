-- 0018 — a presentation page can be held back
--
-- A PRESENTATIE round is an ordered list of pages the host steps through on the projector.
-- Until now every page was part of that run: authoring a page you were not sure about, or
-- a spare you might not need, meant deleting it or stepping past it live in front of the
-- room.
--
-- `hidden` is the authored answer to that. A hidden page keeps its place, its content and
-- its order, stays fully editable in the Admin, and is simply not part of the run: normal
-- previous/next steps over it, and the projector refuses to point at it.
--
-- Deliberately on the authored row rather than in presentation_slide_state beside it.
-- State is runtime — a Full Reset clears it, which is right for "has the host revealed
-- this answer yet" and wrong for "is this page part of the evening". Visibility is a
-- decision the host made while building the night, so it survives a reset like every
-- other authored field.
--
-- Not to be confused with the two secrets a page can already hold: `reveal_text` and
-- `hide_title_until_reveal` decide what is withheld *on* a page that is being shown.
-- `hidden` decides whether the page is shown at all.
ALTER TABLE presentation_slides
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Navigation and the editor both read a round's pages in order and care which of them are
-- part of the run, so the ordering index carries the flag rather than sending the planner
-- back to the heap for it.
DROP INDEX IF EXISTS presentation_slides_by_round;
CREATE INDEX IF NOT EXISTS presentation_slides_by_round
  ON presentation_slides (round_id, sort_order) INCLUDE (hidden);

-- Nothing is hidden by everything that existed before this: a page that was part of the
-- run stays part of the run. The column default already says so, and it is spelled out
-- here because a migration that changes what the host sees on the projector should say
-- out loud when it changes nothing.
INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
SELECT '0018', r.game_night_id, 'round', r.id,
       'Presentation pages gained a hidden flag. Every existing page stays visible; ' ||
       (SELECT COUNT(*) FROM presentation_slides s WHERE s.round_id = r.id)::text ||
       ' page(s) in this round are unchanged.'
FROM rounds r
WHERE r.type = 'PRESENTATIE'
  AND EXISTS (SELECT 1 FROM presentation_slides s WHERE s.round_id = r.id);
