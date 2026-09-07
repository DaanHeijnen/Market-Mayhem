# Market Mayhem

Market Mayhem is a private game-night economy with player wallets, prediction deposits, visual roulette, interactive round questions and a projector dashboard. React is the presentation layer; Netlify Functions and PostgreSQL own game state and every financial rule.

## Stack

- React 19 + TypeScript + Vite
- Netlify Functions
- Netlify Database / PostgreSQL
- Numbered SQL migrations in `netlify/database/migrations/`
- HttpOnly Admin/player sessions protected with `SESSION_SECRET`
- Transactional wallets plus immutable ledger history
- Lightweight version polling with targeted snapshots

## Routes

- `/admin/:gameId` — Control Center
- `/admin/:gameId/settings` — game settings and reset
- `/admin/:gameId/players` — players, join links and per-player adjustments
- `/admin/:gameId/rounds` — round list
- `/admin/:gameId/rounds/:roundId` — content, round groups and group scoring
- `/admin/:gameId/predictions` — prediction market configuration and control
- `/admin/:gameId/ledger` — filtered immutable ledger
- `/play/:gameId` — authenticated player wallet and live actions
- `/screen/:gameId` — public-safe Big Screen
- `/join/:token` — single-use player join exchange

## First setup

A reset/fresh game has no players, rounds, predictions or transactions.

1. **Settings** — set game name, starting coins, optional maximum wallet percentage per prediction, and the slotmachine's reel symbols and outcome odds.
2. **Players** — create players and generate their single-use join links.
3. **Rounds** — create rounds in any numbering scheme; execution does not assume `current + 1`.
4. **Round Content** — add ordered blocks: `TEXT`, `QUESTION`, `DUOLINGO_QUESTION`, `ROULETTE`, `PICTURE`, `MUSIC`, `BUZZER`, `WAGER`, `SLOTMACHINE`, `PAK_EEN_ZES`.
5. **Predictions** — set probability, market-specific duration and min/max deposit, then optionally schedule to a round.
6. **Control Center** — run the round, move through content, operate live questions/roulette, watch slotmachine series, adjust coins and control the projector.

## Predictions

Admin configures a YES probability from 1–99%. The server calculates fixed multipliers:

- YES = `1 / probability_yes`
- NO = `1 / (1 - probability_yes)`

Each prediction stores its own `prediction_time_seconds`, `minimum_stake` and `maximum_stake`. When a scheduled prediction's round starts it opens on player phones and receives server timestamps, but round start does **not** change the current Big Screen presentation or select a content block. Admin explicitly chooses what to show, including **SHOW PREDICTION**.

Internal state is:

`DRAFT → SCHEDULED → OPEN → LOCKED → RESULT → SETTLED`

Cancellation can occur through `LOCKED`, before a YES/NO result is chosen. Public views map completed outcomes to `RESOLVED_YES`, `RESOLVED_NO` or `CANCELLED`. There is no crowd-probability voting system.

### Deposit accounting

A prediction wager is a deposit, not an immediate permanent loss:

1. placement decreases available wallet balance and creates an active locked bet;
2. total player value remains `available + locked deposits` while unresolved;
3. a winner removes the lock and credits the full `round(stake × multiplier_snapshot)` return;
4. a loser removes the lock with no credit;
5. cancellation returns the deposited stake.

The accepted bet stores its multiplier snapshot. Settlement never recalculates financial terms from a later slider value.

## Roulette

A `ROULETTE` round block uses a visual, canonical table. Players choose a chip amount and may place one or more positions in a single server-validated batch.

Supported bets:

- straight number 0–36
- red / black
- odd / even
- low 1–18 / high 19–36

State is:

`DRAFT → OPEN → LOCKED → SPINNING → RESULT → SETTLED`

The server selects and stores the winning number before the animation starts. The Big Screen wheel animates toward that stored value; the frontend never chooses the financial result. Public-safe player chips (name, color, position, stake) are shown on the projector. Cancellation is available before the spin starts and refunds active stakes; once the server-selected spin begins, the result must be settled.

## Slotmachine

A `SLOTMACHINE` round block. Not a page and not a permanent dashboard feature: it is content inside a round, added in the Round Content Builder, reorderable among other blocks, and live only while the Admin has that block active.

Where each part lives:

| Surface | Role |
| --- | --- |
| Round block | decides *when* the slotmachine is active |
| Player Mobile | input and control only — **no reels** |
| Backend | rules, randomiser, money and outcome |
| Big Screen | the visual machine |

### Settings (game-wide)

One machine serves the whole night, so its symbols and odds are configured once in **Settings**:

- **Symbols** — 12 PNGs, uploaded once and shared by all three reels. Each can be uploaded, replaced, removed and previewed, labelled by position 1–12 (shown as A–L). All twelve are required, because the machine draws freely from the whole set.
- **Kansen** — a chance and a payout multiplier for each of five fixed outcome types. Percentage is shown automatically as `chance ÷ total × 100`.

The chances belong to **patterns, not to pictures**. There is no table of specific symbol combinations: `AAA` is not "three copies of one particular image", it is "three alike", whichever symbol fills it.

| Uitkomsttype | Pattern | Chance | Payout |
| --- | --- | --- | --- |
| Geen winst | `A B C` | set by Admin | always 0x |
| 2 dezelfde gesplitst | `C D C` | set by Admin | set by Admin |
| 2 dezelfde naast elkaar | `C C D` or `D C C` | set by Admin | set by Admin |
| 3 dezelfde op lijn | `A A A` on a payline | set by Admin | set by Admin |
| 3 dezelfde ergens zichtbaar | three alike, off the paylines | set by Admin | set by Admin |

Two alike side by side is a separate category from two alike split, so `C C D` can pay more than `C D C`. `Geen winst` is pinned at 0x in the UI and by a database constraint.

The visible field is **3 rows × 3 reels**. The paylines are the three rows and the two diagonals — columns are not paylines, since a column is a single reel. The middle row is the *hoofdrij*: it is the row that decides the two-alike categories.

The configuration is **valid** only when the chances sum to exactly the total and all twelve symbols have artwork. An incomplete distribution still saves — you can nudge the numbers into place — but the block refuses to run until it is valid, and Settings, the block editor and the Control Center all say why. A fresh game is seeded with `60 / 20 / 10 / 7 / 3` at `0 / 1.4 / 1.8 / 3 / 5x`, so it starts valid and playable.

### Per-block settings

On the block itself: title, instruction text for phones, **maximum spins per series**, and optionally which players take part (leave all unchecked for everyone).

### Playing

Player Mobile becomes the controller automatically while the block is live:

1. choose **inzet per spin**
2. choose **aantal spins** (capped by the block maximum and by their wallet)
3. see **totale inzet** = stake per spin × spins
4. **INZET VASTZETTEN** — commits the series; stake and spin count are now frozen
5. **SPIN** — once per remaining spin

The whole total is debited at lock, like a prediction deposit, so committed coins cannot be spent elsewhere between spins. Unused spins are refunded if the series is cancelled.

On each spin the server works in **two steps**:

1. **Which kind of outcome falls** — one of the five categories, drawn weighted-random from the configured chances.
2. **What that looks like** — a 3×3 field built to match that category, with the symbols and positions chosen at random.

It then re-classifies the finished field and refuses to pay anything that does not match the category it drew. So a spin drawn as "two alike side by side" can never turn out to also show three alike, and the configured percentages are the percentages players actually see. The payout comes from the category, never from which symbols happened to fill it.

The Big Screen shows the full 3×3 field, highlights the cells that form the winning pattern, and names the category (`2 DEZELFDE NAAST ELKAAR`, `3 DEZELFDE OP LIJN`, …) alongside the current player, stake per spin, current spin, spins remaining, payout multiplier, amount won and spin status. Phones show the category name only — never the field.

### Ending safely

Moving to the next content block, or completing the round, closes every live series and refunds spins nobody used — so no slotmachine session keeps running behind the Admin's back. Nothing is lost: spins already taken keep their outcome and payout.

## Pak een Zes

A `PAK_EEN_ZES` round block. Everyone predicts who will draw a six, then players take turns pulling cards from a real 52-card deck until all four sixes are out.

No coins are involved — this step deliberately builds **no scoring**. What it does do is record everything a points system would need later.

### The host's flow

From the Control Center, while the block is live:

1. **OPEN VOORSPELLINGEN** — phones switch to the prediction form.
2. Players fill in four names. The panel shows how many are in and **names who is still missing**.
3. **SLUIT VOORSPELLINGEN** — the window closes. Waiting for everyone is *not* required, which is exactly why the missing names are listed.
4. **START HET SPEL** — this freezes the turn order from the players active at that moment, so someone joining later cannot reshuffle whose turn it is.

State is `READY → PREDICTING → LOCKED → DRAWING → FINISHED`, and it only runs forwards.

### Predicting

Four ordered picks per player. **The same person may be named more than once, and picking yourself is allowed** — so `Daan, Twan, Daan, Bas` is a valid prediction and is stored as four picks, not three names. Re-submitting replaces the whole prediction while the window is open.

### Drawing

Whoever is up gets one big **KAART PAKKEN** button; everyone else sees whose turn it is. The server decides both the card and the turn — a phone can only ask. The remaining deck is derived from the rows already drawn rather than a shuffled list held in memory, and a unique constraint on `(game, rank, suit)` makes "no repeats" a database guarantee. A double tap cannot take two cards: the game row is locked, and a replayed request is answered with the card it already produced.

A six is a moment: the projector calls it out by name. The game ends the instant the fourth six is out, whatever is left in the deck, and the Big Screen then lists all four with who drew them. A player can draw more than one six.

### What is stored for later scoring

- every prediction, per slot, duplicates intact
- every card drawn, in order, with who drew it
- `is_six` on each draw, constrained so it can never disagree with the rank

Which player drew a six, which suit, on which draw, and how often the same player did it are all one query away.

## Live Duolingo questions

`DUOLINGO_QUESTION` is separate from a static `QUESTION` block. Admin configures question text, four answer texts, one correct answer and a reward. The four player controls always use:

`🍆  🌽  🍑  😳`

State is:

`READY → OPEN → CLOSED → REVEALED → SETTLED`

When the block is current, player phones automatically switch to four large emoji controls. Player APIs never expose answer text or the correct index before reveal. Each player may submit once. Reveal credits correct players transactionally with immutable `QUESTION_REWARD` ledger entries attributed to the round and block.

## Round groups

Groups are scoped to a round, not global teams. Admin may create/rename/delete groups and assign each player to at most one group in that round. A signed group adjustment applies the same amount to every member in one server transaction, with one immutable ledger row per player carrying the round, group and mandatory reason. Group adjustments become available once the round has started and remain available retroactively after the round is completed.

Group scoring may be applied retroactively after a round is completed. It changes wallets now while preserving the completed round attribution and current transaction timestamp.

## Wallet and ledger rules

- Available wallet balance never goes below zero.
- Locked prediction/roulette stakes, and a slotmachine series' unspun spins, are unavailable for spending but remain part of total player value until resolved.
- Every money movement is ledger-backed in the same PostgreSQL transaction.
- Old ledger rows are never edited; corrections are compensating entries.
- Manual and group adjustments require a reason.
- High-impact actions use idempotency keys.
- Database row locks prevent simultaneous requests from spending the same available balance twice.

## Big Screen

The default projector is an exchange-style dashboard based on real data only:

- chronological player-value graph from real economy events
- all players begin at their own starting balance on the graph midpoint
- symmetric dynamic gain/loss scaling
- latest settled prediction results beside the graph
- current round, markets open and total coins in play
- real public-safe transaction ticker

`total coins in play = available wallets + unresolved prediction deposits + unresolved roulette stakes + unspun slotmachine spins`.

The projector can also present round blocks, an explicitly featured prediction, roulette, the slotmachine, and Pak een Zes. Control Center contains the exact `/screen/:gameId` preview plus a persistent **SHOW MAIN DASHBOARD** action.

## Design system

The application follows the Game Night Exchange Design Handbook (`devnotes/designhandboek.txt`): Space Grotesk display, Manrope body and JetBrains Mono figures; a paper `#F4F1E4` canvas with ink `#14120F` and white cards; lime `#DFF24C` for the host's primary action; violet, blue, magenta, cyan and orange as content accents; green/red YES/NO semantics; pill buttons, the asymmetric `12px 44px 12px 44px` card radius, 44px minimum touch targets, responsive single-column mobile layouts and dense desktop Admin controls.

Everything is tokenised in `src/styles/tokens.css`, with the shared primitives in `src/components/admin/ui.tsx` (`Card`, `Accordion`, `Chip`, `Status`, `Empty`, `CoinAmount`, `Countdown`). Pages carry no inline hex — a new colour belongs in the token file. Block-type accents come from `src/components/admin/blockMeta.ts` via one `.accent-*` class each, so every content type stays tellable apart in the run of show.

## Preview on phone

The Admin sidebar's **▸ PREVIEW ON PHONE** opens what a chosen player's phone is showing right now, inside the Admin surface. It renders the real player components (`src/components/mobile/MobileViews.tsx`, shared with the live app) from the real `player-state` payload, so it cannot drift from the app the players are holding.

It is **read-only**: navigation works so the host can look around, but every submit control is disabled and no mutation can fire — nobody can bet, answer or request on a player's behalf.

`player-state-preview` is an Admin-authenticated read rather than an impersonated player session. Minting a real player session for the Admin would be new auth surface, and because the preview is a same-origin view it would overwrite the `mm_player_session` cookie of anyone also joined as a player in another tab. `getPlayerState` scopes its lookup to the game night and active players, so an arbitrary `playerId` cannot read across games.

The modal fetches once per Admin snapshot version, so an open preview adds no polling and no extra database compute.

## Authentication

Configure:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=replace-with-generated-hash
SESSION_SECRET=replace-with-at-least-32-random-characters
```

Generate `ADMIN_PASSWORD_HASH` with `npm run admin:hash`. The generated value uses PBKDF2-HMAC-SHA256 and a random salt; the plaintext password is never stored in the project or Netlify environment variables. `SESSION_SECRET` HMAC-protects stored session digests. Raw Admin/player session tokens live only in HttpOnly cookies. Player identity never comes from localStorage or URL player IDs. Join links are random, hashed server-side and single-use; after Admin successfully copies a generated URL the raw link is removed from React state/DOM.

## Local development

```bash
npm install
cp .env.example .env
npx --yes netlify-cli@27.1.1 database init --yes
npx --yes netlify-cli@27.1.1 database migrations apply
npm run dev
```

Then open `http://localhost:8888/admin/1`.

Notes that save time:

- The CLI is **not** installed globally and is not a dependency — always invoke it as `npx --yes netlify-cli@27.1.1 …`, the same pinned form `npm run dev` uses. Plain `npx netlify` resolves a different package.
- `database init` only creates the data directory. **Skipping `migrations apply` leaves a database with no tables**, and admin login then fails with a generic `500 Internal server error` — the credential checks pass and the `INSERT INTO admin_sessions` is what actually blows up.
- Stop the dev server with **Ctrl+C, never `kill`**. The local database is a WASM Postgres running as a child of the Netlify process; an ungraceful stop corrupts `.netlify/db`, after which every start logs `Failed to start Netlify Database locally: RuntimeError: Aborted()` and serves the app *without* a database, so the pages load but every API call 500s. Recover with `rm -rf .netlify/db` and re-run init + migrations.
- The seeded game is intentionally empty — migration `0003` clears the demo data — so add players and a round before anything interesting appears.
- `netlify dev` caches function bundles and does **not** always pick up edits to files under `netlify/lib/`. If an endpoint keeps returning the old shape, `touch` the function file that imports it (e.g. `touch netlify/functions/player-state.ts`) to force a re-bundle. Easy to mistake for a bug in your own change.

## Deploy to Netlify

1. Push the repository to GitHub.
2. Import it into Netlify.
3. Enable Netlify Database.
4. Generate a hash with `npm run admin:hash`, then configure `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and `SESSION_SECRET`.
5. Apply/deploy migrations through `0013_pak_een_zes.sql`.
6. Deploy.

Previously deployed migrations are historical and are not rewritten.

## Delete Game Save

Settings → Danger Zone → **DELETE GAME SAVE** requires exactly `yes delete` in both UI and backend. The transaction is scoped to the requested game ID and removes player/game economy, round content/groups/questions, predictions, roulette and screen state while preserving Admin sessions and the audit table. A final `GAME_RESET` audit record is written first.

## Live updates

Clients poll `/api/game-version` rather than constantly downloading full snapshots. A version change triggers a targeted Admin/player/screen refresh. Polls are deduplicated, stale snapshots use `AbortController`, hidden tabs are throttled and post-action refreshes are immediate. Mobile switches to the faster cadence only while the backend reports an actionable prediction, roulette market or live question.

## Database compute

Netlify Database (Neon) bills **compute time, not query count**. The endpoint stays billable for as long as it is active, and it is kept active by *any* client polling — so the thing that costs money is not a busy game night, it is a quiet one with a tab left open.

`/api/game-version` is one query and is the only thing polled on an interval. Two signals throttle it, both in `src/config/live.ts`:

| Situation | Admin | Big Screen | Mobile |
|---|---|---|---|
| Round or market live | 3s | 5s | 2.5s active / 12s idle |
| Game idle (no round, no market, no roulette) | 15s | 15s | unchanged |
| Idle **and** no interaction for 10 min | **stops** | 60s | **stops** |
| Tab hidden | stops | stops | stops |

- The `idle` flag comes back on the version response, derived from columns that query already reads, so telling clients to back off costs nothing.
- An **abandoned but visible** tab is the expensive case — the hidden-tab check never fires for it. Admin and mobile stop entirely and resume instantly on a click, keypress, scroll or window focus.
- The Big Screen slows rather than stops, because nobody ever touches a projector. That is what lets it notice a round starting without someone refreshing it.
- Mobile keeps its interval when the game is idle on purpose: a phone picks its cadence from its last known state, so slowing it down would directly delay how long a player waits to see a market open.
- An Admin action refreshes its own snapshot directly, so neither the idle tier nor the away stop can ever delay the host seeing their own change.
- Media (`/api/block-media`) is served from Netlify Blobs and touches no database, so the projector and every phone loading the same image generates zero database load. Only the blob key is stored in the block payload — bytes there would ride inside every snapshot.
- `netlify/lib/db.ts` releases idle connections after 10s. An open idle connection keeps the Neon endpoint active, so this matters as much as the polling.

If usage still looks high, the first thing to check is whether a `/screen/:gameId` or `/admin/:gameId` tab is open somewhere on a machine nobody is using.

## Verification

```bash
npm run build
npm test
```

The full Playwright flow needs Netlify Functions and PostgreSQL:

```bash
E2E_BASE_URL=http://localhost:8888 \
E2E_ADMIN_USERNAME=admin \
E2E_ADMIN_PASSWORD=... \
npm run test:e2e
```

See `docs/ARCHITECTURE.md` and `docs/DATABASE.md` for implementation details.
