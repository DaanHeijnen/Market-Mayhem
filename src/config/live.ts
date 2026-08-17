export const LIVE_CONFIG = {
  BIG_SCREEN_POLL_MS: 3000,
  ADMIN_POLL_MS: 3000,
  MOBILE_IDLE_POLL_MS: 12000,
  MOBILE_ACTIVE_POLL_MS: 2500,
  HIDDEN_TAB_POLL_MS: 30000,
  ERROR_RETRY_MS: 10000,
  ENABLE_POLLING: true,
} as const;
// Lower milliseconds = faster updates = potentially higher Netlify usage.
// Higher milliseconds = slower updates = lower Netlify usage.
