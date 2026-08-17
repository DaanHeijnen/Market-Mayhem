import { useState } from 'react';
import { useGamePolling } from '../../hooks/useGamePolling';
import { api, mutation } from '../../lib/api';

type AdminAppProps = { gameId: number };

export function AdminApp({ gameId }: AdminAppProps) {
  const { data: s, error, refresh } = useGamePolling<any>(
    gameId,
    'admin',
    `/api/admin-state?gameId=${gameId}`,
  );
  const [auth, setAuth] = useState({ username: 'admin', password: '' });
  const [msg, setMsg] = useState('');
  const [player, setPlayer] = useState<number | ''>('');
  const [amount, setAmount] = useState(10);

  const run = async (path: string, body: any, idempotent = false) => {
    setMsg('');
    try {
      await mutation(path, { gameId, ...body }, idempotent);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };

  if (!s) {
    return (
      <div style={{ padding: 40 }}>
        <h1 className="display">Market Mayhem Admin</h1>
        <p>Sign in to control the room.</p>
        <input
          placeholder="username"
          value={auth.username}
          onChange={(e) => setAuth({ ...auth, username: e.target.value })}
        />
        <input
          type="password"
          placeholder="password"
          value={auth.password}
          onChange={(e) => setAuth({ ...auth, password: e.target.value })}
        />
        <button
          className="btn btn-dark"
          onClick={async () => {
            try {
              await api('/api/admin-login', {
                method: 'POST',
                body: JSON.stringify(auth),
              });
              location.reload();
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        >
          SIGN IN
        </button>
        <p>{msg}</p>
      </div>
    );
  }

  const p = s.prediction;

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 230, background: '#14120F', color: 'white', padding: '36px 20px' }}>
        <div className="label" style={{ marginBottom: 30 }}>● MARKET MAYHEM</div>
        {['CONTROL', 'ROUNDS', 'PLAYERS', 'PREDICTIONS', 'LEDGER', 'SETTINGS'].map((x, i) => (
          <div
            key={x}
            style={{
              padding: '16px 18px',
              borderRadius: 14,
              background: i === 0 ? '#DFF24C' : 'transparent',
              color: i === 0 ? '#14120F' : '#b8b4a3',
              fontWeight: 800,
            }}
          >
            {x}
          </div>
        ))}
      </aside>

      <main style={{ flex: 1, padding: '36px 42px' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h1 className="display">Control Center</h1>
          <div className="pill" style={{ background: '#14120F', color: 'white', padding: '14px 20px' }}>
            ROUND {s.game.current_round_id || '—'} · LIVE
          </div>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 22 }}>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="card" style={{ padding: 28 }}>
              <div className="label muted">ACTIVE PREDICTION {p && `· #${p.display_number}`}</div>
              <h2 className="display">{p?.question || 'No active prediction'}</h2>
              {p && (
                <>
                  <p>
                    {p.status} · YES {Number(p.yes_odds || 0).toFixed(2)}× · NO {Number(p.no_odds || 0).toFixed(2)}×
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-dark" onClick={() => run('/api/open-voting', { predictionId: p.id })}>OPEN VOTING</button>
                    <button className="btn" onClick={() => run('/api/close-voting', { predictionId: p.id })}>CLOSE VOTING</button>
                    <button className="btn btn-lime" onClick={() => run('/api/open-betting', { predictionId: p.id })}>OPEN BETTING</button>
                    <button className="btn btn-red" onClick={() => run('/api/close-market', { predictionId: p.id })}>CLOSE MARKET</button>
                    <button className="btn btn-blue" onClick={() => run('/api/settle-prediction', { predictionId: p.id, result: 'YES' }, true)}>SET RESULT: YES</button>
                    <button className="btn btn-blue" onClick={() => run('/api/settle-prediction', { predictionId: p.id, result: 'NO' }, true)}>SET RESULT: NO</button>
                  </div>
                </>
              )}
            </div>

            <div className="card" style={{ padding: 28 }}>
              <div className="label muted">ROUNDS</div>
              {s.rounds.map((r: any) => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 0' }}>
                  <span><b>{String(r.round_number).padStart(2, '0')}</b> {r.title}</span>
                  <span>{r.status} <button onClick={() => run('/api/start-round', { roundId: r.id })}>Start</button></span>
                </div>
              ))}
            </div>

            <div className="card" style={{ padding: 28 }}>
              <div className="label muted">RECENT TRANSACTIONS</div>
              {s.recentTransactions.map((x: any) => (
                <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 8 }}>
                  <span>{x.display_name} — {x.description}</span>
                  <b>{x.amount > 0 ? '+' : ''}{x.amount}</b>
                </div>
              ))}
            </div>
          </section>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ background: '#14120F', color: 'white', borderRadius: 28, padding: 26 }}>
              <div className="label muted">QUICK COIN CONTROL</div>
              <select
                value={player}
                onChange={(e) => setPlayer(e.target.value ? Number(e.target.value) : '')}
                style={{ width: '100%', margin: '14px 0', padding: 10 }}
              >
                <option value="">Choose player</option>
                {s.players.map((x: any) => (
                  <option value={x.id} key={x.id}>{x.display_name} · {x.current_balance}</option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-red" onClick={() => setAmount(Math.max(1, amount - 5))}>−</button>
                <div className="display" style={{ flex: 1, textAlign: 'center', fontSize: 28, color: '#DFF24C' }}>{amount} COINS</div>
                <button className="btn" style={{ background: '#2FAF5B', color: 'white' }} onClick={() => setAmount(amount + 5)}>+</button>
              </div>
              <button className="btn btn-lime" style={{ width: '100%', marginTop: 14 }} disabled={!player} onClick={() => run('/api/adjust-coins', { playerId: player, amount, reason: 'Quick adjustment' }, true)}>APPLY +</button>
              <button className="btn btn-red" style={{ width: '100%', marginTop: 8 }} disabled={!player} onClick={() => run('/api/adjust-coins', { playerId: player, amount: -amount, reason: 'Quick adjustment' }, true)}>APPLY −</button>
            </div>

            <div className="card" style={{ padding: 26 }}>
              <div className="label muted">BIG SCREEN</div>
              <h3 className="display">{s.screen.mode}</h3>
              <button className="btn btn-blue" style={{ width: '100%' }} onClick={() => run('/api/screen-mode', { mode: 'DASHBOARD' })}>RETURN TO DASHBOARD</button>
            </div>

            <div className="card" style={{ padding: 26 }}>
              <div className="label muted">PLAYERS</div>
              {s.players.map((x: any) => (
                <div key={x.id} style={{ padding: 8, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>{x.display_name} · <b>{x.current_balance}</b></span>
                  <button
                    onClick={async () => {
                      try {
                        const j = await mutation<any>('/api/player-join-link', { gameId, playerId: x.id });
                        const joinUrl = location.origin + j.path;
                        await navigator.clipboard?.writeText(joinUrl);
                        alert(`Join link copied: ${joinUrl}`);
                      } catch (e) {
                        setMsg((e as Error).message);
                      }
                    }}
                  >
                    JOIN LINK
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </div>

        {(msg || error) && (
          <div style={{ position: 'fixed', bottom: 20, right: 20, background: '#14120F', color: 'white', padding: 14, borderRadius: 12 }}>
            {msg || 'LIVE CONNECTION INTERRUPTED'}
          </div>
        )}
      </main>
    </div>
  );
}
