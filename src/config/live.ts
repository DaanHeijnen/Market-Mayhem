export const LIVE_CONFIG = {
  BIG_SCREEN_POLL_MS: 5000,
  BIG_SCREEN_IDLE_POLL_MS: 15000,
  ADMIN_POLL_MS: 3000,
  ADMIN_IDLE_POLL_MS: 15000,
  MOBILE_IDLE_POLL_MS: 12000,
  MOBILE_ACTIVE_POLL_MS: 2500,
  ERROR_RETRY_MS: 10000,
  ENABLE_POLLING: true,
} as const;

export type LivePollKind = 'screen' | 'admin' | 'mobile';

/**
 * Poll delay in ms, or null to stop polling.
 *
 * `gameIdle` comes from the `idle` flag on the game-version response: no round is
 * active, no market is open and no roulette is live. Nothing can change on its own
 * in that state, so Admin and Big Screen back off hard — this is most of a game
 * night's wall clock (setup, breaks, discussion) and it is what keeps the database
 * compute awake for no benefit.
 *
 * Mobile deliberately does NOT take an idle tier. A phone's interval is chosen from
 * its last known state, so slowing it down directly delays how long a player waits
 * to notice a market opening. Player-facing latency is not worth trading here.
 */
export function getLivePollDelay(kind: LivePollKind, mobileActive: boolean, visibility: DocumentVisibilityState = 'visible', gameIdle = false) {
  if (visibility === 'hidden') return null;
  if (kind === 'screen') return gameIdle ? LIVE_CONFIG.BIG_SCREEN_IDLE_POLL_MS : LIVE_CONFIG.BIG_SCREEN_POLL_MS;
  if (kind === 'admin') return gameIdle ? LIVE_CONFIG.ADMIN_IDLE_POLL_MS : LIVE_CONFIG.ADMIN_POLL_MS;
  return mobileActive ? LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS : LIVE_CONFIG.MOBILE_IDLE_POLL_MS;
}

// Lower milliseconds = faster updates = potentially higher Netlify usage.
// Hidden tabs do not poll; they refresh immediately when visible again.
// An Admin mutation refreshes its own snapshot directly, so the Admin idle tier
// never delays the host seeing their own change.
