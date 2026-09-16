import { useEffect, useRef, useState } from 'react';

/**
 * Whether seeing `key` should start an animation, and what to remember afterwards.
 *
 * Pure, and separated from the hook below because it is the actual rule: the hook is only
 * the wiring that runs it on every render and starts a timer.
 *
 * Three cases, and the middle one is the whole point:
 *
 *   nothing armed        forget what was seen, so the next round starts fresh
 *   first ever sighting  remember it, animate nothing — opening the projector on a spin
 *                        that finished ten minutes ago shows its result, not a replay
 *   a different key      remember it, and animate
 */
export function planReveal(seen: unknown, key: unknown, armed: boolean) {
  if (!armed || key == null) return { seen: null, animate: false };
  if (seen === key) return { seen, animate: false };
  // `null` is the "seen nothing yet" marker, so a first sighting is recorded silently.
  if (seen === null) return { seen: key, animate: false };
  return { seen: key, animate: true };
}

/**
 * Hold a reveal back until its animation has actually been seen.
 *
 * The problem this solves is a timing one that no amount of server correctness fixes. The
 * server decides a spin's outcome immediately and holds it presentationally for the length
 * of the animation, then flips it to revealed. But the projector polls on an interval, and
 * that interval is longer than the slot animation window — so a poll can land *after* the
 * flip and render a finished result for a spin whose reels were never seen to turn.
 *
 * So the surface owns the reveal, not the poll. The first time it sees a spin it has not
 * shown before, it plays the full animation from that moment, whatever the server already
 * says, and only then reveals.
 *
 * Safe precisely because it is presentation only: the outcome and the coins were committed
 * in the same transaction that created the spin, long before anything here runs. Nothing
 * financial waits on this timer, and no callback from it settles anything.
 *
 * @param key    identifies the thing being revealed — a spin id, a spin timestamp.
 * @param ms     how long the animation runs.
 * @param armed  whether there is anything to animate at all.
 */
export function useHeldReveal(key: unknown, ms: number, armed = true) {
  const [holding, setHolding] = useState(false);
  const seen = useRef<unknown>(null);

  useEffect(() => {
    const plan = planReveal(seen.current, key, armed);
    seen.current = plan.seen;
    if (!plan.animate) {
      if (!armed || key == null) setHolding(false);
      return;
    }
    setHolding(true);
    const timer = setTimeout(() => setHolding(false), ms);
    return () => clearTimeout(timer);
  }, [key, ms, armed]);

  return holding;
}
