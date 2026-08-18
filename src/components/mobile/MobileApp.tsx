import { useEffect, useState } from 'react';
import { useGamePolling } from '../../hooks/useGamePolling';
import { mutation } from '../../lib/api';

export function MobileApp({ gameId }: { gameId: number }) {
  const { data: s, error, refresh } = useGamePolling<any>(gameId, 'mobile', `/api/player-state?gameId=${gameId}`);
  const [vote, setVote] = useState(50);
  const [side, setSide] = useState<'YES'|'NO'>('YES');
  const [stake, setStake] = useState(20);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const p = s?.prediction;
  const balance = Number(s?.player?.balance || 0);
  const maxStake = Math.min(500, balance);

  useEffect(() => {
    if (p?.ownVote !== null && p?.ownVote !== undefined) setVote(Number(p.ownVote));
  }, [p?.id, p?.ownVote]);

  useEffect(() => {
    if (p?.ownBet) {
      setSide(p.ownBet.side);
      setStake(Number(p.ownBet.stake));
      return;
    }
    if (balance >= 5) setStake((current) => Math.min(Math.max(5, current), Math.min(500, balance)));
  }, [balance, p?.id, p?.ownBet]);

  if (!s) return <Shell><div className="display">Open your player join link first.</div></Shell>;
  const act = async (fn: () => Promise<any>) => {
    setBusy(true); setMsg('');
    try { await fn(); await refresh(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <Shell>
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div className="label muted">{s.player.name}</div>
        <div className="display" style={{ fontSize: 96 }}>{s.player.balance}</div>
        <div className="label muted">COINS</div>
        <span className="pill" style={{ display: 'inline-block', background: '#14120F', color: 'white', padding: '7px 16px', marginTop: 10 }}>#{s.player.rank} OVERALL</span>
      </div>

      {p?.status === 'VOTING' ? (
        <Card>
          <div className="label">PREDICTION #{p.number} · VOTING OPEN</div>
          <h2 className="display">{p.question}</h2>
          <p>Your vote is secret. How likely is a YES?</p>
          <input aria-label="vote" type="range" min="0" max="100" step="5" value={vote} onChange={(e) => setVote(Number(e.target.value))} style={{ width: '100%' }} />
          <div className="display" style={{ fontSize: 36, color: '#9B2FF2', textAlign: 'center' }}>{vote}%</div>
          <button disabled={busy} className="btn btn-dark" onClick={() => act(() => mutation('/api/submit-vote', { gameId, predictionId: p.id, yesProbability: vote }))}>SUBMIT VOTE</button>
        </Card>
      ) : p?.status === 'BETTING' ? (
        <Card>
          <div className="label">PREDICTION #{p.number} · MARKET OPEN</div>
          <h2 className="display">{p.question}</h2>
          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={!!p.ownBet} onClick={() => setSide('YES')} style={{ flex: 1, border: side === 'YES' ? '3px solid #14120F' : '0', background: '#2FAF5B', color: 'white', padding: 20, borderRadius: 22 }}><b>YES</b><div className="display" style={{ fontSize: 28 }}>{p.yesOdds?.toFixed(2)}×</div></button>
            <button disabled={!!p.ownBet} onClick={() => setSide('NO')} style={{ flex: 1, border: side === 'NO' ? '3px solid #14120F' : '0', background: '#E8352F', color: 'white', padding: 20, borderRadius: 22 }}><b>NO</b><div className="display" style={{ fontSize: 28 }}>{p.noOdds?.toFixed(2)}×</div></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn" disabled={!!p.ownBet || maxStake < 5} onClick={() => setStake(Math.max(5, stake - 5))}>−</button>
            <div className="display" style={{ fontSize: 32, flex: 1, textAlign: 'center' }}>{stake}</div>
            <button className="btn btn-lime" disabled={!!p.ownBet || maxStake < 5} onClick={() => setStake(Math.min(maxStake, stake + 5))}>+</button>
          </div>
          <div>Potential return: <b>{Math.round(stake * (side === 'YES' ? p.yesOdds : p.noOdds))} coins</b></div>
          <button disabled={busy || !!p.ownBet || stake > balance || stake < 5 || stake > 500} className="btn btn-dark" onClick={() => act(() => mutation('/api/place-bet', { gameId, predictionId: p.id, side, stake }, true))}>{p.ownBet ? 'BET PLACED' : `PLACE ${stake} COINS ON ${side}`}</button>
        </Card>
      ) : p ? (
        <Card>
          <div className="label">PREDICTION #{p.number}</div>
          <h2 className="display">{p.question}</h2>
          {p.status === 'DRAFT' && <><div className="display" style={{ fontSize: 22 }}>COMING UP</div><p className="muted">The admin has made this prediction visible. Voting has not opened yet.</p></>}
          {p.status === 'CALCULATING' && <><div className="display" style={{ fontSize: 22 }}>VOTING CLOSED</div><p className="muted">The crowd result is being prepared.</p></>}
          {p.status === 'LOCKED' && <><div className="display" style={{ fontSize: 22 }}>MARKET LOCKED</div><p className="muted">Bets are closed. Waiting for the result.</p></>}
          {p.status === 'SETTLED' && <><div className="display" style={{ fontSize: 30, color: p.result === 'YES' ? '#2FAF5B' : '#E8352F' }}>{p.result} WON</div><p className="muted">The market has been settled.</p></>}
          {p.status === 'CANCELLED' && <><div className="display" style={{ fontSize: 24 }}>MARKET CANCELLED</div><p className="muted">Any stakes have been refunded.</p></>}
        </Card>
      ) : (
        <Card><div className="display" style={{ fontSize: 22 }}>NO PREDICTION VISIBLE</div><p className="muted">Your wallet stays available. The admin decides when a prediction appears here.</p></Card>
      )}

      <Card>
        <div className="label muted">RECENT LEDGER</div>
        {s.recentLedger.length === 0 && <p className="muted">No transactions yet.</p>}
        {s.recentLedger.slice(0, 8).map((x: any) => (
          <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #F0ECDB' }}>
            <span>{x.description}</span>
            <b style={{ color: x.amount >= 0 ? '#2FAF5B' : '#E8352F', whiteSpace: 'nowrap' }}>{x.amount > 0 ? '+' : ''}{x.amount}</b>
          </div>
        ))}
      </Card>
      {(msg || error) && <p>{msg || 'LIVE CONNECTION INTERRUPTED'}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: any }) {
  return <div style={{ minHeight: '100vh', background: '#E8E4D2', padding: '24px 0' }}><main style={{ width: 'min(100% - 20px,440px)', minHeight: 'calc(100vh - 48px)', margin: 'auto', background: '#F4F1E4', borderRadius: 36, padding: 22 }}>{children}</main></div>;
}
function Card({ children }: { children: any }) {
  return <div className="card" style={{ padding: 22, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>;
}
