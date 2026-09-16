import { describe, expect, it } from 'vitest';
import { planReveal } from '../src/components/shared/useHeldReveal';

/**
 * The hard UX requirement, tested where it is decided.
 *
 * The server holds a spin presentationally for the length of its animation, but the big
 * screen polls every five seconds and the slot window is 3.2 — so a poll can land after
 * the server has already revealed. Without this rule the reels would jump straight to the
 * result, which is exactly what must never happen.
 */
describe('deciding whether a reveal has to be animated', () => {
  it('animates nothing on the first thing it ever sees', () => {
    // Opening the projector on a spin that finished ten minutes ago shows its result
    // rather than replaying it.
    expect(planReveal(null, 'spin-1', true)).toEqual({ seen: 'spin-1', animate: false });
  });

  // The case the whole hook exists for: a spin the surface has not shown yet, arriving on
  // a poll that may well be after the server already revealed it.
  it('animates a spin it has not shown before', () => {
    expect(planReveal('spin-1', 'spin-2', true)).toEqual({ seen: 'spin-2', animate: true });
  });

  it('does not restart on a poll that brings the same spin again', () => {
    expect(planReveal('spin-2', 'spin-2', true)).toEqual({ seen: 'spin-2', animate: false });
  });

  it('holds nothing when there is nothing to animate', () => {
    expect(planReveal('spin-2', null, true)).toEqual({ seen: null, animate: false });
    expect(planReveal('spin-2', 'spin-3', false)).toEqual({ seen: null, animate: false });
  });

  // Disarming forgets, so the first spin of the next round is a first sighting again
  // rather than a change to animate.
  it('forgets what it saw once there is nothing armed', () => {
    const cleared = planReveal('spin-1', null, true);
    expect(planReveal(cleared.seen, 'spin-9', true)).toEqual({ seen: 'spin-9', animate: false });
  });

  // A spin id and a timestamp are both used as keys, so the rule must not care which.
  it('does not care what the key is', () => {
    expect(planReveal(1, 2, true).animate).toBe(true);
    expect(planReveal('2024-01-01T00:00:00Z', '2024-01-01T00:00:09Z', true).animate).toBe(true);
    expect(planReveal(2, 2, true).animate).toBe(false);
  });
});
