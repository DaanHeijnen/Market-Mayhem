# Market Mayhem

Market Mayhem is a private game-night economy, prediction market, roulette, player-wallet and projector-control app.

## Stack

- React 19 + TypeScript + Vite
- Netlify Functions
- Netlify Database / PostgreSQL
- Versioned SQL migrations in `netlify/database/migrations/`
- HttpOnly Admin/player sessions
- Transactional wallets with an immutable ledger
- Lightweight version polling with targeted snapshots

## Routes

- `/admin/:gameId` — Control Center
- `/admin/:gameId/settings` — game defaults and game reset
- `/admin/:gameId/players` — player management and join links
- `/admin/:gameId/rounds` — rounds
- `/admin/:gameId/rounds/:roundId` — ordered round content builder
- `/admin/:gameId/predictions` — fixed-odds prediction markets
- `/admin/:gameId/ledger` — filtered ledger and round economy summary
- `/play/:gameId` — authenticated player wallet and market home
- `/screen/:gameId` — public-safe Big Screen

## First-run workflow

A fresh game contains no players, rounds, predictions or transactions. Configure it in this order:

1. **Settings** — name, starting coins, prediction timer and prediction stake limits.
2. **Players** — add players and generate single-use join links.
3. **Rounds** — create rounds. Round number is a label; Admin may start any upcoming round.
4. **Round Content** — add ordered `TEXT`, `QUESTION` and `ROULETTE` blocks.
5. **Predictions** — create fixed YES/NO odds and optionally schedule a prediction on a round.
6. **Control** — run the active round, move through content, operate roulette, adjust coins and watch the live projector preview.

## Predictions

Prediction odds are entered by Admin. There is no crowd-probability vote and wager volume never changes odds.

State machine:

`DRAFT → SCHEDULED → OPEN → LOCKED → RESULT → SETTLED`

A draft may also open manually. Any unresolved prediction may be cancelled; active stakes are refunded transactionally.

When a round starts, its `SCHEDULED` predictions automatically become `OPEN`. `opened_at` and `closes_at` are generated server-side from the per-game prediction duration. A stale player UI cannot place a late bet: the bet endpoint verifies `closes_at` again inside the transaction.

Players may simply abstain. No zero-value bet or wallet transaction is created.

## Roulette

A `ROULETTE` round block creates the current roulette spin when activated. Admin controls:

`DRAFT → OPEN → LOCKED → RESULT → SETTLED`

The initial mobile bet types are straight number, red/black, odd/even and low/high. Payouts are calculated server-side from stored bet snapshots. Cancelled spins refund active stakes.

## Ledger and wallets

`wallets.current_balance` is the transactional current balance. `ledger_entries` is immutable financial history. Starting balances, signed Admin adjustments, prediction stakes/payouts/refunds and roulette stakes/payouts/refunds update wallet + ledger in the same PostgreSQL transaction.

Manual adjustments require an exact written reason and can optionally be attributed to any round. Corrections are new compensating entries; old ledger rows are never edited.

The Ledger page filters in SQL by all rounds, a specific round, or General/no-round and includes per-player earned/lost/net totals.

## Big Screen

The dashboard is driven only by real economy data:

- chronological wallet-value graph from ledger entries
- player current value and change vs that player's starting-balance ledger entry
- current round
- open prediction + roulette market count
- total coins in play = active wallet balances + stakes locked in unresolved prediction/roulette markets
- public ledger ticker

Round content, prediction open/locked/result states and roulette have dedicated projector compositions. The Control Center embeds the exact `/screen/:gameId` output in an iframe.

## Authentication

Configure all three variables:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-me
SESSION_SECRET=replace-with-at-least-32-random-characters
```

`SESSION_SECRET` HMAC-protects the server-side digest of opaque Admin/player session tokens. Changing this secret invalidates existing Admin/player sessions, so users must sign in/join again. Player identity always comes from an HttpOnly cookie backed by `player_sessions`; localStorage and URL player IDs are never trusted.

## Local development

```bash
npm install
cp .env.example .env
npx netlify database init --yes
npx netlify database migrations apply
npm run dev
```

Then open `http://localhost:8888/admin/1`.

## Deploy to Netlify

1. Push the repository to GitHub.
2. Import it into Netlify.
3. Enable Netlify Database.
4. Configure `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `SESSION_SECRET`.
5. Deploy. New schema work is added as numbered migrations; previously deployed migrations are not rewritten.

## Delete Game Save

Settings → Danger Zone → **DELETE GAME SAVE** requires the exact phrase `yes delete` in both the browser and backend. The transaction resets only the requested game ID: players/sessions/tokens and legacy teams, wallets/ledger, rounds/blocks, predictions/bets, roulette, screen state and game settings. Admin sessions remain usable. A `GAME_RESET` audit event is written before cleanup.

## Live updates

Clients poll only `/api/game-version` until the version changes, then refresh their targeted state endpoint. Polls do not overlap, stale snapshot refreshes use `AbortController`, hidden tabs are throttled, and a successful local mutation refreshes immediately.

Mobile uses the backend `actionable` flag to select active vs idle polling cadence.

## Tests

```bash
npm test
npm run build
```

The Playwright full-flow test requires a real Netlify/PostgreSQL environment:

```bash
E2E_BASE_URL=http://localhost:8888 E2E_ADMIN_USERNAME=admin E2E_ADMIN_PASSWORD=... npm run test:e2e
```

See `docs/ARCHITECTURE.md` and `docs/DATABASE.md` for the detailed state/data model.
