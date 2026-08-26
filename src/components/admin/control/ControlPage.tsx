import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Accordion, Card, Countdown, Empty, Status } from '../ui';
import { CoinIcon } from '../../shared/CoinIcon';
import { blockLabel, blockMeta } from '../blockMeta';

/** A presentable thing, described for the staged card. */
type Described = { accent: string; eyebrow: string; title: string; sub: string; badge: string };

export function ControlPage({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const nav = useNavigate();
  const [playerId, setPlayerId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [roundId, setRoundId] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustmentKey, setAdjustmentKey] = useState(() => crypto.randomUUID());
  const [denying, setDenying] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [open, setOpen] = useState({ predictions: true, ledger: false, adjust: false });
  const toggle = (key: keyof typeof open) => () => setOpen(current => ({ ...current, [key]: !current[key] }));

  const activePlayers = s.players.filter((p: any) => p.active);
  const activeRound = s.rounds.find((r: any) => r.id === s.game.current_round_id) || null;
  const upcomingRounds = s.rounds.filter((r: any) => r.status === 'UPCOMING');
  const blocks = activeRound?.blocks || [];
  const activeRoulette = s.activeRoulette;
  const isFresh = activePlayers.length === 0 && s.rounds.length === 0 && s.predictions.length === 0;

  const live = s.screen || {};
  const staged = live.staged || {};
  const runOfShow: any[] = s.runOfShow || [];
  const liveIndex = runOfShow.findIndex(step => stepMatches(step, live));
  const sameAsLive = staged.mode === live.mode && (staged.blockId || null) === (live.blockId || null) && (staged.predictionId || null) === (live.predictionId || null);
  const pendingRequests = (s.predictionRequests || []).filter((r: any) => r.status === 'PENDING');

  const findBlock = (id: number | null) => {
    if (!id) return null;
    for (const round of s.rounds) { const found = round.blocks.find((b: any) => b.id === id); if (found) return found; }
    return null;
  };

  const describe = (slot: any): Described => {
    if (!slot?.mode) return { accent: 'muted', eyebrow: 'NOTHING STAGED', title: '—', sub: 'Pick a step from the run of show below.', badge: 'IDLE' };
    if (slot.mode === 'DASHBOARD') return { accent: 'ink', eyebrow: 'MARKET DASHBOARD', title: 'Coin value chart & live ticker', sub: 'The exchange dashboard with every player’s trend line.', badge: 'DASHBOARD' };
    if (slot.blockId) {
      const block = findBlock(slot.blockId);
      if (!block) return { accent: 'muted', eyebrow: 'CONTENT REMOVED', title: '—', sub: 'This step no longer exists.', badge: 'IDLE' };
      const meta = blockMeta(block.type);
      return { accent: meta.accent, eyebrow: meta.label.toUpperCase(), title: blockLabel(block), sub: meta.description, badge: block.interactive_status || 'STATIC' };
    }
    const prediction = s.predictions.find((p: any) => p.id === slot.predictionId);
    if (!prediction) return { accent: 'muted', eyebrow: 'MARKET REMOVED', title: '—', sub: 'This market no longer exists.', badge: 'IDLE' };
    return { accent: 'blue', eyebrow: `PREDICTION #${prediction.display_number}`, title: prediction.question, sub: 'Players vote and bet on this from their phones.', badge: prediction.status };
  };

  const stagedView = describe(staged);
  const liveBlock = findBlock(live.blockId);
  const livePrediction = s.predictions.find((p: any) => p.id === live.predictionId) || null;

  const stage = (step: any) => step.kind === 'block'
    ? run('/api/stage-item', { kind: 'block', roundId: step.roundId, blockId: step.id })
    : run('/api/stage-item', { kind: 'prediction', predictionId: step.id });
  const goLive = () => run('/api/go-live', {});
  const rouletteAction = (action: string) => activeRoulette && run('/api/roulette-action', { rouletteGameId: activeRoulette.id, action }, true);
  const questionAction = (action: string) => liveBlock && run('/api/question-action', { blockId: liveBlock.id, action });

  const adjust = async () => {
    if (adjusting) return;
    setAdjusting(true);
    try {
      if (await run('/api/adjust-coins', { playerId: Number(playerId), amount: Number(amount), reason, roundId: roundId ? Number(roundId) : null }, true, adjustmentKey)) {
        setAmount('');
        setReason('');
        setAdjustmentKey(crypto.randomUUID());
      }
    } finally { setAdjusting(false); }
  };

  const confirmDeny = async (id: number) => {
    if (!denyReason.trim()) return;
    if (await run('/api/review-prediction-request', { requestId: id, decision: 'DENIED', reason: denyReason.trim() })) {
      setDenying(null);
      setDenyReason('');
    }
  };

  // Contextual controls for whatever is live. Mirrors the design's buildActions, and
  // keeps CANCEL + REFUND, which the design omits but the game still needs.
  const liveActions = () => {
    if (liveBlock?.type === 'DUOLINGO_QUESTION') {
      const status = liveBlock.interactive_status || 'READY';
      return <>
        {status === 'READY' && <button className="btn btn-blue" onClick={() => questionAction('OPEN')}>OPEN ANSWERS</button>}
        {status === 'OPEN' && <button className="btn btn-secondary" onClick={() => questionAction('CLOSE')}>CLOSE ANSWERS</button>}
        {status === 'CLOSED' && <button className="btn btn-success" onClick={() => questionAction('REVEAL')}>REVEAL + REWARD</button>}
        {status === 'REVEALED' && <button className="btn btn-secondary" onClick={() => questionAction('SETTLE')}>MARK SETTLED</button>}
        <span className="muted live-meta">{liveBlock.answer_count || 0} of {activePlayers.length} answered · {Number(liveBlock.payload?.rewardCoins || 0)} coin reward</span>
      </>;
    }
    if (liveBlock?.type === 'ROULETTE') {
      if (!activeRoulette) return <span className="muted live-meta">No spin yet — going live on this block creates one.</span>;
      return <>
        {activeRoulette.status === 'DRAFT' && <button className="btn btn-success" onClick={() => rouletteAction('OPEN')}>OPEN BETTING</button>}
        {activeRoulette.status === 'OPEN' && <button className="btn btn-secondary" onClick={() => rouletteAction('CLOSE')}>CLOSE BETTING</button>}
        {activeRoulette.status === 'LOCKED' && <button className="btn btn-blue" onClick={() => rouletteAction('SPIN')}>SPIN</button>}
        {activeRoulette.status === 'SPINNING' && <button className="btn btn-secondary" disabled>SPINNING…</button>}
        {activeRoulette.status === 'RESULT' && <button className="btn btn-success" onClick={() => rouletteAction('SETTLE')}>CONFIRM + SETTLE</button>}
        {['DRAFT', 'OPEN', 'LOCKED'].includes(activeRoulette.status) && <button className="btn btn-danger-ghost" onClick={() => rouletteAction('CANCEL')}>CANCEL + REFUND</button>}
        <span className="muted live-meta">{activeRoulette.bet_count} bets · {activeRoulette.total_stake} staked{activeRoulette.result_number != null ? ` · result ${activeRoulette.result_number}` : ''}</span>
      </>;
    }
    if (livePrediction) {
      return <>
        {livePrediction.status === 'OPEN' && <button className="btn btn-secondary" onClick={() => run('/api/lock-prediction', { predictionId: livePrediction.id })}>LOCK NOW</button>}
        {livePrediction.status === 'LOCKED' && <><button className="btn btn-success" onClick={() => run('/api/set-prediction-result', { predictionId: livePrediction.id, result: 'YES' })}>RESULT YES</button><button className="btn btn-danger" onClick={() => run('/api/set-prediction-result', { predictionId: livePrediction.id, result: 'NO' })}>RESULT NO</button></>}
        {livePrediction.status === 'RESULT' && <button className="btn btn-lime" onClick={() => run('/api/settle-prediction', { predictionId: livePrediction.id }, true)}>SETTLE PAYOUTS</button>}
        {['OPEN', 'LOCKED'].includes(livePrediction.status) && <button className="btn btn-danger-ghost" onClick={() => run('/api/cancel-prediction', { predictionId: livePrediction.id }, true)}>CANCEL + REFUND</button>}
        {livePrediction.status === 'OPEN' && <span className="muted live-meta mono"><Countdown closesAt={livePrediction.closes_at} /> left</span>}
      </>;
    }
    return null;
  };

  const openMarkets = s.predictions.filter((p: any) => !['SETTLED', 'CANCELLED'].includes(p.status));

  return <div className="page-stack">
    {isFresh && <Card><div className="label muted">FIRST SETUP</div><h2 className="display card-heading">Build your game before going live</h2><div className="setup-flow"><b>Settings</b><span>→</span><b>Players</b><span>→</span><b>Rounds</b><span>→</span><b>Round Content</b><span>→</span><b>Predictions</b><span>→</span><b>Control</b></div></Card>}

    {/* Player-proposed markets, pinned above everything — they are the one thing here
        that someone else is waiting on. */}
    {pendingRequests.length > 0 && <div className="request-panel">
      <div className="label">PLAYER PREDICTION REQUESTS — NEEDS REVIEW</div>
      {pendingRequests.map((request: any) => <div className="request-row" key={request.id}>
        <div>
          <b className="request-player">{request.playerName}</b>
          <div className="request-question">{request.question}</div>
        </div>
        {denying === request.id ? <div className="request-deny">
          <input className="field" autoFocus placeholder="Reason for denying (required)" value={denyReason} onChange={e => setDenyReason(e.target.value)} />
          <div className="presenter-actions">
            <button className="btn btn-primary" disabled={!denyReason.trim()} onClick={() => confirmDeny(request.id)}>CONFIRM DENY</button>
            <button className="btn btn-secondary on-colour" onClick={() => { setDenying(null); setDenyReason(''); }}>CANCEL</button>
          </div>
        </div> : <div className="presenter-actions">
          <button className="btn btn-success" onClick={() => run('/api/review-prediction-request', { requestId: request.id, decision: 'APPROVED' })}>APPROVE</button>
          <button className="btn btn-secondary on-colour" onClick={() => { setDenying(request.id); setDenyReason(''); }}>DENY</button>
        </div>}
      </div>)}
    </div>}

    {/* Round control. Kept prominent per backlog items 2, 4, 16 and 17 — starting and
        completing a round, and stepping through it, are the host's core actions. */}
    <Card>
      <div className="row-between control-round-head">
        <div>
          <div className="label muted">{activeRound ? 'CURRENT ROUND' : 'NO ROUND ACTIVE'}</div>
          {activeRound
            ? <><div className="display card-heading">R{String(activeRound.round_number).padStart(2, '0')} · {activeRound.title}</div><div className="muted">{liveIndex >= 0 ? `Part ${liveIndex + 1} of ${runOfShow.length}` : `${runOfShow.length} parts in this round`}</div></>
            : <div className="muted">Start a round to begin the run of show.</div>}
        </div>
        {activeRound && <Status tone="open">{activeRound.status}</Status>}
      </div>
      <div className="content-controls">
        {activeRound ? <>
          <button className="btn btn-secondary btn-compact" disabled={liveIndex <= 0} onClick={() => stage(runOfShow[liveIndex - 1]).then(goLive)}>← PREVIOUS</button>
          <button className="btn btn-secondary btn-compact" disabled={liveIndex < 0 || liveIndex >= runOfShow.length - 1} onClick={() => stage(runOfShow[liveIndex + 1]).then(goLive)}>NEXT →</button>
          <button className="btn btn-primary btn-compact" onClick={() => run('/api/complete-round', { roundId: activeRound.id })}>COMPLETE ROUND</button>
        </> : upcomingRounds.length === 0
          ? <span className="muted">No upcoming rounds — create one on the Rounds page.</span>
          : upcomingRounds.map((round: any) => <button key={round.id} className="btn btn-primary btn-compact" onClick={() => run('/api/start-round', { roundId: round.id })}>START R{String(round.round_number).padStart(2, '0')} · {round.title}</button>)}
      </div>
    </Card>

    {/* The presenter pair. Live is the real projector output scaled down, so it cannot
        drift from what the audience sees; staged cannot be an iframe because it is not
        on screen yet, so it renders the step's identity in its accent colour. */}
    <div className="presenter-grid">
      <div className="presenter-col">
        <div className="presenter-label">
          <div className="label muted">LIVE — ON THE PROJECTOR NOW</div>
          <a className="btn btn-secondary btn-compact" href={`/screen/${gameId}`} target="_blank" rel="noreferrer">OPEN FULL SCREEN ↗</a>
        </div>
        <LiveScreenPreview gameId={gameId} />
        <div className="presenter-actions">{liveActions()}</div>
      </div>

      <div className="presenter-col">
        <div className="label muted">{sameAsLive ? 'PREVIEW — ALREADY LIVE' : 'PREVIEW — STAGED, NOT LIVE YET'}</div>
        <div className={`staged-card accent-${stagedView.accent} ${sameAsLive ? '' : 'is-pending'}`}>
          <div className="row-between">
            <div className="staged-eyebrow">{stagedView.eyebrow}</div>
            <div className="staged-badge">{stagedView.badge}</div>
          </div>
          <div className="staged-title">{stagedView.title}</div>
          <p className="staged-sub">{stagedView.sub}</p>
        </div>
        <button className="btn btn-lime go-live-btn" disabled={sameAsLive || !staged.mode} onClick={goLive}>
          {sameAsLive ? 'ALREADY LIVE' : 'GO LIVE →'}
        </button>
      </div>
    </div>

    {/* One ordered timeline for the round: content blocks, then its unresolved markets.
        Ordered by the server so this and GO LIVE can never disagree. */}
    {activeRound && runOfShow.length > 0 && <Card>
      <div className="label muted">RUN OF SHOW — R{String(activeRound.round_number).padStart(2, '0')} · {activeRound.title}</div>
      <div className="run-of-show">
        <div className="run-of-show-track">
          {runOfShow.map(step => {
            const meta = step.kind === 'block' ? blockMeta(step.type) : { label: 'Prediction', accent: 'blue' };
            const isLive = stepMatches(step, live);
            const isStaged = !isLive && stepMatches(step, staged);
            return <button
              key={`${step.kind}-${step.id}`}
              className={`run-step accent-${meta.accent} ${isLive ? 'is-live' : ''} ${isStaged ? 'is-staged' : ''}`}
              onClick={() => stage(step)}
            >
              <span className="accent-dot" />
              <span className="run-step-copy">
                <span className="run-step-kicker">{step.kind === 'block' ? meta.label : 'Prediction'}</span>
                <span className="run-step-label">{step.label}</span>
              </span>
            </button>;
          })}
        </div>
      </div>
    </Card>}

    <div className="control-grid">
      <div className="page-stack control-main-column">
        <Accordion title={`ALL PREDICTIONS (${openMarkets.length} ACTIVE)`} open={open.predictions} onToggle={toggle('predictions')}>
          {openMarkets.length === 0 ? <p className="muted">No active predictions.</p> : <div className="active-market-stack">{openMarkets.map((p: any) => <div className="market-line" key={p.id}>
            <div className="market-line-copy">
              <b>#{p.display_number} · {p.question}{p.round_number ? ` · R${String(p.round_number).padStart(2, '0')}` : ' · No round'}</b>
              <div className="muted">{p.participation_count} / {activePlayers.length} participated · <span className="yes-text">YES {p.yes_odds.toFixed(2)}x</span> · <span className="no-text">NO {p.no_odds.toFixed(2)}x</span></div>
            </div>
            <div className="market-line-actions">
              <Status tone={p.status === 'OPEN' ? 'open' : 'neutral'}>{p.status}</Status>
              {p.status === 'OPEN' && <div className="mono countdown-inline"><Countdown closesAt={p.closes_at} /></div>}
              {['DRAFT', 'SCHEDULED'].includes(p.status)
                ? <button className="btn btn-primary btn-compact" onClick={() => run('/api/open-prediction', { predictionId: p.id })}>OPEN NOW</button>
                : <button className="btn btn-secondary btn-compact" onClick={() => run('/api/stage-item', { kind: 'prediction', predictionId: p.id })}>STAGE</button>}
              {p.status === 'OPEN' && <button className="btn btn-secondary btn-compact" onClick={() => run('/api/lock-prediction', { predictionId: p.id })}>LOCK NOW</button>}
              {p.status === 'LOCKED' && <><button className="btn btn-success btn-compact" onClick={() => run('/api/set-prediction-result', { predictionId: p.id, result: 'YES' })}>RESULT YES</button><button className="btn btn-danger btn-compact" onClick={() => run('/api/set-prediction-result', { predictionId: p.id, result: 'NO' })}>RESULT NO</button></>}
              {p.status === 'RESULT' && <button className="btn btn-primary btn-compact" onClick={() => run('/api/settle-prediction', { predictionId: p.id }, true)}>SETTLE PAYOUTS</button>}
              {['DRAFT', 'SCHEDULED', 'OPEN', 'LOCKED'].includes(p.status) && <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/cancel-prediction', { predictionId: p.id }, true)}>CANCEL + REFUND</button>}
            </div>
          </div>)}</div>}
        </Accordion>

        <Accordion title="RECENT LEDGER" open={open.ledger} onToggle={toggle('ledger')}>
          {s.recentTransactions.length === 0 ? <p className="muted">No transactions yet</p> : s.recentTransactions.slice(0, 10).map((x: any) => <div className="ledger-line" key={x.id}><span><b>{x.display_name}</b> · {x.description}</span><b className={x.amount >= 0 ? 'pos' : 'neg'}>{x.amount > 0 ? '+' : ''}{x.amount}</b></div>)}
        </Accordion>
      </div>

      <div className="page-stack control-side-column">
        {activeRound ? <Card>
          <div className="label muted">THIS ROUND'S CONTENT</div>
          <p className="muted round-content-copy">The order below is exactly what plays out in the run of show.</p>
          {blocks.length === 0 ? <div className="sub-empty">No content blocks yet.</div> : <div className="round-content-summary">
            {blocks.map((b: any, index: number) => <div key={b.id} className={`round-content-line accent-${blockMeta(b.type).accent}`}>
              <span className="accent-dot" />
              <span>{index + 1}. {blockLabel(b)}</span>
              {live.blockId === b.id && <em>LIVE</em>}
            </div>)}
          </div>}
          <button className="btn btn-secondary btn-full round-content-edit" onClick={() => nav(`/admin/${gameId}/rounds/${activeRound.id}`)}>EDIT ROUND CONTENT</button>
        </Card> : <Empty title="No active round" />}

        {activeRound?.groups?.length > 0 && <Card>
          <div className="label muted">GROUPS THIS ROUND</div>
          <div className="round-content-summary">
            {activeRound.groups.map((group: any) => <div key={group.id} className="round-content-line">
              <span>{group.name} <span className="muted">· {group.members.map((m: any) => m.display_name).join(', ') || 'no members'}</span></span>
            </div>)}
          </div>
          <button className="btn btn-secondary btn-full round-content-edit" onClick={() => nav(`/admin/${gameId}/rounds/${activeRound.id}`)}>EDIT GROUPS + SCORING</button>
        </Card>}

        <Accordion className="on-ink quick-adjust-card" title="QUICK COIN ADJUSTMENT" open={open.adjust} onToggle={toggle('adjust')}>
          <div className="quick-adjust-grid">
            <select className="field" value={playerId} onChange={e => setPlayerId(e.target.value)}><option value="">Player</option>{activePlayers.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} · {p.current_balance}</option>)}</select>
            <input className="field" type="number" placeholder="25 or -10" value={amount} onChange={e => setAmount(e.target.value)} />
            <select className="field" value={roundId} onChange={e => setRoundId(e.target.value)}><option value="">General / no round</option>{s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}</select>
            <input className="field quick-reason" placeholder="Mandatory reason" value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-full quick-save" disabled={adjusting || !playerId || !reason.trim() || !amount || Number(amount) === 0} onClick={adjust}>{adjusting ? 'SAVING…' : <><CoinIcon size={16} /> SAVE ADJUSTMENT</>}</button>
        </Accordion>
      </div>
    </div>
  </div>;
}

function stepMatches(step: any, slot: any) {
  if (!step || !slot?.mode) return false;
  return step.kind === 'block' ? slot.blockId === step.id : slot.predictionId === step.id;
}

const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;

function LiveScreenPreview({ gameId }: { gameId: number }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const updateScale = () => setScale(preview.clientWidth / SCREEN_WIDTH);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  return <div className="screen-preview" ref={previewRef}>
    <iframe
      title="Live Big Screen"
      src={`/screen/${gameId}`}
      width={SCREEN_WIDTH}
      height={SCREEN_HEIGHT}
      style={{ transform: `scale(${scale})` }}
    />
  </div>;
}
