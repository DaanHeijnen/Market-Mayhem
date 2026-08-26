import { describe, expect, it } from 'vitest';
import { getLivePollDelay, LIVE_CONFIG } from '../src/config/live';

describe('polling config', () => {
  it('keeps active mobile faster than idle', () => {
    expect(LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS).toBeLessThan(LIVE_CONFIG.MOBILE_IDLE_POLL_MS);
  });

  it('preserves active screen and admin polling intervals', () => {
    expect(getLivePollDelay('screen', false, 'visible')).toBe(LIVE_CONFIG.BIG_SCREEN_POLL_MS);
    expect(getLivePollDelay('admin', false, 'visible')).toBe(LIVE_CONFIG.ADMIN_POLL_MS);
  });

  it('preserves active and idle mobile polling intervals while visible', () => {
    expect(getLivePollDelay('mobile', true, 'visible')).toBe(LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS);
    expect(getLivePollDelay('mobile', false, 'visible')).toBe(LIVE_CONFIG.MOBILE_IDLE_POLL_MS);
  });

  it('backs Admin and Big Screen off hard when the game is idle', () => {
    expect(getLivePollDelay('screen', false, 'visible', true)).toBe(LIVE_CONFIG.BIG_SCREEN_IDLE_POLL_MS);
    expect(getLivePollDelay('admin', false, 'visible', true)).toBe(LIVE_CONFIG.ADMIN_IDLE_POLL_MS);
    expect(LIVE_CONFIG.BIG_SCREEN_IDLE_POLL_MS).toBeGreaterThan(LIVE_CONFIG.BIG_SCREEN_POLL_MS);
    expect(LIVE_CONFIG.ADMIN_IDLE_POLL_MS).toBeGreaterThan(LIVE_CONFIG.ADMIN_POLL_MS);
  });

  it('never slows a player phone down for idleness, so market latency is unchanged', () => {
    expect(getLivePollDelay('mobile', false, 'visible', true)).toBe(LIVE_CONFIG.MOBILE_IDLE_POLL_MS);
    expect(getLivePollDelay('mobile', true, 'visible', true)).toBe(LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS);
  });

  it('defaults to live intervals when the server has not reported idleness yet', () => {
    expect(getLivePollDelay('admin', false, 'visible')).toBe(LIVE_CONFIG.ADMIN_POLL_MS);
    expect(getLivePollDelay('screen', false, 'visible')).toBe(LIVE_CONFIG.BIG_SCREEN_POLL_MS);
  });

  it('does not schedule polling while the tab is hidden', () => {
    expect(getLivePollDelay('screen', false, 'hidden')).toBeNull();
    expect(getLivePollDelay('admin', false, 'hidden')).toBeNull();
    expect(getLivePollDelay('mobile', true, 'hidden')).toBeNull();
    expect(getLivePollDelay('mobile', false, 'hidden')).toBeNull();
    expect(getLivePollDelay('admin', false, 'hidden', true)).toBeNull();
  });
});

// An abandoned-but-visible tab is the expensive case: the visibility check never fires,
// so without an away rule it polls forever and the database compute is billed all night.
describe('abandoned tabs', () => {
  const AWAY = LIVE_CONFIG.AWAY_AFTER_MS;

  it('stops Admin polling entirely once the tab is abandoned on an idle game', () => {
    expect(getLivePollDelay('admin', false, 'visible', true, AWAY)).toBeNull();
    expect(getLivePollDelay('admin', false, 'visible', true, AWAY * 10)).toBeNull();
  });

  it('stops an abandoned phone too', () => {
    expect(getLivePollDelay('mobile', false, 'visible', true, AWAY)).toBeNull();
  });

  it('keeps polling an abandoned tab while the game is actually live', () => {
    expect(getLivePollDelay('admin', false, 'visible', false, AWAY * 10)).toBe(LIVE_CONFIG.ADMIN_POLL_MS);
    expect(getLivePollDelay('mobile', true, 'visible', false, AWAY * 10)).toBe(LIVE_CONFIG.MOBILE_ACTIVE_POLL_MS);
  });

  it('keeps polling just before the away threshold', () => {
    expect(getLivePollDelay('admin', false, 'visible', true, AWAY - 1)).toBe(LIVE_CONFIG.ADMIN_IDLE_POLL_MS);
  });

  // Nobody ever touches a projector, so it must not be judged by interaction — it slows
  // down instead of stopping, which is how it notices a round starting unattended.
  it('never stops the Big Screen, only slows it', () => {
    expect(getLivePollDelay('screen', false, 'visible', true, AWAY * 100)).toBe(LIVE_CONFIG.BIG_SCREEN_DORMANT_POLL_MS);
    expect(getLivePollDelay('screen', false, 'visible', false, AWAY * 100)).toBe(LIVE_CONFIG.BIG_SCREEN_POLL_MS);
  });

  it('orders the Big Screen tiers from live to dormant', () => {
    expect(LIVE_CONFIG.BIG_SCREEN_POLL_MS).toBeLessThan(LIVE_CONFIG.BIG_SCREEN_IDLE_POLL_MS);
    expect(LIVE_CONFIG.BIG_SCREEN_IDLE_POLL_MS).toBeLessThan(LIVE_CONFIG.BIG_SCREEN_DORMANT_POLL_MS);
  });

  it('treats a fresh tab as present', () => {
    expect(getLivePollDelay('admin', false, 'visible', true, 0)).toBe(LIVE_CONFIG.ADMIN_IDLE_POLL_MS);
  });
});
