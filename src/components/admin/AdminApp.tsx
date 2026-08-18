import { useEffect, useState } from 'react';
import { useGamePolling } from '../../hooks/useGamePolling';
import { api, mutation } from '../../lib/api';

type Page = 'CONTROL' | 'ROUNDS' | 'PLAYERS' | 'PREDICTIONS' | 'LEDGER' | 'SETTINGS';

type AdminAppProps = { gameId: number };

export function AdminApp({ gameId }: AdminAppProps) {
  const { data: s, error, refresh } = useGamePolling<any>(gameId, 'admin', `/api/admin-state?gameId=${gameId}`);
  const [auth, setAuth] = useState({ username: 'admin', password: '' });
  const [page, setPage] = useState<Page>('CONTROL');
  const [msg, setMsg] = useState('');

  const run = async (path: string, body: any, idempotent = false): Promise<boolean> => {
    setMsg('');
    try {
      await mutation(path, { gameId, ...body }, idempotent);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
      return false;
    }

    try {
      await refresh();
    } catch (e) {
      setMsg(`Change saved, but live refresh failed: ${e instanceof Error ? e.message : 'connection error'}`);
    }
    return true;
  };

  if (!s) {
    return (
      <div style={{ minHeight: '100vh', padding: 40, background: '#F4F1E4' }}>
        <div className="card" style={{ maxWidth: 520, margin: '10vh auto', padding: 34 }}>
          <div className="label muted">MARKET MAYHEM</div>
          <h1 className="display" style={{ fontSize: 42, marginBottom: 8 }}>Admin Control</h1>
          <p className="muted">Sign in to set up and run the game night.</p>
          <div style={{ display: 'grid', gap: 12 }}>
            <input className="field" placeholder="Username" value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
            <input className="field" type="password" placeholder="Password" value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} />
            <button
              className="btn btn-dark"
              onClick={async () => {
                try {
                  await api('/api/admin-login', { method: 'POST', body: JSON.stringify(auth) });
                  location.reload();
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
            >
              SIGN IN
            </button>
          </div>
          {(msg || error) && <p style={{ color: '#E8352F', fontWeight: 700 }}>{msg || error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F4F1E4' }}>
      <aside style={{ width: 230, background: '#14120F', color: 'white', padding: '32px 18px', flexShrink: 0 }}>
        <div className="label" style={{ margin: '0 12px 28px', color: '#fff' }}>● MARKET MAYHEM</div>
        {(['CONTROL', 'ROUNDS', 'PLAYERS', 'PREDICTIONS', 'LEDGER', 'SETTINGS'] as Page[]).map((item) => (
          <button
            key={item}
            onClick={() => setPage(item)}
            style={{
              width: '100%', textAlign: 'left', padding: '15px 16px', marginBottom: 5, border: 0, borderRadius: 14,
              background: page === item ? '#DFF24C' : 'transparent', color: page === item ? '#14120F' : '#b8b4a3', fontWeight: 800,
            }}
          >
            {item}
          </button>
        ))}
      </aside>

      <main style={{ flex: 1, padding: '34px 40px 60px', minWidth: 0 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'center', marginBottom: 26 }}>
          <div>
            <div className="label muted">{s.game.name}</div>
            <h1 className="display" style={{ fontSize: 38, margin: '4px 0 0' }}>{titleFor(page)}</h1>
          </div>
          <div className="pill" style={{ background: '#14120F', color: 'white', padding: '12px 18px', fontWeight: 800 }}>
            {s.game.current_round_id ? `ROUND ACTIVE` : 'NO ROUND ACTIVE'}
          </div>
        </header>

        {page === 'CONTROL' && <ControlPage state={s} gameId={gameId} run={run} />}
        {page === 'ROUNDS' && <RoundsPage state={s} run={run} />}
        {page === 'PLAYERS' && <PlayersPage state={s} gameId={gameId} run={run} setMsg={setMsg} />}
        {page === 'PREDICTIONS' && <PredictionsPage state={s} run={run} />}
        {page === 'LEDGER' && <LedgerPage state={s} />}
        {page === 'SETTINGS' && <SettingsPage state={s} run={run} />}

        {(msg || error) && (
          <div style={{ position: 'fixed', bottom: 20, right: 20, background: '#14120F', color: 'white', padding: '14px 18px', borderRadius: 14, maxWidth: 420, zIndex: 20 }}>
            {msg || 'LIVE CONNECTION INTERRUPTED'}
          </div>
        )}
      </main>
    </div>
  );
}

function ControlPage({ state: s, gameId, run }: { state: any; gameId: number; run: any }) {
  const [playerId, setPlayerId] = useState<number | ''>('');
  const [amount, setAmount] = useState(10);
  const [reason, setReason] = useState('');
  const [roundId, setRoundId] = useState<number | ''>('');
  const visible = s.visiblePrediction;

  const adjust = async (sign: 1 | -1) => {
    if (!playerId || !reason.trim()) return;
    if (await run('/api/adjust-coins', { playerId, amount: sign * amount, reason: reason.trim(), roundId: roundId || null }, true)) {
      setReason('');
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(360px,.8fr)', gap: 22 }}>
      <section style={{ display: 'grid', gap: 22, alignContent: 'start' }}>
        <div className="card" style={{ padding: 28 }}>
          <div className="label muted">CURRENTLY VISIBLE TO PLAYERS</div>
          {visible ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'start', marginTop: 12 }}>
                <div>
                  <div className="display" style={{ fontSize: 28 }}>Prediction #{visible.display_number}</div>
                  <h2 className="display" style={{ fontSize: 26, margin: '8px 0' }}>{visible.question}</h2>
                </div>
                <span className="pill" style={{ background: '#DFF24C', padding: '9px 14px', fontWeight: 800 }}>{visible.status}</span>
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>Player visibility is controlled from the Predictions page. Showing a prediction does not automatically open voting or betting.</p>
            </>
          ) : (
            <div style={{ padding: '28px 0 8px' }}>
              <div className="display" style={{ fontSize: 28 }}>Nothing is visible</div>
              <p className="muted">Players only see their wallet until you explicitly show a prediction.</p>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 28 }}>
          <div className="label muted">QUICK COIN CONTROL</div>
          <h2 className="display" style={{ margin: '8px 0 18px' }}>Adjust a player wallet</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: 12 }}>
            <select className="field" value={playerId} onChange={(e) => setPlayerId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose player</option>
              {s.players.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} · {p.current_balance} coins</option>)}
            </select>
            <select className="field" value={roundId} onChange={(e) => setRoundId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">No round attribution</option>
              {s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button className="btn" onClick={() => setAmount(Math.max(1, amount - 5))}>−</button>
            <input className="field" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))} style={{ width: 140, textAlign: 'center', fontWeight: 800 }} />
            <button className="btn btn-lime" onClick={() => setAmount(amount + 5)}>+</button>
            <span className="display" style={{ fontSize: 22 }}>COINS</span>
          </div>
          <textarea
            className="field"
            rows={3}
            placeholder="Required: reason for this adjustment (e.g. Won R03 bonus challenge)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ width: '100%', marginTop: 12, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn" style={{ flex: 1, background: '#2FAF5B', color: 'white' }} disabled={!playerId || !reason.trim()} onClick={() => adjust(1)}>ADD +{amount}</button>
            <button className="btn btn-red" style={{ flex: 1 }} disabled={!playerId || !reason.trim()} onClick={() => adjust(-1)}>REMOVE −{amount}</button>
          </div>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>A reason is mandatory. Every change is written to the immutable ledger.</p>
        </div>
      </section>

      <aside style={{ display: 'grid', gap: 22, alignContent: 'start' }}>
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div className="label muted">LIVE SCREEN PREVIEW</div>
              <div className="display" style={{ fontSize: 20, marginTop: 4 }}>{s.screen.mode}</div>
            </div>
            <a href={`/screen/${gameId}`} target="_blank" rel="noreferrer" className="btn btn-dark" style={{ textDecoration: 'none', padding: '10px 14px' }}>OPEN</a>
          </div>
          <ScreenPreview gameId={gameId} />
          <button className="btn btn-blue" style={{ width: '100%', marginTop: 12 }} onClick={() => run('/api/screen-mode', { mode: 'DASHBOARD' })}>RETURN BIG SCREEN TO DASHBOARD</button>
        </div>

        <div className="card" style={{ padding: 22 }}>
          <div className="label muted">LATEST LEDGER ACTIVITY</div>
          {s.recentTransactions.length === 0 ? <p className="muted">No transactions yet.</p> : s.recentTransactions.slice(0, 6).map((x: any) => (
            <div key={x.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid #F0ECDB' }}>
              <span><b>{x.display_name}</b> · {x.description}</span>
              <b style={{ color: x.amount > 0 ? '#2FAF5B' : '#E8352F', whiteSpace: 'nowrap' }}>{x.amount > 0 ? '+' : ''}{x.amount}</b>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function ScreenPreview({ gameId }: { gameId: number }) {
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: 16, background: '#14120F' }}>
      <iframe
        title="Live Market Mayhem screen preview"
        src={`/screen/${gameId}`}
        style={{ position: 'absolute', width: 1920, height: 1080, border: 0, transformOrigin: 'top left', transform: 'scale(var(--preview-scale, .2))', pointerEvents: 'none' }}
        onLoad={(event) => {
          const el = event.currentTarget;
          const parent = el.parentElement;
          if (parent) el.style.transform = `scale(${parent.clientWidth / 1920})`;
        }}
      />
    </div>
  );
}

function RoundsPage({ state: s, run }: { state: any; run: any }) {
  const [form, setForm] = useState({ roundNumber: nextRoundNumber(s.rounds), title: '', description: '' });
  useEffect(() => setForm((f) => ({ ...f, roundNumber: nextRoundNumber(s.rounds) })), [s.rounds.length]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px minmax(0,1fr)', gap: 22 }}>
      <div className="card" style={{ padding: 26, alignSelf: 'start' }}>
        <div className="label muted">CREATE ROUND</div>
        <h2 className="display">Build the running order</h2>
        <div style={{ display: 'grid', gap: 10 }}>
          <input className="field" type="number" min={1} value={form.roundNumber} onChange={(e) => setForm({ ...form, roundNumber: Number(e.target.value) })} placeholder="Round number" />
          <input className="field" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Round title" />
          <textarea className="field" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description (optional)" />
          <button className="btn btn-dark" disabled={!form.title.trim() || !form.roundNumber} onClick={async () => {
            if (await run('/api/create-round', form)) {
              setForm({ roundNumber: form.roundNumber + 1, title: '', description: '' });
            }
          }}>+ CREATE ROUND</button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        {s.rounds.length === 0 && <EmptyCard title="No rounds yet" text="Create the rounds for your game night. You can start them in any order." />}
        {s.rounds.map((r: any) => (
          <div key={r.id} className="card" style={{ padding: '20px 24px', display: 'flex', gap: 18, alignItems: 'center' }}>
            <div className="display" style={{ fontSize: 26, color: r.status === 'ACTIVE' ? '#3D5AFE' : '#9a9584', width: 54 }}>{String(r.round_number).padStart(2, '0')}</div>
            <div style={{ flex: 1 }}>
              <div className="display" style={{ fontSize: 20 }}>{r.title}</div>
              {r.description && <div className="muted" style={{ marginTop: 3 }}>{r.description}</div>}
            </div>
            <span className="pill" style={{ padding: '8px 12px', background: r.status === 'ACTIVE' ? '#DFF24C' : '#F0ECDB', fontWeight: 800 }}>{r.status}</span>
            {r.status === 'UPCOMING' && <button className="btn btn-dark" onClick={() => run('/api/start-round', { roundId: r.id })}>START</button>}
            {r.status === 'ACTIVE' && <button className="btn btn-lime" onClick={() => run('/api/complete-round', { roundId: r.id })}>COMPLETE</button>}
            {r.status === 'UPCOMING' && <button className="btn btn-red" onClick={() => confirm(`Delete R${r.round_number} ${r.title}?`) && run('/api/delete-round', { roundId: r.id })}>DELETE</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayersPage({ state: s, gameId, run, setMsg }: { state: any; gameId: number; run: any; setMsg: (v: string) => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3D5AFE');

  const copyJoinLink = async (playerId: number) => {
    try {
      const result = await mutation<any>('/api/player-join-link', { gameId, playerId });
      const full = location.origin + result.path;
      await navigator.clipboard?.writeText(full);
      setMsg(`Join link copied: ${full}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px minmax(0,1fr)', gap: 22 }}>
      <div className="card" style={{ padding: 26, alignSelf: 'start' }}>
        <div className="label muted">ADD PLAYER</div>
        <h2 className="display">New wallet</h2>
        <p className="muted">New players receive the starting balance configured in Settings: <b>{s.game.starting_balance} coins</b>.</p>
        <div style={{ display: 'grid', gap: 10 }}>
          <input className="field" placeholder="Player name" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>Player color <input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
          <button className="btn btn-dark" disabled={!name.trim()} onClick={async () => { if (await run('/api/create-player', { displayName: name.trim(), color })) setName(''); }}>+ ADD PLAYER</button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        {s.players.length === 0 && <EmptyCard title="No players yet" text="Add players here. Each player gets a wallet and a secure one-time join link." />}
        {s.players.map((p: any) => (
          <div key={p.id} className="card" style={{ padding: '18px 22px', display: 'flex', gap: 16, alignItems: 'center' }}>
            <div style={{ width: 18, height: 18, borderRadius: '50%', background: p.public_color, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div className="display" style={{ fontSize: 20 }}>{p.display_name}</div>
              <div className="muted">{p.current_balance} coins · rank #{p.rank}</div>
            </div>
            <button className="btn btn-lime" onClick={() => copyJoinLink(p.id)}>COPY JOIN LINK</button>
            <button className="btn btn-red" onClick={() => confirm(`Remove ${p.display_name}? Their ledger history will be preserved.`) && run('/api/remove-player', { playerId: p.id })}>REMOVE</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PredictionsPage({ state: s, run }: { state: any; run: any }) {
  const [form, setForm] = useState({ displayNumber: nextPredictionNumber(s.predictions), question: '', roundId: '' as number | '' });
  useEffect(() => setForm((f) => ({ ...f, displayNumber: nextPredictionNumber(s.predictions) })), [s.predictions.length]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px minmax(0,1fr)', gap: 22 }}>
      <div className="card" style={{ padding: 26, alignSelf: 'start' }}>
        <div className="label muted">CREATE PREDICTION</div>
        <h2 className="display">Make your own market</h2>
        <div style={{ display: 'grid', gap: 10 }}>
          <input className="field" type="number" min={1} value={form.displayNumber} onChange={(e) => setForm({ ...form, displayNumber: Number(e.target.value) })} placeholder="Prediction number" />
          <textarea className="field" rows={5} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="Prediction question" />
          <select className="field" value={form.roundId} onChange={(e) => setForm({ ...form, roundId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">No linked round</option>
            {s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}
          </select>
          <button className="btn btn-dark" disabled={!form.question.trim()} onClick={async () => {
            if (await run('/api/create-prediction', { displayNumber: form.displayNumber, question: form.question.trim(), roundId: form.roundId || null })) {
              setForm({ displayNumber: form.displayNumber + 1, question: '', roundId: '' });
            }
          }}>+ CREATE PREDICTION</button>
        </div>
        <div style={{ marginTop: 18, padding: 16, borderRadius: 18, background: '#F0ECDB' }}>
          <b>Visibility is independent from phase.</b>
          <p className="muted" style={{ marginBottom: 0 }}>You can open voting or betting while keeping a prediction hidden. Hidden phase changes stay backstage; when you show a live prediction, the Big Screen is cued to that phase and players can act on their phones.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        {s.predictions.length === 0 && <EmptyCard title="No predictions yet" text="Create a prediction, decide when players can see it, then control voting, betting and settlement here." />}
        {s.predictions.map((p: any) => (
          <div key={p.id} className="card" style={{ padding: 24, border: p.visible_to_players ? '3px solid #DFF24C' : '3px solid transparent' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ minWidth: 0 }}>
                <div className="label muted">PREDICTION #{p.display_number}{p.round_number ? ` · R${String(p.round_number).padStart(2, '0')}` : ''}</div>
                <h2 className="display" style={{ fontSize: 24, margin: '7px 0' }}>{p.question}</h2>
                <div className="muted">{p.vote_count} votes · {p.bet_count} bets · YES pool {p.yes_pool} · NO pool {p.no_pool}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'start', flexWrap: 'wrap', justifyContent: 'end' }}>
                <span className="pill" style={{ padding: '8px 12px', background: '#14120F', color: 'white', fontWeight: 800 }}>{p.status}</span>
                <span className="pill" style={{ padding: '8px 12px', background: p.visible_to_players ? '#DFF24C' : '#F0ECDB', fontWeight: 800 }}>{p.visible_to_players ? 'VISIBLE TO PLAYERS' : 'HIDDEN'}</span>
              </div>
            </div>

            {(p.yes_odds || p.no_odds) && <div className="display" style={{ marginTop: 12 }}>YES {Number(p.yes_odds || 0).toFixed(2)}× · NO {Number(p.no_odds || 0).toFixed(2)}×</div>}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
              <button className={p.visible_to_players ? 'btn btn-red' : 'btn btn-lime'} onClick={() => run('/api/set-prediction-visibility', { predictionId: p.id, visible: !p.visible_to_players })}>
                {p.visible_to_players ? 'HIDE FROM PLAYERS' : 'SHOW TO PLAYERS'}
              </button>
              {p.status === 'DRAFT' && <button className="btn btn-dark" onClick={() => run('/api/open-voting', { predictionId: p.id })}>OPEN VOTING</button>}
              {p.status === 'VOTING' && <button className="btn btn-dark" onClick={() => run('/api/close-voting', { predictionId: p.id })}>CLOSE VOTING + CALCULATE</button>}
              {p.status === 'CALCULATING' && <button className="btn btn-lime" onClick={() => run('/api/open-betting', { predictionId: p.id })}>OPEN BETTING</button>}
              {p.status === 'BETTING' && <button className="btn btn-red" onClick={() => run('/api/close-market', { predictionId: p.id })}>CLOSE MARKET</button>}
              {p.status === 'LOCKED' && <>
                <button className="btn" style={{ background: '#2FAF5B', color: 'white' }} onClick={() => run('/api/settle-prediction', { predictionId: p.id, result: 'YES' }, true)}>RESULT YES</button>
                <button className="btn btn-red" onClick={() => run('/api/settle-prediction', { predictionId: p.id, result: 'NO' }, true)}>RESULT NO</button>
                <button className="btn" onClick={() => run('/api/settle-prediction', { predictionId: p.id, result: 'CANCEL' }, true)}>CANCEL + REFUND</button>
              </>}
              {p.status === 'DRAFT' && <button className="btn" onClick={() => confirm(`Delete prediction #${p.display_number}?`) && run('/api/delete-prediction', { predictionId: p.id })}>DELETE DRAFT</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerPage({ state: s }: { state: any }) {
  return (
    <div className="card" style={{ padding: 26 }}>
      <div className="label muted">ADMINISTRATIVE LEDGER</div>
      <h2 className="display">Latest transactions</h2>
      {s.recentTransactions.length === 0 && <p className="muted">No ledger entries yet.</p>}
      {s.recentTransactions.map((x: any) => (
        <div key={x.id} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 110px', gap: 14, padding: '13px 0', borderBottom: '1px solid #F0ECDB', alignItems: 'center' }}>
          <b>{x.display_name}</b>
          <span>{x.description}{x.round_number ? ` · R${String(x.round_number).padStart(2, '0')}` : ''}</span>
          <b style={{ textAlign: 'right', color: x.amount > 0 ? '#2FAF5B' : '#E8352F' }}>{x.amount > 0 ? '+' : ''}{x.amount}</b>
        </div>
      ))}
    </div>
  );
}

function SettingsPage({ state: s, run }: { state: any; run: any }) {
  const [name, setName] = useState(s.game.name);
  const [startingBalance, setStartingBalance] = useState(Number(s.game.starting_balance));
  useEffect(() => { setName(s.game.name); setStartingBalance(Number(s.game.starting_balance)); }, [s.game.name, s.game.starting_balance]);

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="card" style={{ padding: 28 }}>
        <div className="label muted">GAME SETTINGS</div>
        <h2 className="display">Market setup</h2>
        <div style={{ display: 'grid', gap: 16 }}>
          <label><b>Game name</b><input className="field" style={{ width: '100%', marginTop: 7 }} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>
            <b>Starting coins for new players</b>
            <input className="field" style={{ width: '100%', marginTop: 7 }} type="number" min={0} step={1} value={startingBalance} onChange={(e) => setStartingBalance(Math.max(0, Number(e.target.value) || 0))} />
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>Changing this value affects players you add after saving. It does not rewrite existing wallets or ledger history.</div>
          </label>
          <button className="btn btn-dark" disabled={!name.trim()} onClick={() => run('/api/update-settings', { name: name.trim(), startingBalance })}>SAVE SETTINGS</button>
        </div>
      </div>
    </div>
  );
}

function EmptyCard({ title, text }: { title: string; text: string }) {
  return <div className="card" style={{ padding: 34 }}><div className="display" style={{ fontSize: 28 }}>{title}</div><p className="muted">{text}</p></div>;
}

function nextRoundNumber(rounds: any[]) {
  return Math.max(0, ...rounds.map((r) => Number(r.round_number) || 0)) + 1;
}

function nextPredictionNumber(predictions: any[]) {
  return Math.max(0, ...predictions.map((p) => Number(p.display_number) || 0)) + 1;
}

function titleFor(page: Page) {
  return page === 'CONTROL' ? 'Control Center' : page.charAt(0) + page.slice(1).toLowerCase();
}
