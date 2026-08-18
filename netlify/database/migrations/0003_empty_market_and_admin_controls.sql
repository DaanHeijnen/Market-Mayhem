ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS visible_to_players BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS one_visible_prediction_per_game
  ON predictions(game_night_id)
  WHERE visible_to_players = TRUE;

-- Replace the demo/seed game with a clean Market Mayhem game. This migration is
-- intentionally destructive for game id 1 because v1 shipped with demo data and
-- Market Mayhem should start empty on first real deployment.
DELETE FROM game_nights WHERE id = 1;

INSERT INTO game_nights (
  id, name, date, status, starting_balance, game_state_version, current_screen_mode
) VALUES (
  1, 'Market Mayhem', CURRENT_DATE, 'ACTIVE', 100, 1, 'DASHBOARD'
);

INSERT INTO screen_state (game_night_id, mode, payload, updated_by)
VALUES (1, 'DASHBOARD', '{}'::jsonb, 'migration');

SELECT setval(
  pg_get_serial_sequence('game_nights','id'),
  GREATEST((SELECT COALESCE(MAX(id),1) FROM game_nights), 1)
);
