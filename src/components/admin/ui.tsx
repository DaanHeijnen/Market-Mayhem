import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CoinIcon } from '../shared/CoinIcon';

export function Card({ children, style, className = '' }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return <section className={`card ${className}`} style={style}>{children}</section>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><div className="display empty-title">{title}</div>{children && <div className="muted empty-copy">{children}</div>}</div>;
}

export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral'|'open'|'success'|'danger'|'warning' }) {
  return <span className={`pill status-pill status-${tone}`}>{children}</span>;
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
