export const LIVE_CONFIG = {
  BIG_SCREEN_POLL_MS: 3000,
  ADMIN_POLL_MS: 3000,
  MOBILE_IDLE_POLL_MS: 12000,
  MOBILE_ACTIVE_POLL_MS: 2500,
  ERROR_RETRY_MS: 10000,
  ENABLE_POLLING: true,
} as const;

export type LivePollKind = 'screen' | 'admin' | 'mobile';

export function getLivePollDelay(kind: LivePollKind, mobileActive: boolean, visibility: DocumentVisibilityState = 'visible') {
  if (visibility === 'hidden') return null;
  if (kind === 'screen') return LIVE_CONFIG.BIG_SCREEN_POLL_MS;
  if (kind === 'admin') return LIVE_CONFIG.ADMIN_POLL_MS;
  return mobileActive ? LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS : LIVE_CONFIG.MOBILE_IDLE_POLL_MS;
}

// Lower milliseconds = faster updates = potentially higher Netlify usage.
// Hidden tabs do not poll; they refresh immediately when visible again.
