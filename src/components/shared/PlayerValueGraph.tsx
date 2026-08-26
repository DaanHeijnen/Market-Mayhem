import { useMemo } from 'react';

/**
 * Player value over time, plotted as a delta against each player's starting balance.
 *
 * Shared by the Big Screen dashboard and the Admin Market page so both surfaces show
 * the same chart from the same data. Type and dot sizes come from the surrounding
 * surface (`.graph-wrap` on Big Screen scales in vw; the admin page overrides to px),
 * so this component never hard-codes a scale.
 */
export function PlayerValueGraph({ players }: { players: any[] }) {
  const bounds = useMemo(() => {
    const all = players.flatMap(p => (p.series || []).map((x: any) => ({ x: Number(x.x), delta: Number(x.balance) - Number(p.starting_balance) })));
    const maxX = Math.max(1, ...all.map(x => x.x));
    const maxAbs = Math.max(1, ...all.map(x => Math.abs(x.delta)));
    return { maxX, maxAbs };
  }, [players]);
  if (players.length === 0) return <div className="graph-empty display">NO PLAYERS YET</div>;
  const w = 1000, h = 500, pad = 48, mid = h / 2;
  const point = (x: number, delta: number) => `${pad + (x / bounds.maxX) * (w - pad * 2)},${mid - (delta / bounds.maxAbs) * (h / 2 - pad)}`;
  return <div className="graph-wrap">
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Player value history relative to starting balance">
      <g className="grid-lines">{[0, 1, 2, 3, 4].map(i => <line key={i} x1={pad} x2={w - pad} y1={pad + i * (h - pad * 2) / 4} y2={pad + i * (h - pad * 2) / 4} />)}</g>
      <line className="graph-baseline" x1={pad} x2={w - pad} y1={mid} y2={mid} />
      {players.map((p, index) => { const series = p.series || []; const last = series[series.length - 1]; const [cx, cy] = last ? point(Number(last.x), Number(last.balance) - Number(p.starting_balance)).split(',').map(Number) : [pad, mid]; return <g key={p.id}><polyline className="graph-line" style={{ animationDelay: `${0.05 + index * 0.15}s` }} points={series.map((x: any) => point(Number(x.x), Number(x.balance) - Number(p.starting_balance))).join(' ')} fill="none" stroke={p.public_color} strokeWidth={index === 0 ? "7" : "6"} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /><circle className="graph-end-dot" style={{ animationDelay: `${1.7 + index * 0.2}s` }} cx={cx} cy={cy} r="7" fill={p.public_color} /></g>; })}
    </svg>
    <div className="graph-axis-label positive">GAIN</div><div className="graph-axis-label baseline">START</div><div className="graph-axis-label negative">LOSS</div>
    <div className="graph-legend">{players.map(p => <div key={p.id}><span className="legend-dot" style={{ background: p.public_color }} /><b>{p.display_name}</b><strong>{p.current_balance}</strong></div>)}</div>
  </div>;
}
