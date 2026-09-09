import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CoinIcon } from '../shared/CoinIcon';

export function Card({ children, style, className = '' }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return <section className={`card ${className}`} style={style}>{children}</section>;
}

/** Uppercase eyebrow above a card's content (design handbook 01 — Micro / eyebrow). */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`label muted ${className}`}>{children}</div>;
}

/**
 * Collapsible card section. Used on the Control Center so the host sees the
 * live controls first and reference data stays one click away.
 */
export function Accordion({ title, open, onToggle, children, className = '' }: { title: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  return <Card className={`accordion-card ${className}`}>
    <button className="accordion-head" aria-expanded={open} onClick={onToggle}>
      <div className="label muted">{title}</div>
      <span className="accordion-icon" aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <div className="accordion-body">{children}</div>}
  </Card>;
}

/** Navigational chip used for the Control Center orientation row. */
export function Chip({ children, tone = 'white', onClick }: { children: ReactNode; tone?: 'white' | 'ink' | 'blue'; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'span';
  return <Tag className={`chip chip-${tone}`} onClick={onClick}>{children}</Tag>;
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="chip-row">{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="display empty-title">{title}</div>{children && <div className="muted empty-copy">{children}</div>}</div>;
}

export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral'|'open'|'success'|'danger'|'warning' }) {
  return <span className={`pill status-pill status-${tone}`}>{children}</span>;
}

/**
 * Horizontal fill bar.
 *
 * A design-system primitive rather than a one-off, because "how far along is the room"
 * is a shape the Control Center wants in more than one place — the live question's
 * participation readout is only the first. Takes a whole percent and clamps it, so a
 * caller can hand it a raw ratio without guarding the ends itself.
 */
export function ProgressBar({ percentage, tone = 'blue', label }: { percentage: number; tone?: 'blue' | 'success' | 'ink'; label?: string }) {
  const pct = Math.min(100, Math.max(0, Math.round(percentage) || 0));
  return <div
    className="progress-bar"
    role="progressbar"
    aria-valuenow={pct}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label}
  >
    <div className={`progress-bar-fill tone-${tone}`} style={{ width: `${pct}%` }} />
  </div>;
}

export function CoinAmount({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`coin-amount ${className}`}><CoinIcon size={18}/><span>{value}</span></span>;
}

export function Countdown({ closesAt }: { closesAt?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!closesAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [closesAt]);
  if (!closesAt) return <span>—</span>;
  const ms = Math.max(0, new Date(closesAt).getTime() - now);
  const sec = Math.ceil(ms / 1000);
  return <span>{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}</span>;
}
