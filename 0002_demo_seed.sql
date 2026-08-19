INSERT INTO game_nights (id, name, date, status, starting_balance, game_state_version, current_screen_mode)
VALUES (1, 'Market Mayhem Demo', CURRENT_DATE, 'ACTIVE', 100, 1, 'DASHBOARD')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('game_nights','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM game_nights), 1));

INSERT INTO teams (id, game_night_id, name, color, notes) VALUES
  (1, 1, 'Squad Lime', '#DFF24C', 'Fast, loud, optimistic.'),
  (2, 1, 'Team Purple', '#9B2FF2', 'Chaos with spreadsheets.')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('teams','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM teams), 1));

INSERT INTO players (id, game_night_id, display_name, team_id, public_color, admin_notes) VALUES
  (1,1,'Daan',1,'#3D5AFE','Checks every number twice and loves a value bet.'),
  (2,1,'Bas',1,'#DFF24C','Very competitive. Give a harder capitals list next round.'),
  (3,1,'Jorrit',2,'#9B2FF2','Likes aggressive bets and dramatic reveals.'),
  (4,1,'Twan',2,'#FF3FC0','Strong under time pressure; suspiciously good at geography.')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('players','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM players), 1));

INSERT INTO rounds (id, game_night_id, round_number, title, description, status, started_at, completed_at) VALUES
  (1,1,1,'Opening','Kickoff and rules','COMPLETED',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour 51 minutes'),
  (2,1,2,'Queen Race','Physical race round','COMPLETED',NOW()-INTERVAL '1 hour 48 minutes',NOW()-INTERVAL '1 hour 30 minutes'),
  (3,1,3,'Who Said It','Quote guessing','COMPLETED',NOW()-INTERVAL '1 hour 27 minutes',NOW()-INTERVAL '1 hour 13 minutes'),
  (4,1,4,'Spelling','Spelling round','UPCOMING',NULL,NULL),
  (5,1,5,'Charades','Silent acting round','UPCOMING',NULL,NULL),
  (6,1,6,'Blind Taste Test','Taste and identify','COMPLETED',NOW()-INTERVAL '1 hour 10 minutes',NOW()-INTERVAL '57 minutes'),
  (7,1,7,'Spelling Bee','Pressure spelling','ACTIVE',NOW()-INTERVAL '54 minutes',NULL),
  (8,1,8,'Grand Finale','Final round','UPCOMING',NULL,NULL)
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('rounds','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM rounds), 1));
UPDATE game_nights SET current_round_id = 7 WHERE id = 1;

INSERT INTO wallets (player_id, game_night_id, current_balance) VALUES
  (1,1,288),(2,1,312),(3,1,210),(4,1,228)
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO ledger_entries (game_night_id, player_id, amount, transaction_type, description, attributed_round_id, created_by, metadata, created_at) VALUES
  (1,1,100,'STARTING_BALANCE','Starting balance',NULL,'seed','{}',NOW()-INTERVAL '2 hours 5 minutes'),
  (1,1,80,'ROUND_REWARD','Queen Race reward',2,'seed','{}',NOW()-INTERVAL '1 hour 31 minutes'),
  (1,1,60,'ROUND_REWARD','Who Said It reward',3,'seed','{}',NOW()-INTERVAL '1 hour 14 minutes'),
  (1,1,48,'ROUND_REWARD','Blind Taste Test reward',6,'seed','{}',NOW()-INTERVAL '58 minutes'),
  (1,2,100,'STARTING_BALANCE','Starting balance',NULL,'seed','{}',NOW()-INTERVAL '2 hours 5 minutes'),
  (1,2,75,'ROUND_REWARD','Queen Race reward',2,'seed','{}',NOW()-INTERVAL '1 hour 32 minutes'),
  (1,2,117,'ROUND_REWARD','Who Said It reward',3,'seed','{}',NOW()-INTERVAL '1 hour 15 minutes'),
  (1,2,20,'ROUND_REWARD','Round 07 reward',7,'seed','{}',NOW()-INTERVAL '30 minutes'),
  (1,3,100,'STARTING_BALANCE','Starting balance',NULL,'seed','{}',NOW()-INTERVAL '2 hours 5 minutes'),
  (1,3,70,'ROUND_REWARD','Queen Race reward',2,'seed','{}',NOW()-INTERVAL '1 hour 33 minutes'),
  (1,3,50,'ROUND_REWARD','Who Said It reward',3,'seed','{}',NOW()-INTERVAL '1 hour 16 minutes'),
  (1,3,-10,'PENALTY','Jury penalty',7,'seed','{}',NOW()-INTERVAL '22 minutes'),
  (1,4,100,'STARTING_BALANCE','Starting balance',NULL,'seed','{}',NOW()-INTERVAL '2 hours 5 minutes'),
  (1,4,80,'ROUND_REWARD','Queen Race reward',2,'seed','{}',NOW()-INTERVAL '1 hour 34 minutes'),
  (1,4,55,'ROUND_REWARD','Who Said It reward',3,'seed','{}',NOW()-INTERVAL '1 hour 17 minutes'),
  (1,4,-7,'PENALTY','Speed penalty',7,'seed','{}',NOW()-INTERVAL '18 minutes');

INSERT INTO predictions (id, game_night_id, round_id, display_number, question, status)
VALUES (1,1,7,14,'Can Twan name 10 capitals within 30 seconds?','DRAFT')
ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('predictions','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM predictions), 1));

INSERT INTO screen_state (game_night_id, mode, round_id, prediction_id, payload, updated_by)
VALUES (1,'DASHBOARD',7,1,'{}','seed')
ON CONFLICT (game_night_id) DO NOTHING;

INSERT INTO player_codewords (player_id, codeword, assigned_at, completed_at, status) VALUES
  (2,'FALCON',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '90 minutes','COMPLETED'),
  (2,'MARBLE',NOW()-INTERVAL '90 minutes',NOW()-INTERVAL '45 minutes','COMPLETED'),
  (2,'PELICAN',NOW()-INTERVAL '45 minutes',NULL,'ACTIVE'),
  (1,'NEON',NOW()-INTERVAL '40 minutes',NULL,'ACTIVE'),
  (3,'ANCHOR',NOW()-INTERVAL '40 minutes',NULL,'ACTIVE'),
  (4,'COMET',NOW()-INTERVAL '40 minutes',NULL,'ACTIVE');

INSERT INTO player_timers (player_id, timer_duration_seconds, timer_status) VALUES
  (1,180,'RESET'),(2,180,'RESET'),(3,180,'RESET'),(4,180,'RESET')
ON CONFLICT DO NOTHING;

INSERT INTO player_join_tokens (game_night_id, player_id, token_hash, expires_at) VALUES
  (1,1,'c7d1ebf337476acb0ad8b8273def41b868b35f706054721fd6bd40767b71ec16',NOW()+INTERVAL '365 days'),
  (1,2,'eda78ef383dba741da1d98fb65b176e336d168deb9f709f6311194369b666a27',NOW()+INTERVAL '365 days'),
  (1,3,'9eeb5176f05a4b94d44e2427e23bd7f5d91f6bb40daaa71d04ff8d1cc9826dda',NOW()+INTERVAL '365 days'),
  (1,4,'faa42607139db6f04a47975f1f56e173df455a6df5c7902feecced3e9b36bcdb',NOW()+INTERVAL '365 days')
ON CONFLICT DO NOTHING;
