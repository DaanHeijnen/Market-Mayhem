-- 0017 — the ten standard players
--
-- Every game night is played by the same ten people, so they are part of the domain
-- rather than something the Admin retypes before each night. This migration gives a
-- player a stable identity independent of their name, gives a game night a latch that
-- says its players have been set up once, and seeds any night that has none yet.
--
-- The list itself also lives in netlify/lib/default-players.ts, which is what the
-- application uses. The two are kept in step by tests/default-players.test.ts, which
-- reads both and fails if they disagree — that test is the reason it is safe to write
-- the list twice.

-- ---------------------------------------------------------------------------
-- 1. A stable identity for a seeded player
-- ---------------------------------------------------------------------------
--
-- display_name is already unique per game night, but it is also editable and the
-- visible spelling is a presentation detail (Raúl carries an accent). Uniqueness for
-- "is this the standard Jordi" therefore hangs off a key the Admin never sees, so
-- renaming a player can never turn them into a second one.
ALTER TABLE players ADD COLUMN IF NOT EXISTS seed_key TEXT;

-- The invariant that makes initialization idempotent: whatever else happens, one game
-- night cannot hold two players with the same seed key. Partial, so the many players an
-- Admin adds by hand keep NULL and are not forced into a collision with each other.
CREATE UNIQUE INDEX IF NOT EXISTS players_unique_seed_key
  ON players (game_night_id, seed_key)
  WHERE seed_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The initialization latch
-- ---------------------------------------------------------------------------
--
-- Set once, when a night's players are first created. It is what separates "ensure
-- initial setup" from "reset to defaults": with it set, initialization is a no-op, so a
-- player the Admin deliberately removed stays removed instead of reappearing on the next
-- request. Only an explicit reset puts the full list back.
ALTER TABLE game_nights ADD COLUMN IF NOT EXISTS default_players_initialized_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. Adopt players who are already there under a default name
-- ---------------------------------------------------------------------------
--
-- An installation that already has a Bas or a Twan has the standard Bas and the standard
-- Twan — they were simply created by hand before this existed. Linking them here is what
-- keeps a later reset from adding a second one beside them, and it keeps their wallet,
-- their join link and their history attached to the same row.
--
-- Matching is case-insensitive on the exact spelling. A player recorded as "Raul" is
-- deliberately *not* adopted as "Raúl": the two are different names, and guessing that
-- they are the same person is exactly the kind of silent decision a migration should not
-- make. Such a night ends up with both, and the note below says so.
WITH defaults(seed_key, display_name) AS (VALUES
  ('default:jordi','Jordi'),
  ('default:wouter','Wouter'),
  ('default:bas','Bas'),
  ('default:boyen','Boyen'),
  ('default:david','David'),
  ('default:dries','Dries'),
  ('default:moise','Moise'),
  ('default:raul','Raúl'),
  ('default:tijs','Tijs'),
  ('default:twan','Twan')
)
UPDATE players p
SET seed_key = d.seed_key
FROM defaults d
WHERE p.seed_key IS NULL
  AND LOWER(p.display_name) = LOWER(d.display_name)
  -- display_name is already unique per night, so this can only ever be true when the
  -- column was somehow populated before. Cheap, and it keeps the unique index above
  -- from being the thing that discovers a problem.
  AND NOT EXISTS (
    SELECT 1 FROM players q WHERE q.game_night_id = p.game_night_id AND q.seed_key = d.seed_key
  );

-- ---------------------------------------------------------------------------
-- 4. Existing nights count as already initialized
-- ---------------------------------------------------------------------------
--
-- A night that is already being played has the roster its host wants. Seeding ten more
-- people into it would be this migration inventing game state, so instead the latch is
-- closed and the roster left exactly as it is. The host reaches the standard ten there
-- by running a reset, which is a decision rather than a side effect of deploying.
UPDATE game_nights g
SET default_players_initialized_at = NOW()
WHERE g.default_players_initialized_at IS NULL
  AND EXISTS (SELECT 1 FROM players p WHERE p.game_night_id = g.id);

-- What that decided, per night, so it is answerable later.
INSERT INTO migration_notes (migration, game_night_id, subject, subject_id, note)
SELECT '0017', g.id, 'game_night', g.id,
       'Night already had players, so the ten standard players were not seeded. ' ||
       (SELECT COUNT(*) FROM players p WHERE p.game_night_id = g.id AND p.seed_key IS NOT NULL)::text ||
       ' existing player(s) were adopted as standard players by name; the rest keep no seed key. ' ||
       'A Full Reset or Delete Game Save restores the full standard list.'
FROM game_nights g
WHERE EXISTS (SELECT 1 FROM players p WHERE p.game_night_id = g.id);

-- ---------------------------------------------------------------------------
-- 5. Seed the nights that have no players at all
-- ---------------------------------------------------------------------------
--
-- A fresh install is exactly this case: migration 0003 creates one empty game night, and
-- this is what puts the ten players in it, so the Admin never has to type them.
--
-- Wallet and opening ledger entry are written in the same statement as the player, which
-- is the financial invariant the rest of the app keeps: coins exist because a ledger
-- entry says so, and the wallet is its running total. 100 is the seeded starting balance
-- and is recorded per player in starting_balance_snapshot — the same column create-player
-- writes and the same one a reset reads back.
WITH defaults(seed_key, display_name, public_color, sort_index) AS (VALUES
  ('default:jordi','Jordi','#3D5AFE',0),
  ('default:wouter','Wouter','#DFF24C',1),
  ('default:bas','Bas','#9B2FF2',2),
  ('default:boyen','Boyen','#FF3FC0',3),
  ('default:david','David','#2FAF5B',4),
  ('default:dries','Dries','#E8352F',5),
  ('default:moise','Moise','#FF7A1E',6),
  ('default:raul','Raúl','#1FD8E0',7),
  ('default:tijs','Tijs','#F2B705',8),
  ('default:twan','Twan','#2A2820',9)
),
targets AS (
  SELECT id FROM game_nights WHERE default_players_initialized_at IS NULL
),
inserted AS (
  INSERT INTO players (game_night_id, display_name, public_color, active, starting_balance_snapshot, seed_key)
  SELECT t.id, d.display_name, d.public_color, TRUE, 100, d.seed_key
  FROM targets t CROSS JOIN defaults d
  ORDER BY t.id, d.sort_index
  RETURNING id, game_night_id, seed_key, starting_balance_snapshot
),
seeded_wallets AS (
  INSERT INTO wallets (player_id, game_night_id, current_balance)
  SELECT id, game_night_id, starting_balance_snapshot FROM inserted
  RETURNING player_id
)
INSERT INTO ledger_entries (game_night_id, player_id, amount, transaction_type, description, created_by, idempotency_key)
SELECT game_night_id, id, starting_balance_snapshot, 'STARTING_BALANCE', 'Starting balance', 'migration',
       'default-player:starting-balance:' || seed_key
FROM inserted
-- ledger_entries forbids a zero amount, so a zero starting balance simply has no opening
-- entry and its wallet is already correct. create-player and the reset path agree.
WHERE starting_balance_snapshot > 0;

-- Close the latch on everything that is now set up, seeded or adopted.
UPDATE game_nights SET default_players_initialized_at = NOW() WHERE default_players_initialized_at IS NULL;
