import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Countdown, Empty, Status } from '../ui';

export function ControlPage({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const [playerId, setPlayerId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [roundId, setRoundId] = useState('');
  const [rouletteResult, setRouletteResult] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  const activePlayers = s.players.filter((p: any) => p.active);
  const activeRound = s.rounds.find((r: any) => r.id === s.game.current_round_id) || null;
  const blocks = activeRound?.blocks || [];
  const blockIndex = blocks.findIndex((b: any) => b.id === s.game.current_round_block_id);
  const activeRoulette = s.activeRoulette;
  const isFresh = activePlayers.length === 0 && s.rounds.length === 0 && s.predictions.length === 0;

  const activate = (block: any) => run('/api/set-active-round-block', { roundId: activeRound.id, blockId: block.id });
  const rouletteAction = (action: string, extra: Record<string, unknown> = {}) =>
    activeRoulette && run('/api/roulette-action', { rouletteGameId: activeRoulette.id, action, ...extra }, true);

  const adjust = async () => {
    if (adjusting) return;
    setAdjusting(true);
    try {
      if (await run('/api/adjust-coins', {
        playerId: Number(playerId), amount: Number(amount), reason, roundId: roundId ? Number(roundId) : null,
      }, true)) {
        setAmount('');
        setReason('');
      }
    } finally {
      setAdjusting(false);
    }
  };

  return (
    <div className="control-grid">
      <div className="page-stack">
        {isFresh && (
          <Card>
            <div className="label muted">FIRST SETUP</div>
            <h2 className="display">Build your game before going live</h2>
            <div className="setup-flow"><b>Settings</b><span>→</span><b>Players</b><span>→</span><b>Rounds</b><span>→</span><b>Round Content</b><span>→</span><b>Predictions</b><span>→</span><b>Control</b></div>
          </Card>
        )}

        <Card>
          <div className="label muted">CURRENT ROUND</div>
          {!activeRound ? <Empty title="No round active" /> : (
            <>
              <div className="row-between">
                <div>
                  <div className="display" style={{ fontSize: 28 }}>R{String(activeRound.round_number).padStart(2, '0')} · {activeRound.title}</div>
                  <div className="muted">{s.currentBlock ? `Live block: ${s.currentBlock.type} · ${s.currentBlock.title || 'Untitled'}` : 'No active content block'}</div>
                </div>
                <Status>{activeRound.status}</Status>
              </div>
              {blocks.length ? (
                <div className="actions">
                  <button className="btn" disabled={blockIndex <= 0} onClick={() => activate(blocks[blockIndex - 1])}>← PREVIOUS</button>
                  <button className="btn" disabled={blockIndex < 0 || blockIndex >= blocks.length - 1} onClick={() => activate(blocks[blockIndex + 1])}>NEXT →</button>
                  <select className="field" value={s.game.current_round_block_id || ''} onChange={(e) => {
                    const block = blocks.find((b: any) => b.id === Number(e.target.value));
                    if (block) void activate(block);
                  }}>
                    <option value="">Jump to block</option>
                    {blocks.map((b: any, i: number) => <option key={b.id} value={b.id}>{i + 1}. {b.type} · {b.title || 'Untitled'}</option>)}
                  </select>
                </div>
              ) : <p className="muted">This round has no content blocks yet.</p>}
            </>
          )}
        </Card>

        <Card>
          <div className="label muted">ACTIVE PREDICTIONS</div>
          {s.activePredictions.length === 0 ? <p className="muted">No active predictions.</p> : s.activePredictions.map((p: any) => (
            <div className="market-line" key={p.id}>
              <div><b>#{p.display_number} · {p.question}</b><div className="muted">{p.participation_count} / {activePlayers.length} participated · YES {p.yes_odds.toFixed(2)}× · NO {p.no_odds.toFixed(2)}×</div></div>
              <div><Status>{p.status}</Status>{p.status === 'OPEN' && <div className="display" style={{ marginTop: 5, textAlign: 'right' }}><Countdown closesAt={p.closes_at} /></div>}</div>
            </div>
          ))}
        </Card>

        <Card>
          <div className="label muted">QUICK COIN ADJUSTMENT</div>
          <h2 className="display">One signed adjustment</h2>
          <div className="form-grid compact">
            <select className="field" value={playerId} onChange={(e) => setPlayerId(e.target.value)}><option value="">Player</option>{activePlayers.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} · {p.current_balance}</option>)}</select>
            <input className="field" type="number" placeholder="25 or -10" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <select className="field" value={roundId} onChange={(e) => setRoundId(e.target.value)}><option value="">General / no round</option>{s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}</select>
            <input className="field" placeholder="Mandatory reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button className="btn btn-dark" disabled={adjusting || !playerId || !reason.trim() || !amount || Number(amount) === 0} onClick={adjust}>{adjusting?'SAVING…':'SAVE'}</button>
        </Card>

        {s.currentBlock?.type === 'ROULETTE' && (
          <Card>
            <div className="label muted">ROULETTE CONTROL</div>
            {!activeRoulette ? (
              <><p className="muted">No current roulette spin. Activate this block again to create one.</p>{activeRound && <button className="btn btn-lime" onClick={() => activate(s.currentBlock)}>NEW ROULETTE SPIN</button>}</>
            ) : (
              <>
                <div className="row-between"><div className="display" style={{ fontSize: 25 }}>Roulette #{activeRoulette.id}</div><Status>{activeRoulette.status}</Status></div>
                <p className="muted">{activeRoulette.bet_count} bets · {activeRoulette.total_stake} coins staked{activeRoulette.result_number != null ? ` · result ${activeRoulette.result_number}` : ''}</p>
                <div className="actions">
                  {activeRoulette.status === 'DRAFT' && <button className="btn btn-lime" onClick={() => rouletteAction('OPEN')}>OPEN BETTING</button>}
                  {activeRoulette.status === 'OPEN' && <button className="btn btn-dark" onClick={() => rouletteAction('CLOSE')}>CLOSE BETTING</button>}
                  {activeRoulette.status === 'LOCKED' && <><button className="btn btn-blue" onClick={() => rouletteAction('SPIN')}>SPIN</button><input className="field" type="number" min="0" max="36" placeholder="0-36" value={rouletteResult} onChange={(e) => setRouletteResult(e.target.value)} /><button className="btn" disabled={rouletteResult === '' || Number(rouletteResult) < 0 || Number(rouletteResult) > 36} onClick={() => rouletteAction('SET_RESULT', { resultNumber: Number(rouletteResult) })}>SET RESULT</button></>}
                  {activeRoulette.status === 'RESULT' && <button className="btn btn-dark" onClick={() => rouletteAction('SETTLE')}>CONFIRM + SETTLE</button>}
                  {!['SETTLED', 'CANCELLED'].includes(activeRoulette.status) && <button className="btn btn-red" onClick={() => rouletteAction('CANCEL')}>CANCEL + REFUND</button>}
                </div>
              </>
            )}
          </Card>
        )}

        <Card>
          <div className="label muted">RECENT LEDGER</div>
          {s.recentTransactions.length === 0 ? <p className="muted">No transactions yet</p> : s.recentTransactions.slice(0, 10).map((x: any) => <div className="ledger-line" key={x.id}><span><b>{x.display_name}</b> · {x.description}</span><b className={x.amount >= 0 ? 'pos' : 'neg'}>{x.amount > 0 ? '+' : ''}{x.amount}</b></div>)}
        </Card>
      </div>

      <div className="page-stack">
        <Card style={{ position: 'sticky', top: 24 }}>
          <div className="row-between"><div><div className="label muted">LIVE BIG SCREEN PREVIEW</div><div className="display" style={{ fontSize: 20 }}>Exact projector output</div></div><a className="btn btn-dark" href={`/screen/${gameId}`} target="_blank" rel="noreferrer">OPEN FULL SCREEN</a></div>
          <div className="screen-preview"><iframe title="Live Big Screen" src={`/screen/${gameId}`} /></div>
        </Card>
      </div>
    </div>
  );
}
