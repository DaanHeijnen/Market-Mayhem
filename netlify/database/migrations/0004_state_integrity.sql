-- Repair legacy round pointers/statuses before enforcing the one-active-round invariant.
WITH chosen AS (
  SELECT
    g.id AS game_night_id,
    COALESCE(
      CASE
        WHEN current_round.status = 'ACTIVE' AND current_round.game_night_id = g.id THEN current_round.id
      END,
      (
        SELECT r2.id
        FROM rounds r2
        WHERE r2.game_night_id = g.id AND r2.status = 'ACTIVE'
        ORDER BY r2.started_at NULLS LAST, r2.id
        LIMIT 1
      )
    ) AS active_round_id
  FROM game_nights g
  LEFT JOIN rounds current_round ON current_round.id = g.current_round_id
)
UPDATE rounds r
SET status = 'UPCOMING', updated_at = NOW()
FROM chosen c
WHERE r.game_night_id = c.game_night_id
  AND r.status = 'ACTIVE'
  AND r.id <> c.active_round_id;

WITH chosen AS (
  SELECT
    g.id AS game_night_id,
    (
      SELECT r.id
      FROM rounds r
      WHERE r.game_night_id = g.id AND r.status = 'ACTIVE'
      ORDER BY
        CASE WHEN r.id = g.current_round_id THEN 0 ELSE 1 END,
        r.started_at NULLS LAST,
        r.id
      LIMIT 1
    ) AS active_round_id
  FROM game_nights g
)
UPDATE game_nights g
SET current_round_id = c.active_round_id, updated_at = NOW()
FROM chosen c
WHERE g.id = c.game_night_id
  AND g.current_round_id IS DISTINCT FROM c.active_round_id;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_round_per_game
  ON rounds(game_night_id)
  WHERE status = 'ACTIVE';
