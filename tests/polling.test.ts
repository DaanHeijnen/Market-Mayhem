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
