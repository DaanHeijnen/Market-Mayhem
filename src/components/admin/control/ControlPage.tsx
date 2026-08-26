import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Accordion, Card, Countdown, Empty, Status } from '../ui';
import { CoinIcon } from '../../shared/CoinIcon';
import { blockLabel, blockMeta } from '../blockMeta';

type StepKind = 'block' | 'prediction';
type Step = { kind: StepKind; id: number; accent: string; kicker: string; label: string; isLive: boolean; onShow: () => void };

export function ControlPage({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const nav = useNavigate();
  const [playerId, setPlayerId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [roundId, setRoundId] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustmentKey, setAdjustmentKey] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState({ predictions: true, ledger: false, adjust: false });
  const toggle = (key: keyof typeof open) => () => setOpen(current => ({ ...current, [key]: !current[key] }));

  const activePlayers = s.players.filter((p: any) => p.active);
  const activeRound = s.rounds.find((r: any) => r.id === s.game.current_round_id) || null;
  const blocks = activeRound?.blocks || [];
  const blockIndex = blocks.findIndex((b: any) => b.id === s.game.current_round_block_id);
  const activeRoulette = s.activeRoulette;
  const isFresh = activePlayers.length === 0 && s.rounds.length === 0 && s.predictions.length === 0;
  const onDashboard = s.screen?.mode === 'DASHBOARD';

  const activate = (block: any) => run('/api/set-active-round-block', { roundId: activeRound.id, blockId: block.id });
  const rouletteAction = (action: string) => activeRoulette && run('/api/roulette-action', { rouletteGameId: activeRoulette.id, action }, true);
  const questionAction = (action: string) => s.currentBlock && run('/api/question-action', { blockId: s.currentBlock.id, action });
  const showDashboard = () => run('/api/screen-mode', { mode: 'DASHBOARD' });
  const showPrediction = (p: any) => run('/api/screen-mode', {
    mode: p.status === 'OPEN' ? 'PREDICTIONS_OPEN' : p.status === 'RESULT' || p.status === 'SETTLED' ? 'PREDICTION_RESULT' : 'PREDICTION_LOCKED',
    predictionId: p.id,
  });

  // The run of show is the host's single ordered timeline for the active round:
  // its content blocks, followed by the markets attached to that round that have
  // not been resolved yet. Clicking a step puts it on the projector.
  const runOfShow: Step[] = activeRound ? [
    ...blocks.map((b: any) => ({
      kind: 'block' as StepKind, id: b.id, accent: blockMeta(b.type).accent,
      kicker: blockMeta(b.type).label, label: blockLabel(b),
      isLive: s.game.current_round_block_id === b.id && !onDashboard,
      onShow: () => activate(b),
    })),
    ...s.predictions
      .filter((p: any) => p.round_id === activeRound.id && !['SETTLED', 'CANCELLED'].includes(p.status))
      .map((p: any) => ({
        kind: 'prediction' as StepKind, id: p.id, accent: 'blue',
        kicker: 'Prediction', label: p.question,
        isLive: s.screen?.predictionId === p.id && !onDashboard,
        onShow: () => showPrediction(p),
      })),
  ] : [];

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

  const liveMarkets = s.predictions.filter((p: any) => !['SETTLED', 'CANCELLED'].includes(p.status));

  return <div className="control-grid">
    <div className="page-stack control-main-column">
      {isFresh && <Card><div className="label muted">FIRST SETUP</div><h2 className="display card-heading">Build your game before going live</h2><div className="setup-flow"><b>Settings</b><span>→</span><b>Players</b><span>→</span><b>Rounds</b><span>→</span><b>Round Content</b><span>→</span><b>Predictions</b><span>→</span><b>Control</b></div></Card>}

      <Card>
        <div className="label muted">CURRENT ROUND</div>
        {!activeRound ? <Empty title="No round active" /> : <>
          <div className="row-between control-round-head"><div><div className="display card-heading">R{String(activeRound.round_number).padStart(2, '0')} · {activeRound.title}</div><div className="muted">{s.currentBlock ? `Live block: ${blockMeta(s.currentBlock.type).label} · ${blockLabel(s.currentBlock)}` : 'No active content block'}</div></div><Status>{activeRound.status}</Status></div>
          {blocks.length ? <div className="content-controls"><button className="btn btn-secondary btn-compact" disabled={blockIndex <= 0} onClick={() => activate(blocks[blockIndex - 1])}>← PREVIOUS</button><button className="btn btn-secondary btn-compact" disabled={blockIndex < 0 || blockIndex >= blocks.length - 1} onClick={() => activate(blocks[blockIndex + 1])}>NEXT →</button><span className="muted step-position">{blockIndex >= 0 ? `PART ${blockIndex + 1} OF ${blocks.length}` : `${blocks.length} PARTS`}</span></div> : <p className="muted">This round has no content blocks yet.</p>}
        </>}
      </Card>

      {runOfShow.length > 0 && <Card>
        <div className="label muted">RUN OF SHOW — R{String(activeRound.round_number).padStart(2, '0')} · {activeRound.title}</div>
        <div className="run-of-show">
          <div className="run-of-show-track">
            {runOfShow.map(step => <button key={`${step.kind}-${step.id}`} className={`run-step accent-${step.accent} ${step.isLive ? 'is-live' : ''}`} onClick={step.onShow}>
              <span className="accent-dot" />
              <span className="run-step-copy">
                <span className="run-step-kicker">{step.kicker}</span>
                <span className="run-step-label">{step.label}</span>
              </span>
            </button>)}
          </div>
        </div>
      </Card>}

      {s.currentBlock?.type === 'DUOLINGO_QUESTION' && <Card className="interactive-control-card">
        <div className="row-between"><div><div className="label muted">LIVE QUESTION CONTROL</div><h2 className="display card-heading">{s.currentBlock.title}</h2></div><Status>{s.currentBlock.interactive_status || 'READY'}</Status></div>
        <p className="muted">{s.currentBlock.answer_count || 0} of {activePlayers.length} answered · reward {Number(s.currentBlock.payload?.rewardCoins || 0)} coins</p>
        <div className="actions compact-actions">
          {(s.currentBlock.interactive_status || 'READY') === 'READY' && <button className="btn btn-primary" onClick={() => questionAction('OPEN')}>OPEN ANSWERS</button>}
          {s.currentBlock.interactive_status === 'OPEN' && <button className="btn btn-secondary" onClick={() => questionAction('CLOSE')}>CLOSE ANSWERS</button>}
          {s.currentBlock.interactive_status === 'CLOSED' && <button className="btn btn-success" onClick={() => questionAction('REVEAL')}>REVEAL + REWARD</button>}
          {s.currentBlock.interactive_status === 'REVEALED' && <button className="btn btn-secondary" onClick={() => questionAction('SETTLE')}>MARK SETTLED</button>}
        </div>
      </Card>}

      {s.currentBlock?.type === 'ROULETTE' && <Card>
        <div className="label muted">ROULETTE CONTROL</div>
        {!activeRoulette ? <><p className="muted">No current roulette spin. Activate this block to create one.</p>{activeRound && <button className="btn btn-primary" onClick={() => activate(s.currentBlock)}>NEW ROULETTE SPIN</button>}</> : <>
          <div className="row-between"><div className="display card-heading">Roulette #{activeRoulette.id}</div><Status>{activeRoulette.status}</Status></div>
          <p className="muted">{activeRoulette.bet_count} bets · {activeRoulette.total_stake} coins staked{activeRoulette.result_number != null ? ` · result ${activeRoulette.result_number}` : ''}</p>
          <div className="actions compact-actions">
            {activeRoulette.status === 'DRAFT' && <button className="btn btn-success" onClick={() => rouletteAction('OPEN')}>OPEN BETTING</button>}
            {activeRoulette.status === 'OPEN' && <button className="btn btn-secondary" onClick={() => rouletteAction('CLOSE')}>CLOSE BETTING</button>}
            {activeRoulette.status === 'LOCKED' && <button className="btn btn-primary" onClick={() => rouletteAction('SPIN')}>SPIN</button>}
            {activeRoulette.status === 'SPINNING' && <button className="btn btn-secondary" disabled>SPINNING…</button>}
            {activeRoulette.status === 'RESULT' && <button className="btn btn-success" onClick={() => rouletteAction('SETTLE')}>CONFIRM + SETTLE</button>}
            {['DRAFT', 'OPEN', 'LOCKED'].includes(activeRoulette.status) && <button className="btn btn-danger-ghost" onClick={() => rouletteAction('CANCEL')}>CANCEL + REFUND</button>}
          </div>
        </>}
      </Card>}

      <Accordion title={`ALL PREDICTIONS (${liveMarkets.length} ACTIVE)`} open={open.predictions} onToggle={toggle('predictions')}>
        {liveMarkets.length === 0 ? <p className="muted">No active predictions.</p> : <div className="active-market-stack">{liveMarkets.map((p: any) => <div className="market-line" key={p.id}>
          <div className="market-line-copy">
            <b>#{p.display_number} · {p.question}{p.round_number ? ` · R${String(p.round_number).padStart(2, '0')}` : ''}</b>
            <div className="muted">{p.participation_count} / {activePlayers.length} participated · <span className="yes-text">YES {p.yes_odds.toFixed(2)}x</span> · <span className="no-text">NO {p.no_odds.toFixed(2)}x</span></div>
          </div>
          <div className="market-line-actions">
            <Status tone={p.status === 'OPEN' ? 'open' : 'neutral'}>{p.status}</Status>
            {p.status === 'OPEN' && <div className="mono countdown-inline"><Countdown closesAt={p.closes_at} /></div>}
            {['OPEN', 'LOCKED', 'RESULT'].includes(p.status) && <button className="btn btn-secondary btn-compact" onClick={() => showPrediction(p)}>SHOW</button>}
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
      <Card className="preview-card">
        <div className="row-between preview-heading"><div><div className="label muted">LIVE BIG SCREEN PREVIEW</div><div className="display card-heading">Exact projector output</div></div><a className="btn btn-secondary btn-compact" href={`/screen/${gameId}`} target="_blank" rel="noreferrer">OPEN FULL SCREEN ↗</a></div>
        <div className="preview-actions"><button className="btn btn-primary btn-full" disabled={onDashboard} onClick={showDashboard}>{onDashboard ? 'DASHBOARD IS LIVE' : 'SHOW MAIN DASHBOARD'}</button></div>
        <LiveScreenPreview gameId={gameId} />
      </Card>

      {activeRound && <Card>
        <div className="label muted">THIS ROUND'S CONTENT</div>
        <p className="muted round-content-copy">The order below is exactly what plays out in the run of show.</p>
        {blocks.length === 0 ? <div className="sub-empty">No content blocks yet.</div> : <div className="round-content-summary">
          {blocks.map((b: any, index: number) => <div key={b.id} className={`round-content-line accent-${blockMeta(b.type).accent}`}>
            <span className="accent-dot" />
            <span>{index + 1}. {blockLabel(b)}</span>
            {s.game.current_round_block_id === b.id && !onDashboard && <em>LIVE</em>}
          </div>)}
        </div>}
        <button className="btn btn-secondary btn-full round-content-edit" onClick={() => nav(`/admin/${gameId}/rounds/${activeRound.id}`)}>EDIT ROUND CONTENT</button>
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
  </div>;
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
