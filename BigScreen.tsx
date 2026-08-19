import { useMemo } from 'react';
import { useGamePolling } from '../../hooks/useGamePolling';
import { RouletteTable, type RouletteMarker } from '../shared/RouletteTable';
import { RouletteWheel } from '../shared/RouletteWheel';
import { CoinIcon } from '../shared/CoinIcon';

const QUESTION_EMOJIS = ['🍆', '🌽', '🍑', '😳'] as const;
const money = (n: number) => new Intl.NumberFormat().format(n);

export function BigScreen({ gameId }: { gameId: number }) {
  const { data: s, error } = useGamePolling<any>(gameId, 'screen', `/api/screen-state?gameId=${gameId}`);
  if (!s) return <div className="screen-loading">{error ? 'LIVE CONNECTION INTERRUPTED' : 'MARKET MAYHEM'}</div>;
  if (s.mode === 'ROUND_BLOCK' && s.block) return <BlockScene block={s.block} round={s.round} />;
  if (s.mode === 'PREDICTIONS_OPEN' && s.prediction) return <PredictionScene p={s.prediction} phase="OPEN" />;
  if (s.mode === 'PREDICTION_LOCKED' && s.prediction) return <PredictionScene p={s.prediction} phase="LOCKED" />;
  if (s.mode === 'PREDICTION_RESULT' && s.prediction) return <PredictionScene p={s.prediction} phase="RESULT" />;
  if (s.mode === 'ROULETTE') return <RouletteScene roulette={s.roulette} round={s.round} block={s.block} />;
  return <Dashboard s={s} error={error} />;
}

function Dashboard({ s, error }: { s: any; error: string }) {
  return <div className="exchange-screen">
    <header className="exchange-header">
      <div><div className="label muted">MARKET MAYHEM · LIVE EXCHANGE</div><div className="display exchange-title">{s.round ? `R${String(s.round.number).padStart(2, '0')} · ${s.round.title}` : s.game.name}</div></div>
      <div className="screen-stats"><Stat label="MARKETS OPEN" value={s.marketsOpen} /><Stat label="TOTAL COINS IN PLAY" value={money(s.totalCoinsInPlay)} coin /></div>
    </header>
    <div className="exchange-dashboard-grid">
      <section className="exchange-panel graph-panel">
        <div className="exchange-panel-title"><div><div className="label muted">PLAYER VALUE · ECONOMIC CHRONOLOGY</div><div className="display panel-title">LIVE VALUE GRAPH</div></div></div>
        <PlayerGraph players={s.leaderboard} />
      </section>
      <aside className="exchange-panel results-panel">
        <div className="label muted">LATEST RESOLVED MARKETS</div>
        <h2 className="display panel-title">Prediction results</h2>
        {s.recentPredictionResults.length === 0 ? <div className="dashboard-empty">No settled predictions yet.</div> : <div className="result-stack">{s.recentPredictionResults.map((p: any) => <div className={`prediction-result-row result-${String(p.result).toLowerCase()}`} key={p.id}><div><span className="label">PREDICTION #{p.number}</span><p>{p.question}</p></div><div className="result-side">{p.result}</div></div>)}</div>}
        <div className="market-values market-values-vertical">{s.leaderboard.map((p: any) => <ValueChip key={p.id} p={p} />)}</div>
      </aside>
    </div>
    <Ticker items={s.ticker} />
    {error && <div className="screen-error">LIVE CONNECTION INTERRUPTED</div>}
  </div>;
}

function PlayerGraph({ players }: { players: any[] }) {
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

function ValueChip({ p }: { p: any }) {
  const base = Number(p.starting_balance), current = Number(p.current_balance);
  const pct = base > 0 ? Math.round(((current - base) / base) * 100) : null;
  const up = pct != null && pct >= 0;
  return <div className="value-chip"><span><i style={{ background: p.public_color }} />{String(p.display_name).toUpperCase()}</span><b>{current}</b><em className={pct == null ? 'muted' : up ? 'pos' : 'neg'}>{pct == null ? '—' : `${up ? '▲' : '▼'} ${pct > 0 ? '+' : ''}${pct}%`}</em></div>;
}

function Ticker({ items }: { items: any[] }) {
  if (!items.length) return <div className="ticker"><div className="ticker-track"><span className="display">NO TRANSACTIONS YET · MARKET MAYHEM</span></div></div>;
  const labels = items.map(t => {
    const name = String(t.display_name).toUpperCase();
    const amount = `${t.amount > 0 ? '+' : ''}${t.amount}`;
    if (t.transaction_type === 'PREDICTION_DEPOSIT') return `${name} ${amount} AVAILABLE · PREDICTION #${t.prediction_number} DEPOSIT LOCKED`;
    if (t.transaction_type === 'ROULETTE_STAKE') return `${name} ${amount} AVAILABLE · ROULETTE #${t.roulette_game_id} CHIP LOCKED`;
    const context = t.prediction_number ? `PREDICTION #${t.prediction_number}` : t.roulette_game_id ? `ROULETTE #${t.roulette_game_id}` : t.round_number ? `ROUND ${String(t.round_number).padStart(2, '0')}` : String(t.description).toUpperCase();
    return `${name} ${amount} · ${context}`;
  });
  return <div className="ticker"><div className="ticker-track">{[...labels, ...labels].map((x, i) => <span className="display" key={i}>{x}</span>)}</div></div>;
}

function BlockScene({ block, round }: { block: any; round: any }) {
  if (block.type === 'DUOLINGO_QUESTION') return <DuolingoScene block={block} round={round} />;
  const question = block.type === 'QUESTION';
  return <Scene className={question ? 'question-scene' : 'text-scene'}><div className="scene-eyebrow">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'ROUND CONTENT'}</div><div className="scene-kicker">{question ? 'QUESTION' : 'ROUND NOTE'}</div>{block.title && <h1>{block.title}</h1>}{block.payload?.body && <p className="scene-body">{block.payload.body}</p>}</Scene>;
}

function DuolingoScene({ block, round }: { block: any; round: any }) {
  const correct = block.payload?.correctAnswerIndex;
  const revealed = ['REVEALED', 'SETTLED'].includes(block.interactive_status) && Number.isInteger(Number(correct));
  return <div className="duo-screen">
    <div className="duo-topline"><span>{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'LIVE QUESTION'}</span><span className="pill">{block.interactive_status || 'READY'} · {block.answer_count || 0} ANSWERS</span></div>
    <h1>{block.title}</h1>
    <div className="duo-answer-grid">{(block.payload?.answers || []).map((answer: string, index: number) => <div className={`duo-answer-card ${revealed && Number(correct) === index ? 'correct' : revealed ? 'dimmed' : ''}`} key={index}><span className="duo-emoji">{QUESTION_EMOJIS[index]}</span><b>{answer}</b>{revealed && Number(correct) === index && <small>CORRECT</small>}</div>)}</div>
    <div className="duo-footer">{block.interactive_status === 'OPEN' ? 'ANSWER NOW ON YOUR PHONE' : block.interactive_status === 'CLOSED' ? 'ANSWERS LOCKED' : revealed ? `CORRECT ANSWER REVEALED${Number(block.payload?.rewardCoins || 0) > 0 ? ` · +${block.payload.rewardCoins} COINS` : ''}` : 'GET READY'}</div>
  </div>;
}

function PredictionScene({ p, phase }: { p: any; phase: 'OPEN' | 'LOCKED' | 'RESULT' }) {
  if (phase === 'RESULT') return <div className={`prediction-screen result-${String(p.result).toLowerCase()}`}><div className="scene-eyebrow">PREDICTION #{p.number} · RESOLVED</div><h1>{p.result} WINS</h1><p>{p.question}</p><div className="big-odds"><div className="yes"><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></div><div className="no"><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></div></div></div>;
  return <div className={`prediction-screen prediction-${phase.toLowerCase()}`}><div className="scene-eyebrow">PREDICTION #{p.number}</div><h1>{phase === 'OPEN' ? 'PREDICTION OPEN' : 'MARKET LOCKED'}</h1><p>{p.question}</p><div className="big-odds"><div className="yes"><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></div><div className="no"><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></div></div><div className="scene-footer">{phase === 'OPEN' ? 'PLACE YOUR BET ON YOUR PHONE' : 'NO MORE BETS · WAITING FOR RESULT'}</div></div>;
}

function RouletteScene({ roulette: r, round, block }: { roulette: any; round: any; block: any }) {
  const markers: RouletteMarker[] = (r?.public_bets || []).map((b: any) => ({ id: b.id, betType: b.betType, selection: String(b.selection), stake: Number(b.stake), displayName: b.displayName, color: b.color }));
  return <div className="roulette-screen">
    <div className="roulette-screen-header"><div><div className="label muted">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div><h1 className="display">{block?.title || 'ROULETTE'}</h1></div><div className="roulette-status"><span>{r?.status || 'READY'}</span><b>{markers.length} chips</b></div></div>
    {!r ? <div className="screen-center-message">ROULETTE READY</div> : r.status === 'CANCELLED' ? <div className="screen-center-message">ROULETTE CANCELLED<small>Active stakes refunded</small></div> : <div className="roulette-screen-grid"><RouletteWheel status={r.status} resultNumber={r.result_number} /><div className="roulette-board-wrap"><RouletteTable markers={markers} disabled compact={false} /><div className="roulette-board-caption">{r.status === 'OPEN' ? 'BETTING OPEN · CHIPS UPDATE LIVE' : r.status === 'LOCKED' ? 'BETS LOCKED' : r.status === 'SPINNING' ? 'SPINNING…' : r.result_number != null ? `RESULT · ${r.result_number}` : 'ROULETTE'}</div></div></div>}
  </div>;
}

function Scene({ children, className = '' }: { children: any; className?: string }) { return <div className={`screen-scene ${className}`}>{children}</div>; }
function Stat({ label, value, coin = false }: { label: string; value: any; coin?: boolean }) { return <div className="screen-stat"><div className="label muted">{label}</div><div className="display">{coin && <CoinIcon size={24} />}{value}</div></div>; }
