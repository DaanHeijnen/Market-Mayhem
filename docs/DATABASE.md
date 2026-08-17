# Market Mayhem Database

## ERD

```mermaid
erDiagram
  game_nights ||--o{ teams : has
  game_nights ||--o{ players : has
  game_nights ||--o{ rounds : has
  game_nights ||--o{ predictions : has
  game_nights ||--|| screen_state : broadcasts
  game_nights ||--o{ ledger_entries : records
  game_nights ||--o{ admin_audit_log : audits
  teams ||--o{ players : groups
  players ||--|| wallets : owns
  players ||--o{ player_sessions : authenticates
  players ||--o{ player_join_tokens : joins
  players ||--o{ player_codewords : receives
  players ||--|| player_timers : owns
  players ||--o{ prediction_votes : votes
  players ||--o{ bets : places
  players ||--o{ ledger_entries : affects
  rounds ||--o{ predictions : contains
  rounds ||--o{ ledger_entries : attributes
  predictions ||--o{ prediction_votes : receives
  predictions ||--o{ bets : receives
  predictions ||--o{ ledger_entries : explains
  bets ||--o{ ledger_entries : finances
```

## Key tables

### game_nights
Top-level event boundary. Nearly all state belongs to a `game_night_id`. Holds the current round, screen mode, starting balance, and monotonic state version.

### players / teams
Players may belong to one team. Wallets remain individual in v1.

### wallets / ledger_entries
`wallets` stores the transactionally maintained current balance. `ledger_entries` is immutable history. Corrections use `correction_of_entry_id` and a new amount row rather than editing old rows.

### rounds
`round_number` is not execution order. `started_at`/`completed_at` define actual chronology.

### predictions / prediction_votes / bets
Predictions implement the server-owned state machine. Votes are unique per player/prediction and private. Bets are unique per player/prediction and store an odds snapshot.

### screen_state
Explicitly selects the Big Screen composition.

### player_join_tokens / player_sessions / admin_sessions
Opaque authentication records. Raw player/admin session tokens are never stored.

### player_codewords / player_timers
Admin-only codeword history and low-write timer state. Timer countdown visuals are computed locally between database mutations.

### admin_audit_log
Operational history separate from the financial ledger.

## Integrity checks

The Admin diagnostics endpoint includes a wallet verification query comparing cached wallet values with ledger sums. A mismatch is treated as a serious integrity warning.
