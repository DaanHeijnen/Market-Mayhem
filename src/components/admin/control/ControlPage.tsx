import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Accordion, Card, Countdown, Status } from '../ui';
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
  const activeRoulette = s.activeRoulette;
  const isFresh = activePlayers.length === 0 && s.rounds.length === 0 && s.predictions.length === 0;

  const live = s.screen || {};
  const staged = live.staged || {};
  const runOfShow: any[] = s.runOfShow || [];
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
  const pezAction = (action: string) => liveBlock && run('/api/pak-een-zes-action', { blockId: liveBlock.id, action });
  const photoAction = (action: string) => liveBlock && run('/api/photo-round-action', { blockId: liveBlock.id, action });

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
    if (liveBlock?.type === 'SLOTMACHINE') {
      const slot = s.activeSlot;
      const config = s.slotConfig?.status;
      // There is no spin button here on purpose: players start their own spins from
      // their phones. What the host needs is whether the machine is usable and who is
      // mid-series, so this panel is status rather than controls.
      if (!config?.valid) return <span className="neg live-meta"><b>Slotmachine unusable — {config?.reason || 'not configured'}</b></span>;
      if (!slot) return <span className="muted live-meta">Slotmachine ready — players lock a series on their phones.</span>;
      const turn = slot.turn;
      return <>
        <span className="muted live-meta">
          {turn?.current
            ? `${turn.current.playerName} is aan de beurt · ${turn.current.spinsRemaining}/${turn.current.totalSpins} spins over${turn.spinning ? ' · draait…' : ''}`
            : turn?.allDone && slot.series.length > 0
              ? 'Alle spelers zijn klaar'
              : 'Nobody has locked a series yet'}
          {' · '}max {slot.maxSpins} spins
          {slot.lockedCoins > 0 ? ` · ${slot.lockedCoins} coins locked in unspun spins` : ''}
        </span>
      </>;
    }
    if (liveBlock?.type === 'FOTORONDE') {
      const photo = s.photoRound;
      const status = photo?.status || 'DRAFT';
      return <>
        {status === 'DRAFT' && <button className="btn btn-blue" onClick={() => photoAction('OPEN')}>OPEN INZENDEN</button>}
        {status === 'OPEN' && <button className="btn btn-secondary" onClick={() => photoAction('CLOSE')}>SLUIT INZENDEN</button>}
        {status === 'CLOSED' && <button className="btn btn-success" onClick={() => photoAction('COMPLETE')}>MARKEER AFGEROND</button>}
        <span className="muted live-meta">
          {photo?.submissionCount ?? 0} foto's · {photo?.judgedCount ?? 0} beoordeeld · {photo?.totalCredits ?? 0} credits toegekend
        </span>
      </>;
    }
    if (liveBlock?.type === 'PAK_EEN_ZES') {
      const pez = s.pakEenZes;
      const status = pez?.status || 'READY';
      const awaiting = pez?.awaitingPrediction || [];
      return <>
        {status === 'READY' && <button className="btn btn-blue" onClick={() => pezAction('OPEN_PREDICTIONS')}>OPEN VOORSPELLINGEN</button>}
        {status === 'PREDICTING' && <button className="btn btn-secondary" onClick={() => pezAction('CLOSE_PREDICTIONS')}>SLUIT VOORSPELLINGEN</button>}
        {status === 'LOCKED' && <button className="btn btn-success" onClick={() => pezAction('START')}>START HET SPEL</button>}
        {status === 'DRAWING' && <span className="muted live-meta">
          {pez?.currentPlayer ? `${pez.currentPlayer.name} is aan de beurt` : 'Waiting for a turn'} · {pez?.drawnCount ?? 0}/52 kaarten · {pez?.sixesFound ?? 0}/4 zessen
        </span>}
        {status === 'FINISHED' && <span className="muted live-meta">Alle vier de zessen gevonden · {pez?.drawnCount ?? 0} kaarten getrokken</span>}
        {status === 'PREDICTING' && <span className="muted live-meta">
          {pez?.predictionCount ?? 0} of {pez?.activePlayerCount ?? 0} predicted
          {awaiting.length > 0 ? ` · still missing: ${awaiting.map((a: any) => a.name).join(', ')}` : ' · everyone is in'}
        </span>}
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

    {liveBlock?.type === 'SLOTMACHINE' && <SlotLivePanel slot={s.activeSlot} config={s.slotConfig?.status} activePlayers={activePlayers} />}

    {liveBlock?.type === 'PAK_EEN_ZES' && <PakEenZesLivePanel game={s.pakEenZes} />}

    {liveBlock?.type === 'FOTORONDE' && <PhotoRoundPanel round={s.photoRound} run={run} gameId={gameId} activeRound={activeRound} players={s.players} nav={nav} />}

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
        <RoundsInGame state={s} gameId={gameId} run={run} nav={nav} />

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

/**
 * What the slotmachine is doing right now.
 *
 * The host does not drive this game — players lock their own series and press their own
 * SPIN — so the panel answers the questions they cannot see from the projector: is the
 * machine even usable, who is mid-series, and what did the last spin pay.
 */
function SlotLivePanel({ slot, config, activePlayers }: { slot: any; config: any; activePlayers: any[] }) {
  const series: any[] = slot?.activeSeries || [];
  const last = slot?.lastSpin || null;
  const turn = slot?.turn || null;

  return <Card className="slot-live-panel">
    <div className="row-between">
      <div>
        <div className="label muted">SLOTMACHINE · LIVE</div>
        <h2 className="display card-heading">Players spin from their phones</h2>
      </div>
      <Status tone={config?.valid ? 'open' : 'danger'}>{config?.valid ? 'CONFIGURED' : 'NOT CONFIGURED'}</Status>
    </div>

    {!config?.valid && <p className="neg"><b>{config?.reason || 'Finish the slotmachine setup in Settings before running this block.'}</b></p>}

    {/* One player at a time, so the turn is the headline: who is up, how much of their
        run is left, and who follows. */}
    <div className="slot-turn-strip">
      <div>
        <span className="label muted">AAN DE BEURT</span>
        <b>{turn?.current ? turn.current.playerName : turn?.allDone && series.length > 0 ? 'Alle spelers klaar' : '—'}</b>
      </div>
      <div>
        <span className="label muted">SPINS OVER</span>
        <b>{turn?.current ? `${turn.current.spinsRemaining} / ${turn.current.totalSpins}` : '—'}</b>
      </div>
      <div>
        <span className="label muted">INZET PER SPIN</span>
        <b>{turn?.current ? turn.current.stakePerSpin : '—'}</b>
      </div>
      <div>
        <span className="label muted">HIERNA</span>
        <b>{turn?.next ? turn.next.playerName : turn?.current ? 'niemand meer' : '—'}</b>
      </div>
    </div>

    {turn?.spinning && <p className="muted microcopy">A spin is resolving — no new spin can start until it lands.</p>}

    <div className="slot-live-stats">
      <div><span className="label muted">ACTIVE SERIES</span><b>{series.length} of {activePlayers.length}</b></div>
      <div><span className="label muted">LOCKED IN UNSPUN SPINS</span><b><CoinIcon size={16} /> {slot?.lockedCoins ?? 0}</b></div>
      <div><span className="label muted">LAST OUTCOME</span><b>{last ? last.status === 'RESULT' ? last.outcome : 'spinning…' : '—'}</b></div>
      <div><span className="label muted">LAST PAYOUT</span><b>{last && last.status === 'RESULT' ? `${last.payout} at ${Number(last.payoutMultiplier).toFixed(2).replace(/\.?0+$/, '')}x` : '—'}</b></div>
    </div>

    {series.length === 0
      ? <div className="sub-empty">No player has locked a series yet.</div>
      : <div className="round-content-summary">
        {series.map(item => <div className="round-content-line" key={item.id}>
          <span>
            <span className="player-dot" style={{ background: item.playerColor }} />
            <b>{item.playerName}</b> · {item.stakePerSpin} per spin · {item.spinsRemaining} of {item.totalSpins} spins left
          </span>
          <Status tone="open">ACTIVE</Status>
        </div>)}
      </div>}

    {slot?.spins?.length > 0 && <div className="slot-live-history">
      <div className="label muted">RECENT SPINS</div>
      {slot.spins.map((spin: any) => <div className="ledger-line" key={spin.id}>
        <span><b>{spin.playerName}</b> · spin {spin.spinNumber} · {spin.status === 'RESULT' ? spin.outcome : 'spinning…'}</span>
        <b className={spin.status === 'RESULT' && spin.payout > 0 ? 'pos' : 'muted'}>
          {spin.status === 'RESULT' ? spin.payout > 0 ? `+${spin.payout}` : '0' : '—'}
        </b>
      </div>)}
    </div>}

    <p className="muted microcopy">
      One player at a time: each one plays their whole bought run before the next starts, and no extra spins can be
      bought afterwards. The server decides whose turn it is and refuses a spin while the previous one is still
      resolving. Moving to the next content block ends every series and refunds spins nobody used.
    </p>
  </Card>;
}

/**
 * The Fotoronde: every team's photos, by subject, with the credits the host awards.
 *
 * Judging happens per photo. The split across the team's members is shown next to the
 * amount before it is confirmed, so the host can see that 25 credits across 4 players
 * pays 7 + 6 + 6 + 6 rather than wondering where the odd credit went.
 *
 * An already-judged photo shows what it earned instead of an input: the server refuses a
 * second award, so offering one would be a lie.
 */
function PhotoRoundPanel({ round, run, gameId, activeRound, players, nav }: {
  round: any;
  run: RunMutation;
  gameId: number;
  activeRound: any;
  players: any[];
  nav: (path: string) => void;
}) {
  const [credits, setCredits] = useState<Record<number, string>>({});
  const [awarding, setAwarding] = useState<number | null>(null);
  const status = round?.status || 'DRAFT';
  const teams: any[] = round?.teams || [];

  const award = async (submissionId: number, amount: number) => {
    if (awarding !== null) return;
    setAwarding(submissionId);
    try {
      if (await run('/api/award-photo-credits', { submissionId, credits: amount })) {
        setCredits(current => { const next = { ...current }; delete next[submissionId]; return next; });
      }
    } finally { setAwarding(null); }
  };

  const show = (submissionId: number | null) => run('/api/show-photo-submission', { blockId: round.blockId, submissionId });

  return <Card className="photo-live-panel">
    <div className="row-between">
      <div>
        <div className="label muted">FOTORONDE · LIVE</div>
        <h2 className="display card-heading">Teams upload from their phones</h2>
      </div>
      <Status tone={status === 'OPEN' ? 'open' : status === 'COMPLETED' ? 'success' : status === 'CLOSED' ? 'warning' : 'neutral'}>{status}</Status>
    </div>

    <div className="photo-live-stats">
      <div><span className="label muted">TEAMS</span><b>{teams.length}</b></div>
      <div><span className="label muted">FOTO'S</span><b>{round?.submissionCount ?? 0}</b></div>
      <div><span className="label muted">BEOORDEELD</span><b>{round?.judgedCount ?? 0} / {round?.submissionCount ?? 0}</b></div>
      <div><span className="label muted">CREDITS</span><b><CoinIcon size={16} /> {round?.totalCredits ?? 0}</b></div>
    </div>

    {/* Teams are the unit everything else is grouped by, and the host builds them here
        rather than having to leave for the round page. Round groups and the existing
        group endpoints do the work — this is only where they are reached from. */}
    <PhotoTeamEditor
      activeRound={activeRound}
      players={players}
      teamTotals={round?.teamTotals || []}
      run={run}
      nav={nav}
      gameId={gameId}
    />

    {(round?.bySubject || []).map((entry: any) => <div className="photo-subject-group" key={entry.subject.key}>
      <div className="photo-subject-title">
        <div className="label muted">{String(entry.subject.label).toUpperCase()}</div>
        <span className="muted">{entry.submittedCount} / {teams.length} teams</span>
      </div>

      {/* Named, because "which teams are still missing" is the actionable half. */}
      {entry.missingTeams.length > 0 && <div className="photo-missing">
        <span className="label muted">NOG GEEN FOTO</span>
        {entry.missingTeams.map((name: string) => <span key={name}>{name}</span>)}
      </div>}

      {entry.submissions.length === 0
        ? <div className="sub-empty">Nog geen foto's voor dit onderwerp.</div>
        : <div className="photo-grid">
          {entry.submissions.map((submission: any) => {
            const team = teams.find(t => t.groupId === submission.groupId);
            const memberCount = team?.memberIds.length ?? 0;
            const typed = credits[submission.id];
            const amount = Number(typed);
            const validAmount = typed !== undefined && typed !== '' && Number.isInteger(amount) && amount >= 0;
            const judged = submission.creditsAwarded != null;
            return <div className={`photo-card ${judged ? 'is-judged' : ''}`} key={submission.id}>
              <img className="photo-card-image" src={`/api/block-media?key=${encodeURIComponent(submission.mediaKey)}`} alt="" />
              <div className="photo-card-body">
                <b>{submission.teamName}</b>
                <span className="muted">Ingezonden door: {submission.uploaderName || 'onbekend'}</span>

                {judged
                  ? <div className="photo-awarded">
                    <b><CoinIcon size={16} /> {submission.creditsAwarded} credits</b>
                    <span className="muted">{submission.distribution}</span>
                  </div>
                  : round?.acceptsAwards
                    ? <div className="photo-award-form">
                      <input
                        className="field photo-credit-input"
                        type="number"
                        min="0"
                        placeholder="Credits"
                        value={typed ?? ''}
                        onChange={e => setCredits({ ...credits, [submission.id]: e.target.value })}
                      />
                      {/* The split, shown before confirming rather than after. */}
                      <span className="muted photo-split-hint">
                        {validAmount && memberCount > 0
                          ? `${memberCount} spelers · ${describeSplit(amount, memberCount)}`
                          : memberCount === 0 ? 'geen actieve spelers' : `${memberCount} spelers`}
                      </span>
                      <button
                        className="btn btn-primary btn-compact"
                        disabled={!validAmount || memberCount === 0 || awarding !== null}
                        onClick={() => award(submission.id, amount)}
                      >{awarding === submission.id ? 'TOEKENNEN…' : 'TOEKENNEN'}</button>
                    </div>
                    : <span className="muted">Sluit het inzenden om te beoordelen.</span>}

                <button
                  className={`btn btn-secondary btn-compact ${round?.shownSubmissionId === submission.id ? 'is-shown' : ''}`}
                  onClick={() => show(round?.shownSubmissionId === submission.id ? null : submission.id)}
                >{round?.shownSubmissionId === submission.id ? 'VAN SCHERM HALEN' : 'OP BIG SCREEN'}</button>
              </div>
            </div>;
          })}
        </div>}
    </div>)}

    <p className="muted microcopy">
      Credits go to the team and are split across its active players — every credit is handed out, and the same photo
      can never be rewarded twice. Moving to the next content block closes submissions but keeps the photos, so
      anything unjudged stays judgeable.
    </p>
  </Card>;
}

/**
 * Create and populate the Fotoronde's teams, in place.
 *
 * Teams are round groups, created by the Admin for this round — the same objects the
 * round page edits and the same three endpoints. Surfaced here because this is where the
 * host needs them: they are running the Fotoronde, and a block that cannot open without
 * teams should not send them somewhere else to make one.
 *
 * Membership is a checkbox grid rather than a picker, because a player belongs to at
 * most one group per round and the server enforces that — so the grid shows the whole
 * roster and the server refuses a double assignment.
 */
function PhotoTeamEditor({ activeRound, players, teamTotals, run, nav, gameId }: {
  activeRound: any;
  players: any[];
  teamTotals: any[];
  run: RunMutation;
  nav: (path: string) => void;
  gameId: number;
}) {
  const [name, setName] = useState('');
  const [editingMembers, setEditingMembers] = useState<Record<number, number[]>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const groups: any[] = activeRound?.groups || [];
  // Structure is frozen once the round is completed; the existing endpoints refuse it
  // too, so this only avoids offering an action that would fail.
  const locked = activeRound?.status === 'COMPLETED';
  const roster = players.filter(p => p.active);

  const membersFor = (group: any) => editingMembers[group.id] ?? group.members.map((m: any) => m.id);
  const toggle = (group: any, playerId: number) => {
    const current = membersFor(group);
    setEditingMembers({
      ...editingMembers,
      [group.id]: current.includes(playerId) ? current.filter((id: number) => id !== playerId) : [...current, playerId],
    });
  };

  const saveMembers = async (group: any) => {
    if (saving !== null) return;
    setSaving(group.id);
    try {
      if (await run('/api/set-round-group-members', { groupId: group.id, playerIds: membersFor(group) })) {
        setEditingMembers(current => { const next = { ...current }; delete next[group.id]; return next; });
      }
    } finally { setSaving(null); }
  };

  return <div className="photo-teams">
    <div className="row-between">
      <div className="label muted">TEAMS · {groups.length}</div>
      {groups.length > 0 && <button className="text-button" onClick={() => setOpen(x => !x)}>
        {open ? 'Klaar met teams' : 'Teams aanpassen'}
      </button>}
    </div>

    {groups.length === 0 && <p className="neg photo-teams-empty">
      <b>Nog geen teams in deze ronde.</b> Maak hieronder minstens één team — de Fotoronde kan niet open zonder.
    </p>}

    {/* Collapsed by default once teams exist: judging is the main job here, not admin. */}
    {(open || groups.length === 0) && !locked && <div className="photo-team-create">
      <input className="field" placeholder="Teamnaam" value={name} onChange={e => setName(e.target.value)} />
      <button
        className="btn btn-primary btn-compact"
        disabled={!name.trim() || !activeRound}
        onClick={async () => { if (await run('/api/upsert-round-group', { roundId: activeRound.id, name })) setName(''); }}
      >+ TEAM</button>
    </div>}

    <div className="photo-team-list">
      {groups.map(group => {
        const totals = teamTotals.find((t: any) => t.groupId === group.id);
        const selected = membersFor(group);
        const activeNames = group.members.filter((m: any) => m.active).map((m: any) => m.display_name);
        return <div className="photo-team-entry" key={group.id}>
          <div className="photo-team-row">
            <div>
              <b>{group.name}</b>
              <span className="muted"> · {activeNames.length ? activeNames.join(', ') : 'geen actieve spelers'}</span>
            </div>
            <span className="photo-team-credits">{totals?.submitted ?? 0} foto&apos;s · {totals?.credits ?? 0} credits</span>
          </div>

          {open && !locked && <div className="photo-team-members">
            <div className="group-members">
              {roster.map(player => <label key={player.id} className={`group-member ${selected.includes(player.id) ? 'selected' : ''}`}>
                <input type="checkbox" checked={selected.includes(player.id)} onChange={() => toggle(group, player.id)} />
                <span className="player-dot" style={{ background: player.public_color }} />
                <span>{player.display_name}</span>
              </label>)}
            </div>
            <div className="actions actions-compact">
              <button className="btn btn-secondary btn-compact" disabled={saving === group.id} onClick={() => saveMembers(group)}>
                {saving === group.id ? 'OPSLAAN…' : 'SAVE MEMBERS'}
              </button>
              {/* Refused server-side once the team has ledger history, photo credits
                  included — so a team that earned something is kept for the ledger. */}
              <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-round-group', { groupId: group.id })}>DELETE</button>
            </div>
          </div>}
        </div>;
      })}
    </div>

    {open && activeRound && <button className="text-button photo-teams-link" onClick={() => nav(`/admin/${gameId}/rounds/${activeRound.id}`)}>
      Open de rondepagina voor groepsscoring en hernoemen
    </button>}
  </div>;
}

/**
 * How an award divides, in words. Mirrors describeDistribution in
 * netlify/lib/photo-round.ts — src and netlify are separate TypeScript projects, so this
 * is a local copy rather than pulling backend code into the client bundle.
 */
function describeSplit(credits: number, memberCount: number) {
  if (memberCount <= 0) return 'no players';
  if (credits <= 0) return 'no credits';
  const base = Math.floor(credits / memberCount);
  const remainder = credits % memberCount;
  if (remainder === 0) return `${memberCount} × ${base}`;
  return `${remainder} × ${base + 1} + ${memberCount - remainder} × ${base}`;
}

/**
 * What Pak een Zes is doing right now.
 *
 * The host drives the phases but not the cards, so this answers what they cannot see
 * from the projector: who has not predicted yet (they are allowed to close without
 * those people, so the names matter), whose turn it is, and which sixes are out.
 */
function PakEenZesLivePanel({ game }: { game: any }) {
  const status = game?.status || 'READY';
  const awaiting: any[] = game?.awaitingPrediction || [];
  const sixes: any[] = game?.sixes || [];
  const tone = status === 'DRAWING' ? 'open' : status === 'FINISHED' ? 'success' : status === 'PREDICTING' ? 'warning' : 'neutral';

  return <Card className="pez-live-panel">
    <div className="row-between">
      <div>
        <div className="label muted">PAK EEN ZES · LIVE</div>
        <h2 className="display card-heading">Players draw their own cards</h2>
      </div>
      <Status tone={tone as any}>{status}</Status>
    </div>

    <div className="pez-live-stats">
      <div><span className="label muted">AAN DE BEURT</span><b>{status === 'DRAWING' ? (game?.currentPlayer?.name || '—') : '—'}</b></div>
      <div><span className="label muted">KAARTEN GETROKKEN</span><b>{game?.drawnCount ?? 0} / 52</b></div>
      <div><span className="label muted">ZESSEN GEVONDEN</span><b>{game?.sixesFound ?? 0} / 4</b></div>
      <div><span className="label muted">VOORSPELLINGEN</span><b>{game?.predictionCount ?? 0} / {game?.activePlayerCount ?? 0}</b></div>
    </div>

    {/* Closing predictions without everyone is allowed, so name who would be left out
        rather than only counting them. */}
    {['PREDICTING', 'LOCKED'].includes(status) && <div className="pez-awaiting">
      <div className="label muted">{awaiting.length === 0 ? 'EVERYONE HAS PREDICTED' : 'STILL TO PREDICT'}</div>
      {awaiting.length > 0 && <div className="pez-awaiting-names">
        {awaiting.map(player => <span key={player.playerId}>{player.name}</span>)}
      </div>}
    </div>}

    {/* The scoring outcome, so the host can read it out without leaving the panel. */}
    {(game?.results?.length ?? 0) > 0 && <div className="pez-live-sixes">
      <div className="label muted">VOORSPELLINGEN · {game.pointsPerCorrect} PUNTEN PER STUK</div>
      {game.results.filter((r: any) => r.correct > 0).map((result: any) => <div className="ledger-line" key={result.playerId}>
        <span><b>{result.playerName}</b> · {result.correct} goed</span>
        <b className="pos">+{result.points}</b>
      </div>)}
    </div>}

    {sixes.length > 0 && <div className="pez-live-sixes">
      <div className="label muted">ZESSEN</div>
      {sixes.map(six => <div className="ledger-line" key={six.id}>
        <span><b>{six.label}</b> · {six.playerName}</span>
        <b className="muted">trek {six.drawNumber}</b>
      </div>)}
    </div>}

    {game?.recentDraws?.length > 0 && <div className="pez-live-sixes">
      <div className="label muted">LAATSTE KAARTEN</div>
      {game.recentDraws.map((draw: any) => <div className="ledger-line" key={draw.id}>
        <span>{draw.playerName} · {draw.label}</span>
        <b className={draw.isSix ? 'pos' : 'muted'}>{draw.isSix ? 'ZES' : ''}</b>
      </div>)}
    </div>}

    <p className="muted microcopy">
      The server decides both the card and whose turn it is — a phone can only ask. Moving to the next content block
      stops the game, and its predictions and draws are kept for scoring later.
    </p>
  </Card>;
}

/**
 * Every round in the game night, in order, with the one action each needs.
 *
 * This replaces the old current-round and this-round's-content cards. The run of
 * show already answers "what is inside the live round"; the question it cannot
 * answer is "where are we in the evening, and what still needs building". EDIT
 * hands off to the round's own page rather than duplicating the editor here.
 */
function RoundsInGame({ state: s, gameId, run, nav }: { state: any; gameId: number; run: RunMutation; nav: (path: string) => void }) {
  const activeRoundId = s.game.current_round_id;
  const label = (status: string) => status === 'COMPLETED' ? 'FINISHED' : status;
  const tone = (status: string) => status === 'ACTIVE' ? 'open' : status === 'COMPLETED' ? 'success' : 'neutral';

  return <Card>
    <div className="row-between">
      <div className="label muted">ROUNDS IN THIS GAME</div>
      <Status>{s.rounds.length} ROUND{s.rounds.length === 1 ? '' : 'S'}</Status>
    </div>
    {s.rounds.length === 0
      ? <div className="sub-empty">No rounds yet — create the first one on the Rounds page.</div>
      : <div className="round-line-list">
        {s.rounds.map((round: any) => {
          const isActive = round.id === activeRoundId;
          const parts = round.blocks?.length ?? 0;
          const groups = round.groups?.length ?? 0;
          // The server refuses a second active round with a 409, so the button says
          // so up front rather than offering an action that is going to fail.
          const blockedBy = round.status === 'UPCOMING' && activeRoundId ? s.rounds.find((r: any) => r.id === activeRoundId) : null;
          return <div key={round.id} className={`round-line ${isActive ? 'is-active' : ''}`}>
            <div className="round-line-copy">
              <div className="round-line-title">R{String(round.round_number).padStart(2, '0')} · {round.title}</div>
              <div className="muted round-line-meta">{parts} part{parts === 1 ? '' : 's'}{groups > 0 ? ` · ${groups} group${groups === 1 ? '' : 's'}` : ''}</div>
            </div>
            <Status tone={tone(round.status) as any}>{label(round.status)}</Status>
            <div className="round-line-actions">
              {round.status === 'UPCOMING' && <button
                className="btn btn-primary btn-compact"
                disabled={Boolean(blockedBy)}
                title={blockedBy ? `Complete R${String(blockedBy.round_number).padStart(2, '0')} first` : undefined}
                onClick={() => run('/api/start-round', { roundId: round.id })}
              >START</button>}
              {isActive && <button className="btn btn-primary btn-compact" onClick={() => run('/api/complete-round', { roundId: round.id })}>COMPLETE ROUND</button>}
              <button className="btn btn-secondary btn-compact" onClick={() => nav(`/admin/${gameId}/rounds/${round.id}`)}>EDIT</button>
            </div>
          </div>;
        })}
      </div>}
  </Card>;
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
