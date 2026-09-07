import { useEffect, useMemo, useRef, useState } from 'react';

export type SlotReelSymbol = { position: number; letter: string; mediaKey: string };
/** A cell of the landed field: [row, column]. */
export type SlotWinCell = [number, number];

const mediaUrl = (key: string) => `/api/block-media?key=${encodeURIComponent(key)}`;

/** Rows visible per reel. Row 1 is the main row — the one that pays for pairs. */
const VISIBLE = 3;
/** How many times the symbol strip is repeated above the landing rows, to spin through. */
const LOOPS = 5;

/**
 * The 3x3 field, for the Big Screen only.
 *
 * The animation is decoration over a decision already made: the server drew an outcome
 * category, built a field that matches it and stored the whole thing before this
 * component was told anything. `field` is that stored field — three rows by three reels
 * — and each reel simply scrolls its strip and lands on its own column of it, staggered
 * so they stop left to right the way a real machine does.
 *
 * `winCells` are the cells the server says form the winning pattern, highlighted once
 * the reels have landed. The overlay is drawn across the whole field rather than per
 * reel, because a diagonal win spans all three.
 */
export function SlotReels({ field, strip, winCells, spinning, spinMs, spinId }: {
  /** [row][column] of the landed symbols, or null before the first spin. */
  field: SlotReelSymbol[][] | null;
  /** The twelve symbols, used as the blur the reels spin through. */
  strip: SlotReelSymbol[];
  winCells: SlotWinCell[];
  spinning: boolean;
  spinMs: number;
  /**
   * Identity of the spin being shown. Needed because two consecutive spins can land on
   * the same symbols — without it, a reel whose column had not changed would sit still.
   */
  spinId?: number | string | null;
}) {
  const isWinning = (row: number, column: number) =>
    !spinning && winCells.some(([r, c]) => r === row && c === column);

  return <div className={`slot-reels ${spinning ? 'is-spinning' : ''}`} aria-live="polite">
    {[0, 1, 2].map(column => <Reel
      key={column}
      strip={strip}
      landing={field ? [field[0]?.[column], field[1]?.[column], field[2]?.[column]] : null}
      spinning={spinning}
      spinId={spinId ?? null}
      /* Left reel settles first. The last reel carries the suspense, so it gets the
         longest run — the same shape as the roulette wheel's single long deceleration. */
      durationMs={spinMs * (0.62 + column * 0.19)}
    />)}

    {/* Highlight overlay: one cell per position, on top of all three reels so a
        diagonal can be drawn as one shape. Purely presentational. */}
    <div className="slot-win-overlay" aria-hidden="true">
      {[0, 1, 2].map(row => [0, 1, 2].map(column => (
        <span key={`${row}-${column}`} className={`slot-win-cell ${isWinning(row, column) ? 'is-win' : ''} ${row === 1 ? 'is-main-row' : ''}`} />
      )))}
    </div>
  </div>;
}

function Reel({ strip, landing, spinning, spinId, durationMs }: {
  strip: SlotReelSymbol[];
  /** The three symbols this reel must show, top to bottom. */
  landing: (SlotReelSymbol | undefined)[] | null;
  spinning: boolean;
  spinId: number | string | null;
  durationMs: number;
}) {
  // The strip the reel scrolls through, ending on the three symbols it must show. The
  // blur above is the twelve symbols repeated; only the final three are the outcome, so
  // the landing frame is always exactly what the server decided.
  const cells = useMemo(() => {
    const blur = Array.from({ length: LOOPS }, () => strip).flat();
    const stop = (landing ?? []).filter(Boolean) as SlotReelSymbol[];
    const tail = stop.length === VISIBLE ? stop : strip.slice(0, VISIBLE);
    return [...blur, ...tail];
  }, [strip, landing]);

  // Offset names the cell at the top of the window, so the landing triple is the last
  // three cells of the strip.
  const restOffset = Math.max(0, cells.length - VISIBLE);
  const [offset, setOffset] = useState(restOffset);
  const [animating, setAnimating] = useState(false);
  const shown = useRef<string>('');

  useEffect(() => {
    // Re-run only when a genuinely new spin arrives, not on every poll that repeats the
    // same one — otherwise the reels would restart mid-animation every few seconds. The
    // spin id is part of this precisely so a repeated field still counts as new.
    const signature = `${spinId ?? 'none'}:${spinning ? 'spin' : 'rest'}`;
    if (shown.current === signature) return;
    shown.current = signature;

    if (!spinning) {
      setAnimating(false);
      setOffset(restOffset);
      return;
    }
    // Jump to the top of the strip without animating, then animate down to the landing.
    setAnimating(false);
    setOffset(0);
    const frame = requestAnimationFrame(() => {
      setAnimating(true);
      setOffset(restOffset);
    });
    return () => cancelAnimationFrame(frame);
  }, [spinning, spinId, restOffset]);

  const total = cells.length;
  return <div className="slot-reel">
    <div
      className="slot-reel-strip"
      style={{
        // Each cell is one third of the reel's height, so three symbols show at once.
        height: `${(total / VISIBLE) * 100}%`,
        transform: `translateY(-${(offset / total) * 100}%)`,
        transition: animating ? `transform ${Math.round(durationMs)}ms cubic-bezier(.16,.84,.24,1)` : 'none',
      }}
    >
      {cells.map((symbol, index) => <div className="slot-cell" key={index}>
        {symbol.mediaKey
          ? <img src={mediaUrl(symbol.mediaKey)} alt="" draggable={false} />
          : <span className="slot-cell-letter">{symbol.letter}</span>}
      </div>)}
    </div>
  </div>;
}
