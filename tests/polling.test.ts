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

/**
 * How long the room waits.
 *
 * The complaint these numbers answer: pressing VOLGENDE and watching the projector sit
 * there for several seconds. Worst case is one interval plus the version cache, so the
 * interval is the whole of it.
 */
describe('how quickly each surface notices a change', () => {
  const live = (kind: 'screen' | 'admin' | 'mobile') => getLivePollDelay(kind, true, 'visible', false, 0);

  it('keeps the projector inside a second and a half', () => {
    expect(live('screen')).toBeLessThanOrEqual(1500);
  });

  // A slot spin is held at SPINNING for 3.2s so the reels can turn. The projector has to
  // poll comfortably inside that window or it can miss the animation entirely.
  it('polls the projector several times within a slot spin', () => {
    const SLOT_SPIN_MS = 3200;
    expect(live('screen')! * 2).toBeLessThan(SLOT_SPIN_MS);
  });

  it('keeps a phone in an active round inside a second and a half', () => {
    expect(live('mobile')).toBeLessThanOrEqual(1500);
  });

  it('keeps the Admin inside two seconds', () => {
    expect(live('admin')).toBeLessThanOrEqual(2000);
  });

  // The saving lives in the idle tiers, which are deliberately untouched: most of an
  // evening is setup, breaks and discussion, and nothing can change on its own then.
  it('still backs off hard when nothing can change', () => {
    for (const kind of ['screen', 'admin', 'mobile'] as const) {
      const idle = getLivePollDelay(kind, false, 'visible', true, 0);
      expect(idle, kind).toBeGreaterThanOrEqual(12000);
    }
  });

  it('still stops entirely for a hidden tab', () => {
    expect(getLivePollDelay('screen', true, 'hidden', false, 0)).toBeNull();
  });
});
