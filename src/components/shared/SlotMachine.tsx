import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SLOT_SYMBOLS_PER_REEL, SLOT_REELS, slotSymbolLetter, slotSymbolUrl } from '../../lib/slot';

export interface SlotSymbolMeta { reel: number; position: number; checksum: string }
export interface SlotSpinView { id: number; positions: number[] | null; status: string; revealAt: string }

/** Copies of the 12-symbol strip that the reel can travel through per spin. */
const STRIP_COPIES = 6;
const REEL_DURATIONS_MS = [2200, 2800, 3400];
const REEL_TRAVEL_COPIES = [3, 4, 5];

const revealTime = (spin: SlotSpinView | null) => (spin ? new Date(spin.revealAt).getTime() : 0);

/**
 * True once the outcome may be read out loud. The server flips the spin to
 * RESULT on its own clock; this only keeps the on-screen copy in step with the
 * reels between two polls.
 */
export function useSlotRevealed(spin: SlotSpinView | null) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!spin) return;
    const remaining = revealTime(spin) - Date.now();
    if (remaining <= 0) return;
    const id = window.setTimeout(() => setTick(x => x + 1), remaining + 60);
    return () => window.clearTimeout(id);
  }, [spin?.id, spin?.revealAt, tick]);
  if (!spin) return true;
  return spin.status === 'RESULT' || Date.now() >= revealTime(spin);
}

export function SlotMachine({ gameId, symbols, spin, idle = false }: { gameId: number; symbols: SlotSymbolMeta[]; spin: SlotSpinView | null; idle?: boolean }) {
  const checksums = useMemo(() => {
    const map = new Map<string, string>();
    symbols.forEach(s => map.set(`${s.reel}-${s.position}`, s.checksum));
    return map;
  }, [symbols]);

  const targets = spin?.positions && spin.positions.length === 3 ? spin.positions : [1, 1, 1];
  const [offsets, setOffsets] = useState<number[]>(() => targets.map(p => p - 1));
  const [animating, setAnimating] = useState(false);
  const lastSpinId = useRef<number | null>(spin?.id ?? null);
  const timers = useRef<number[]>([]);

  const clearTimers = () => { timers.current.forEach(window.clearTimeout); timers.current = []; };
  useEffect(() => clearTimers, []);

  // A new spin id is the only trigger. The reels always travel towards the
  // outcome the game engine already chose.
  useLayoutEffect(() => {
    if (!spin) { lastSpinId.current = null; return; }
    if (spin.id === lastSpinId.current) return;
    lastSpinId.current = spin.id;
    clearTimers();

    const landed = targets.map(p => p - 1);
    const remaining = revealTime(spin) - Date.now();
    // Arriving after the reveal window (a late poll, or a freshly opened screen)
    // must not replay an animation the room has already missed.
    if (remaining < 800) { setAnimating(false); setOffsets(landed); return; }

    setAnimating(false);
    setOffsets(landed);
    timers.current.push(window.setTimeout(() => {
      setAnimating(true);
      setOffsets(targets.map((p, i) => REEL_TRAVEL_COPIES[i] * SLOT_SYMBOLS_PER_REEL + p - 1));
      timers.current.push(window.setTimeout(() => { setAnimating(false); setOffsets(landed); }, Math.max(...REEL_DURATIONS_MS) + 80));
    }, 30));
  }, [spin?.id]);

  const spinning = animating;
  return <div className={`slot-machine ${spinning ? 'slot-spinning' : ''} ${idle ? 'slot-idle' : ''}`}>
    <div className="slot-frame">
      {SLOT_REELS.map((reel, index) => <div className="slot-reel" key={reel}>
        <div
          className="slot-reel-strip"
          style={{
            // Percentages would resolve against the whole strip, so the reel
            // travels in explicit cell-height units instead.
            transform: `translate3d(0, calc(var(--slot-cell-size) * ${-offsets[index]}), 0)`,
            transition: spinning ? `transform ${REEL_DURATIONS_MS[index]}ms cubic-bezier(.16,.72,.2,1)` : 'none',
          }}
        >
          {Array.from({ length: STRIP_COPIES * SLOT_SYMBOLS_PER_REEL }, (_, cell) => {
            const position = (cell % SLOT_SYMBOLS_PER_REEL) + 1;
            const checksum = checksums.get(`${reel}-${position}`);
            return <div className="slot-cell" key={cell}>
              {checksum
                ? <img src={slotSymbolUrl(gameId, reel, position, checksum)} alt={`Reel ${reel} symbol ${slotSymbolLetter(position)}`} draggable={false} />
                : <span className="slot-cell-placeholder">{slotSymbolLetter(position)}</span>}
            </div>;
          })}
        </div>
        <div className="slot-reel-shade" aria-hidden="true" />
      </div>)}
      <div className="slot-payline" aria-hidden="true" />
    </div>
  </div>;
}
