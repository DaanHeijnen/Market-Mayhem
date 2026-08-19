ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS visible_to_players BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS one_visible_prediction_per_game
  ON predictions(game_night_id)
  WHERE visible_to_players = TRUE;

-- v1 shipped an exact demo dataset in migration 0002. Remove it only when it is
-- still recognisably untouched. Never delete game id 1 merely because of its id:
-- an upgraded installation may already be using that game for real data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM game_nights
    WHERE id = 1
      AND name = 'Market Mayhem Demo'
      AND starting_balance = 100
      AND game_state_version = 1
      AND current_round_id = 7
  )
  AND (SELECT COUNT(*) FROM players WHERE game_night_id = 1) = 4
  AND NOT EXISTS (
    SELECT 1 FROM players
    WHERE game_night_id = 1
      AND display_name NOT IN ('Daan', 'Bas', 'Jorrit', 'Twan')
  )
  AND (SELECT COUNT(*) FROM rounds WHERE game_night_id = 1) = 8
  AND (SELECT COUNT(*) FROM predictions WHERE game_night_id = 1) = 1
  AND (SELECT COUNT(*) FROM ledger_entries WHERE game_night_id = 1) = 16
  AND NOT EXISTS (
    SELECT 1 FROM bets b
    JOIN predictions p ON p.id = b.prediction_id
    WHERE p.game_night_id = 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM prediction_votes v
    JOIN predictions p ON p.id = v.prediction_id
    WHERE p.game_night_id = 1
  )
  AND NOT EXISTS (SELECT 1 FROM player_sessions WHERE game_night_id = 1)
  THEN
    DELETE FROM game_nights WHERE id = 1;
  END IF;
END $$;

-- Ensure a usable default game exists for a fresh database. Existing game 1 is
-- preserved exactly as-is.
INSERT INTO game_nights (
  id, name, date, status, starting_balance, game_state_version, current_screen_mode
) VALUES (
  1, 'Market Mayhem', CURRENT_DATE, 'ACTIVE', 100, 1, 'DASHBOARD'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO screen_state (game_night_id, mode, payload, updated_by)
VALUES (1, 'DASHBOARD', '{}'::jsonb, 'migration')
ON CONFLICT (game_night_id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('game_nights','id'),
  GREATEST((SELECT COALESCE(MAX(id),1) FROM game_nights), 1)
);
