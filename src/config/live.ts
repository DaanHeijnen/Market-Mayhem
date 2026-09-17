export const LIVE_CONFIG = {
  /*
   * The live tiers are what the room feels.
   *
   * Every tick is a single cached `game-version` call, and the full snapshot is fetched
   * only when that version actually moved — so shortening these buys responsiveness
   * without multiplying the expensive request. The projector is the surface people watch
   * while the host presses a button, so it is the fastest of the three; at five seconds a
   * VOLGENDE could sit unseen for longer than it took to decide on it, and a slotmachine
   * spin could finish its whole 3.2s animation window between two polls.
   *
   * The idle and dormant tiers below are untouched, and they are where the saving actually
   * lives: most of an evening's wall clock is setup, breaks and discussion, and none of
   * these numbers apply then.
   */
  BIG_SCREEN_POLL_MS: 1200,
  BIG_SCREEN_IDLE_POLL_MS: 15000,
  BIG_SCREEN_DORMANT_POLL_MS: 60000,
  ADMIN_POLL_MS: 2000,
  ADMIN_IDLE_POLL_MS: 15000,
  MOBILE_IDLE_POLL_MS: 12000,
  MOBILE_ACTIVE_POLL_MS: 1200,
  ERROR_RETRY_MS: 10000,
  /** No interaction for this long, with the game idle, means nobody is really there. */
  AWAY_AFTER_MS: 10 * 60 * 1000,
  ENABLE_POLLING: true,
} as const;

export type LivePollKind = 'screen' | 'admin' | 'mobile';

/**
 * Poll delay in ms, or null to stop polling entirely.
 *
 * Two independent signals throttle this, and both exist to stop the database compute
 * being billed for nothing:
 *
 * `gameIdle` — from the `idle` flag on the game-version response: no round active, no
 * market open, no roulette live. Nothing can change on its own, so back off hard. This
 * covers most of a game night's wall clock: setup, breaks, discussion.
 *
 * `awayMs` — how long since anyone touched this tab. A tab left open on a desk is the
 * expensive case: it is visible, so the visibility check never fires, and it polls
 * forever. An abandoned tab on an idle game stops polling completely and resumes the
 * moment someone clicks, types, or focuses the window.
 *
 * The Big Screen is the exception: nobody ever touches a projector, so it must not be
 * judged by interaction. It slows to a minute instead of stopping, which is what lets it
 * notice a round starting without an admin having to refresh it.
 *
 * Mobile has no idle tier for its interval. A phone picks its interval from its last
 * known state, so slowing it down directly delays how long a player waits to see a
 * market open — not worth trading. A phone that locks goes hidden and stops anyway.
 */
export function getLivePollDelay(
  kind: LivePollKind,
  mobileActive: boolean,
  visibility: DocumentVisibilityState = 'visible',
  gameIdle = false,
  awayMs = 0,
) {
  if (visibility === 'hidden') return null;
  const away = gameIdle && awayMs >= LIVE_CONFIG.AWAY_AFTER_MS;

  if (kind === 'screen') {
    if (away) return LIVE_CONFIG.BIG_SCREEN_DORMANT_POLL_MS;
    return gameIdle ? LIVE_CONFIG.BIG_SCREEN_IDLE_POLL_MS : LIVE_CONFIG.BIG_SCREEN_POLL_MS;
  }
  if (kind === 'admin') {
    if (away) return null;
    return gameIdle ? LIVE_CONFIG.ADMIN_IDLE_POLL_MS : LIVE_CONFIG.ADMIN_POLL_MS;
  }
  if (away) return null;
  return mobileActive ? LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS : LIVE_CONFIG.MOBILE_IDLE_POLL_MS;
}

// Lower milliseconds = faster updates = potentially higher Netlify usage.
// Hidden tabs do not poll; they refresh immediately when visible again.
// An Admin mutation refreshes its own snapshot directly, so neither the idle tier nor
// the away stop can delay the host seeing their own change.
