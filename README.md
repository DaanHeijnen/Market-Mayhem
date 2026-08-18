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


## Clean first-run setup

Market Mayhem now starts with an empty game night at `/admin/1`: no players, no rounds, no predictions, and no demo ledger entries. Configure the default starting coins in **Admin → Settings**, then add players, rounds, and predictions from their dedicated admin pages. Prediction visibility is explicitly controlled from **Admin → Predictions** and is independent of the voting/betting phase.

Manual coin changes from **Admin → Control** require a written reason. That reason is stored on the immutable ledger entry. The Control page also includes an embedded live preview of `/screen/1`.

## Option A — deploy from GitHub
1. Unzip this project and push all files to a new GitHub repository.
2. Import the repository into Netlify.
3. Netlify detects `@netlify/database`; create/enable Netlify Database if prompted.
4. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in Netlify environment variables.
5. Deploy. Migrations in `netlify/database/migrations/` are applied automatically by Netlify Database.
6. Open `/admin/1`, `/screen/1`, and generate player join links through the `player-join-link` API/admin extension as needed.

Use a plain `ADMIN_PASSWORD` value in Netlify. No local hashing command is required.

## Option B — local development
```bash
npm install
cp .env.example .env
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

## Database initialization
The migration history includes the original prototype seed followed by a cleanup migration that leaves game `1` empty for real use. On both fresh deployments and upgrades from the demo build, the resulting Market Mayhem game starts with no players, rounds, predictions, bets, or ledger entries.
