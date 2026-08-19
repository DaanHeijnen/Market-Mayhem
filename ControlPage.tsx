import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Countdown, Empty, Status } from '../ui';
import { CoinIcon } from '../../shared/CoinIcon';

export function ControlPage({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const [playerId, setPlayerId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [roundId, setRoundId] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustmentKey, setAdjustmentKey] = useState(() => crypto.randomUUID());

  const activePlayers = s.players.filter((p: any) => p.active);
  const activeRound = s.rounds.find((r: any) => r.id === s.game.current_round_id) || null;
  const blocks = activeRound?.blocks || [];
  const blockIndex = blocks.findIndex((b: any) => b.id === s.game.current_round_block_id);
  const activeRoulette = s.activeRoulette;
  const isFresh = activePlayers.length === 0 && s.rounds.length === 0 && s.predictions.length === 0;

  const activate = (block: any) => run('/api/set-active-round-block', { roundId: activeRound.id, blockId: block.id });
  const rouletteAction = (action: string) => activeRoulette && run('/api/roulette-action', { rouletteGameId: activeRoulette.id, action }, true);
  const questionAction = (action: string) => s.currentBlock && run('/api/question-action', { blockId: s.currentBlock.id, action });
  const showDashboard = () => run('/api/screen-mode', { mode: 'DASHBOARD' });
  const showPrediction = (p: any) => run('/api/screen-mode', {
    mode: p.status === 'OPEN' ? 'PREDICTIONS_OPEN' : p.status === 'RESULT' || p.status === 'SETTLED' ? 'PREDICTION_RESULT' : 'PREDICTION_LOCKED',
    predictionId: p.id,
  });

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

  return <div className="control-grid">
    <div className="page-stack control-main-column">
      {isFresh && <Card><div className="label muted">FIRST SETUP</div><h2 className="display card-heading">Build your game before going live</h2><div className="setup-flow"><b>Settings</b><span>→</span><b>Players</b><span>→</span><b>Rounds</b><span>→</span><b>Round Content</b><span>→</span><b>Predictions</b><span>→</span><b>Control</b></div></Card>}

      <Card>
        <div className="label muted">CURRENT ROUND</div>
        {!activeRound ? <Empty title="No round active" /> : <>
          <div className="row-between control-round-head"><div><div className="display card-heading">R{String(activeRound.round_number).padStart(2, '0')} · {activeRound.title}</div><div className="muted">{s.currentBlock ? `Live block: ${s.currentBlock.type} · ${s.currentBlock.title || 'Untitled'}` : 'No active content block'}</div></div><Status>{activeRound.status}</Status></div>
          {blocks.length ? <div className="content-controls"><button className="btn btn-secondary btn-compact" disabled={blockIndex <= 0} onClick={() => activate(blocks[blockIndex - 1])}>← PREVIOUS</button><button className="btn btn-secondary btn-compact" disabled={blockIndex < 0 || blockIndex >= blocks.length - 1} onClick={() => activate(blocks[blockIndex + 1])}>NEXT →</button><select className="field compact-field" value={s.game.current_round_block_id || ''} onChange={e => { const block = blocks.find((b: any) => b.id === Number(e.target.value)); if (block) void activate(block); }}><option value="">Jump to block</option>{blocks.map((b: any, i: number) => <option key={b.id} value={b.id}>{i + 1}. {b.type} · {b.title || 'Untitled'}</option>)}</select></div> : <p className="muted">This round has no content blocks yet.</p>}
        </>}
      </Card>

      {s.currentBlock?.type === 'DUOLINGO_QUESTION' && <Card className="interactive-control-card">
        <div className="row-between"><div><div className="label muted">LIVE QUESTION CONTROL</div><h2 className="display card-heading">{s.currentBlock.title}</h2></div><Status>{s.currentBlock.interactive_status || 'READY'}</Status></div>
        <p className="muted">{s.currentBlock.answer_count || 0} answers received · reward {Number(s.currentBlock.payload?.rewardCoins || 0)} coins</p>
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

      <Card>
        <div className="label muted">ACTIVE PREDICTIONS</div>
        {s.activePredictions.length === 0 ? <p className="muted">No active predictions.</p> : <div className="active-market-stack">{s.activePredictions.map((p: any) => <div className="market-line" key={p.id}><div className="market-line-copy"><b>#{p.display_number} · {p.question}</b><div className="muted">{p.participation_count} / {activePlayers.length} participated · <span className="yes-text">YES {p.yes_odds.toFixed(2)}x</span> · <span className="no-text">NO {p.no_odds.toFixed(2)}x</span></div></div><div className="market-line-actions"><Status>{p.status}</Status>{p.status === 'OPEN' && <div className="mono countdown-inline"><Countdown closesAt={p.closes_at} /></div>}<button className="btn btn-secondary btn-compact" onClick={() => showPrediction(p)}>SHOW PREDICTION</button></div></div>)}</div>}
      </Card>

      <Card>
        <div className="label muted">RECENT LEDGER</div>
        {s.recentTransactions.length === 0 ? <p className="muted">No transactions yet</p> : s.recentTransactions.slice(0, 10).map((x: any) => <div className="ledger-line" key={x.id}><span><b>{x.display_name}</b> · {x.description}</span><b className={x.amount >= 0 ? 'pos' : 'neg'}>{x.amount > 0 ? '+' : ''}{x.amount}</b></div>)}
      </Card>
    </div>

    <div className="page-stack control-side-column">
      <Card className="preview-card">
        <div className="row-between preview-heading"><div><div className="label muted">LIVE BIG SCREEN PREVIEW</div><div className="display card-heading">Exact projector output</div></div><a className="btn btn-secondary btn-compact" href={`/screen/${gameId}`} target="_blank" rel="noreferrer">OPEN FULL SCREEN ↗</a></div>
        <div className="preview-actions"><button className="btn btn-primary btn-full" onClick={showDashboard}>SHOW MAIN DASHBOARD</button></div>
        <div className="screen-preview"><iframe title="Live Big Screen" src={`/screen/${gameId}`} /></div>
      </Card>

      <Card className="quick-adjust-card">
        <div className="label muted">QUICK COIN ADJUSTMENT</div>
        <div className="quick-adjust-grid">
          <select className="field" value={playerId} onChange={e => setPlayerId(e.target.value)}><option value="">Player</option>{activePlayers.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} · {p.current_balance}</option>)}</select>
          <input className="field" type="number" placeholder="25 or -10" value={amount} onChange={e => setAmount(e.target.value)} />
          <select className="field" value={roundId} onChange={e => setRoundId(e.target.value)}><option value="">General / no round</option>{s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}</select>
          <input className="field quick-reason" placeholder="Mandatory reason" value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-full quick-save" disabled={adjusting || !playerId || !reason.trim() || !amount || Number(amount) === 0} onClick={adjust}>{adjusting ? 'SAVING…' : <><CoinIcon size={16} /> SAVE ADJUSTMENT</>}</button>
      </Card>
    </div>
  </div>;
}
