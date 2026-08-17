# Market Mayhem

Market Mayhem is a private game-night economy, prediction market, player wallet, and broadcast-control app. The supplied Game Night Exchange prototypes are translated into a production React/TypeScript application while the product brand is **Market Mayhem**.

## Architecture
- React + TypeScript + Vite
- Netlify Functions
- Netlify Database / PostgreSQL via `@netlify/database`
- Version-controlled SQL migrations in `netlify/database/migrations/`
- Secure HttpOnly player/admin sessions
- Atomic wallet, bet and settlement transactions
- Big Screen `/screen/:gameId`, Admin `/admin/:gameId`, Mobile `/play/:gameId`

## Option A — deploy from GitHub
1. Unzip this project and push all files to a new GitHub repository.
2. Import the repository into Netlify.
3. Netlify detects `@netlify/database`; create/enable Netlify Database if prompted.
4. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `SESSION_SECRET` in Netlify environment variables.
5. Deploy. Migrations in `netlify/database/migrations/` are applied automatically by Netlify Database.
6. Open `/admin/1`, `/screen/1`, and generate player join links through the `player-join-link` API/admin extension as needed.

Generate a password hash locally:
```bash
npm run admin:hash -- "your strong password"
```

## Option B — local development
```bash
npm install
cp .env.example .env
npm run admin:hash -- "your strong password"
# put the returned value in ADMIN_PASSWORD_HASH
npx netlify database init --yes
npx netlify database migrations apply
npm run dev
```
Then open `http://localhost:8888/admin/1` and `http://localhost:8888/screen/1`.

## Live Update Speed / Netlify Credit Usage
All polling numbers live in exactly one file: `src/config/live.ts`.

Faster projector:
```ts
BIG_SCREEN_POLL_MS: 1000
```
Lower usage:
```ts
BIG_SCREEN_POLL_MS: 5000
MOBILE_IDLE_POLL_MS: 30000
```
Big Screen uses `BIG_SCREEN_POLL_MS`; Admin uses `ADMIN_POLL_MS`; idle mobile uses `MOBILE_IDLE_POLL_MS`; voting/betting mobile uses `MOBILE_ACTIVE_POLL_MS`; hidden tabs use `HIDDEN_TAB_POLL_MS`.

**Lower milliseconds = faster updates = potentially higher platform usage. Higher milliseconds = slower updates = lower platform usage.**

Polling only requests the tiny game version. A targeted interface snapshot is fetched only when that version changes. Local successful mutations trigger an immediate refresh. No overlapping polls are allowed; hidden tabs are throttled.

## Security and economy
The PostgreSQL database is the source of truth. Wallet changes, bet placement, and settlement happen server-side in PostgreSQL transactions. Ledger history is immutable. Retried financial requests use idempotency keys. Player sessions are opaque HttpOnly cookies and never trust a browser-supplied player id.

## Tests
```bash
npm test
npm run test:e2e
npm run build
```
See `docs/ARCHITECTURE.md` and `docs/DATABASE.md` for the state machine, ERD, wallet invariants, polling design and deployment model.

## Seed data
The included development seed creates game `1`, players Daan/Bas/Jorrit/Twan, out-of-order round execution, Prediction #14, wallet history, codewords, timers, and the dashboard screen state. It is intended for a fresh development/preview database.
