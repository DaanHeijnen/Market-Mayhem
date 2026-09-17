-- 0022 — eight spins per player, per slotmachine round
--
-- The ceiling was ten. Eight is the number the evening actually wants, and it belongs in
-- the database as well as in the code: the application constant stops a bad request, and
-- this stops a row that is already wrong.
--
-- Existing rounds authored for nine or ten are clamped rather than refused. A round is
-- prepared work, and failing the migration over a number the host can no longer even
-- enter would cost them the round to enforce a limit they never hit.
UPDATE slotmachine_rounds SET max_spins = 8 WHERE max_spins > 8;

ALTER TABLE slotmachine_rounds DROP CONSTRAINT IF EXISTS slotmachine_rounds_max_spins_check;
ALTER TABLE slotmachine_rounds ADD CONSTRAINT slotmachine_rounds_max_spins_check
  CHECK (max_spins BETWEEN 1 AND 8);

-- A series already sold is left exactly as it is. Its spins are paid for, some of them may
-- already be spun, and shrinking it here would either steal spins a player bought or
-- strand coins in a series that can no longer be finished. The new ceiling applies to
-- series locked from now on.
INSERT INTO migration_notes (migration, game_night_id, subject, note)
SELECT '0022', game_night_id, 'slot_series',
  'Slotmachine rounds are now capped at 8 spins per player. ' ||
  (SELECT COUNT(*) FROM slot_series s WHERE s.game_night_id = g.game_night_id AND s.total_spins > 8)::text ||
  ' series sold under the old ceiling were left untouched.'
FROM (SELECT DISTINCT game_night_id FROM slotmachine_rounds) g;
