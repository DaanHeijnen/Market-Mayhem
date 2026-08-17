CREATE TABLE game_nights (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','COMPLETED','ARCHIVED')),
  starting_balance INTEGER NOT NULL DEFAULT 100 CHECK (starting_balance >= 0),
  current_round_id BIGINT,
  game_state_version BIGINT NOT NULL DEFAULT 1,
  current_screen_mode TEXT NOT NULL DEFAULT 'DASHBOARD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE teams (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9B2FF2',
  notes TEXT,
  UNIQUE (game_night_id, name)
);

CREATE TABLE players (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  public_color TEXT NOT NULL DEFAULT '#3D5AFE',
  avatar_data JSONB,
  admin_notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_night_id, display_name)
);

CREATE TABLE player_join_tokens (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE player_sessions (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rounds (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'UPCOMING' CHECK (status IN ('UPCOMING','ACTIVE','COMPLETED')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_night_id, round_number)
);

ALTER TABLE game_nights
  ADD CONSTRAINT game_nights_current_round_fk
  FOREIGN KEY (current_round_id) REFERENCES rounds(id) ON DELETE SET NULL;

CREATE TABLE predictions (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  display_number INTEGER NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','VOTING','CALCULATING','BETTING','LOCKED','RESULT','SETTLED','CANCELLED')),
  crowd_yes_probability NUMERIC(6,5),
  crowd_no_probability NUMERIC(6,5),
  yes_odds NUMERIC(8,3),
  no_odds NUMERIC(8,3),
  result TEXT CHECK (result IN ('YES','NO','CANCEL') OR result IS NULL),
  voting_opened_at TIMESTAMPTZ,
  voting_closed_at TIMESTAMPTZ,
  betting_opened_at TIMESTAMPTZ,
  betting_closed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_night_id, display_number)
);

CREATE TABLE prediction_votes (
  id BIGSERIAL PRIMARY KEY,
  prediction_id BIGINT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  yes_probability INTEGER NOT NULL CHECK (yes_probability BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prediction_id, player_id)
);

CREATE TABLE bets (
  id BIGSERIAL PRIMARY KEY,
  prediction_id BIGINT NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('YES','NO')),
  stake INTEGER NOT NULL CHECK (stake > 0),
  odds_snapshot NUMERIC(8,3) NOT NULL CHECK (odds_snapshot > 0),
  potential_return INTEGER NOT NULL CHECK (potential_return >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WON','LOST','REFUNDED')),
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  UNIQUE (prediction_id, player_id)
);

CREATE TABLE wallets (
  player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  current_balance INTEGER NOT NULL DEFAULT 0 CHECK (current_balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount <> 0),
  transaction_type TEXT NOT NULL,
  description TEXT NOT NULL,
  attributed_round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  prediction_id BIGINT REFERENCES predictions(id) ON DELETE SET NULL,
  bet_id BIGINT REFERENCES bets(id) ON DELETE SET NULL,
  correction_of_entry_id BIGINT REFERENCES ledger_entries(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL,
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ledger_unique_idempotency
  ON ledger_entries (game_night_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX ledger_unique_bet_action
  ON ledger_entries (bet_id, transaction_type)
  WHERE bet_id IS NOT NULL AND transaction_type IN ('BET_STAKE','BET_PAYOUT','BET_REFUND');

CREATE TABLE screen_state (
  game_night_id BIGINT PRIMARY KEY REFERENCES game_nights(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'DASHBOARD' CHECK (mode IN ('DASHBOARD','ROUND_STARTED','PREDICTION_VOTING','CROWD_REVEAL','BETTING_OPEN','PREDICTION_RESULT')),
  round_id BIGINT REFERENCES rounds(id) ON DELETE SET NULL,
  prediction_id BIGINT REFERENCES predictions(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE player_codewords (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  codeword TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','REVOKED'))
);

CREATE TABLE player_timers (
  player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  timer_started_at TIMESTAMPTZ,
  timer_duration_seconds INTEGER NOT NULL DEFAULT 180 CHECK (timer_duration_seconds >= 0),
  timer_status TEXT NOT NULL DEFAULT 'RESET' CHECK (timer_status IN ('RESET','RUNNING','PAUSED','COMPLETED')),
  paused_remaining_seconds INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  game_night_id BIGINT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX players_by_game ON players(game_night_id, active);
CREATE INDEX ledger_by_player_date ON ledger_entries(player_id, created_at DESC);
CREATE INDEX ledger_by_game_date ON ledger_entries(game_night_id, created_at DESC);
CREATE INDEX ledger_by_round ON ledger_entries(attributed_round_id, created_at DESC);
CREATE INDEX predictions_by_game_status ON predictions(game_night_id, status);
CREATE INDEX bets_by_prediction ON bets(prediction_id, created_at DESC);
CREATE INDEX votes_by_prediction ON prediction_votes(prediction_id);
CREATE INDEX rounds_by_game_status ON rounds(game_night_id, status);
CREATE INDEX player_sessions_lookup ON player_sessions(session_hash, revoked_at, expires_at);
CREATE INDEX admin_sessions_lookup ON admin_sessions(session_hash, revoked_at, expires_at);
