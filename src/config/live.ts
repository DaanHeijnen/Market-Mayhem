export const LIVE_CONFIG = {
  /*
   * The live tiers are what the room feels, and they are deliberately lopsided.
   *
   * Every tick is one cached `game-version` call; the full snapshot follows only when that
   * version actually moved. So the cost of a tier is the number of clients on it, and the
   * three tiers are nothing alike: one projector, two Admin screens, and ten phones.
   *
   * The projector and the Admin are what somebody is *watching* when a player taps SPIN or
   * locks a roulette chip, so they are fast — half a second and just under a second. Two
   * surfaces between them, so that speed is nearly free.
   *
   * The phones are the expensive tier and the one that needs speed least. A player's own
   * action refreshes their own screen directly from the mutation's reply, without waiting
   * for a tick at all; the interval only governs how quickly they notice *somebody else's*
   * move, where a couple of seconds is imperceptible. Ten clients at 2.5s cost less than
   * ten at 1.2s by a wide margin, and that saving is what pays for the two fast tiers.
   *
   * The idle and dormant tiers are untouched, and they are where the real saving lives:
   * most of an evening's wall clock is setup, breaks and discussion.
   */
  BIG_SCREEN_POLL_MS: 500,
  /*
   * The projector's two slow tiers used to be fifteen and sixty seconds, and that is what
   * made starting a round feel broken: between two rounds nothing is live, so the game
   * reads idle, so the projector is asleep at exactly the moment the host presses START.
   * Every later VOLGENDE landed in half a second because by then the round was running.
   *
   * Two changes fixed it together. The server now counts a recent change as "awake", which
   * covers the usual case where the host is working in the Admin; these tiers bound the
   * case it does not — a genuinely quiet room. One client, so four seconds of idle costs
   * about nine hundred cheap version polls an hour, which is worth not having a round
   * start into a dead screen.
   */
  BIG_SCREEN_IDLE_POLL_MS: 4000,
  BIG_SCREEN_DORMANT_POLL_MS: 15000,
  ADMIN_POLL_MS: 900,
  ADMIN_IDLE_POLL_MS: 15000,
  MOBILE_IDLE_POLL_MS: 12000,
  MOBILE_ACTIVE_POLL_MS: 2500,
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
