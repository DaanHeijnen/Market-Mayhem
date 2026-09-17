import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useGamePolling } from '../../hooks/useGamePolling';
import { api, mutation } from '../../lib/api';
import { ControlPage } from './control/ControlPage';
import { SettingsPage } from './settings/SettingsPage';
import { PlayersPage } from './players/PlayersPage';
import { RoundsPage } from './rounds/RoundsPage';
import { PredictionsPage } from './predictions/PredictionsPage';
import { LedgerPage } from './ledger/LedgerPage';
import { MarketPage } from './market/MarketPage';
import { Chip, ChipRow } from './ui';
import { PhonePreview } from './PhonePreview';
import { describeContent, roundMeta } from './roundMeta';

type Page = 'control' | 'rounds' | 'players' | 'predictions' | 'market' | 'ledger' | 'settings';

const PAGES: Page[] = ['control', 'rounds', 'predictions', 'players', 'market', 'ledger', 'settings'];
const TITLES: Record<Page, string> = {
  control: 'Control Center',
  rounds: 'Rounds',
  players: 'Players',
  predictions: 'Predictions',
  market: 'Market Dashboard',
  ledger: 'Ledger',
  settings: 'Settings',
};

export function AdminApp({ gameId }: { gameId: number }) {
  const { data: s, error, refresh } = useGamePolling<any>(gameId, 'admin', `/api/admin-state?gameId=${gameId}`);
  const [auth, setAuth] = useState({ username: 'admin', password: '' });
  const [msg, setMsg] = useState('');
  const [phone, setPhone] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();

  const parts = loc.pathname.split('/').filter(Boolean);
  const raw = (parts[2] || 'control').toLowerCase();
  const page = ((PAGES as string[]).includes(raw) ? raw : 'control') as Page;
  const roundId = page === 'rounds' && parts[3] ? Number(parts[3]) : null;

  /**
   * Send one admin action and pull the fresh state back.
   *
   * Refreshes whether the action succeeded or not. A rejected action is usually rejected
   * *because* this page is out of date — a step against a screen that has moved on, a
   * question somebody else already revealed — so the one thing the host needs next is the
   * current state, not the stale one they were looking at when it failed.
   *
   * Returns the server's reply on success, so a caller that needs something from it (the
   * new screen revision, say) can read it instead of polling for it. Falsy on failure, so
   * every existing `if (await run(...))` keeps working.
   */
  const run = async (path: string, body: Record<string, unknown>, idempotent = false, idempotencyKey?: string) => {
    setMsg('');
    let result: any = null;
    let failure = '';
    try {
      result = (await mutation<any>(path, { gameId, ...body }, idempotent, idempotencyKey)) ?? {};
    } catch (e) {
      failure = e instanceof Error ? e.message : 'Failed';
    }
    try {
      await refresh();
    } catch (e) {
      const trouble = `live refresh failed: ${e instanceof Error ? e.message : 'connection error'}`;
      setMsg(failure ? `${failure} — and ${trouble}` : `Change saved, but ${trouble}`);
      return failure ? false : result;
    }
    if (failure) { setMsg(failure); return false; }
    return result;
  };

  if (!s) {
    return <div className="auth-shell">
      <div className="card auth-card">
        <div className="label muted">MARKET MAYHEM</div>
        <h1 className="display">Admin Control</h1>
        <p className="muted">Sign in to configure and run the game night.</p>
        <input className="field" placeholder="Username" value={auth.username} onChange={e => setAuth({ ...auth, username: e.target.value })} />
        <input className="field" type="password" placeholder="Password" value={auth.password} onChange={e => setAuth({ ...auth, password: e.target.value })} />
        <button className="btn btn-dark" onClick={async () => {
          try {
            await api('/api/admin-login', { method: 'POST', body: JSON.stringify(auth) });
            location.reload();
          } catch (e) { setMsg((e as Error).message); }
        }}>SIGN IN</button>
        {(msg || error) && <p className="neg"><b>{msg || error}</b></p>}
      </div>
    </div>;
  }

  // The snapshot names the active round directly; finding it again here would be a second
  // opinion that can disagree with the one the Control Center runs on.
  const activeRound = s.activeRound || null;
  const activePlayerCount = s.players.filter((p: any) => p.active).length;
  const openPredictionCount = s.predictions.filter((p: any) => p.status === 'OPEN').length;
  const roundLabel = activeRound ? `ROUND ${String(activeRound.sortOrder).padStart(2, '0')}` : null;

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="brand">● MARKET MAYHEM</div>
      {PAGES.map(item => <button key={item} className={page === item ? 'active' : ''} onClick={() => nav(`/admin/${gameId}/${item}`)}>{item.toUpperCase()}</button>)}
      <div className="sidebar-spacer" />
      <div className="sidebar-caption">PLAYER APP</div>
      <button className="sidebar-preview-btn" onClick={() => setPhone(true)}>▸ PREVIEW ON PHONE</button>
    </aside>

    <main className="admin-main">
      <header className="admin-header">
        <div>
          <div className="label muted">{s.game.name}</div>
          <h1 className="display">{TITLES[page]}</h1>
        </div>
        <div className="header-actions">
          <PresentationToggle state={s} run={run} />
          <div className={`pill header-state ${activeRound ? 'active' : 'idle'}`}>
            {roundLabel ? `${roundLabel} · ACTIVE` : 'NO ROUND ACTIVE'}
          </div>
        </div>
      </header>

      <ChipRow>
        <Chip tone="white" onClick={() => nav(`/admin/${gameId}/players`)}>
          {activePlayerCount} PLAYER{activePlayerCount === 1 ? '' : 'S'}
        </Chip>
        {/* What the active round is and what it holds. A round's content lives under its
            own type now, so the count comes from describeContent rather than from a
            `blocks` array every round used to have. */}
        <Chip tone="ink" onClick={() => nav(`/admin/${gameId}/rounds`)}>
          {activeRound
            ? `${roundLabel} · ${roundMeta(activeRound.type).label.toUpperCase()} · ${describeContent(activeRound).toUpperCase()}`
            : 'NO ACTIVE ROUND'}
        </Chip>
        <Chip tone="blue" onClick={() => nav(`/admin/${gameId}/predictions`)}>
          {openPredictionCount} PREDICTION{openPredictionCount === 1 ? '' : 'S'} LIVE
        </Chip>
      </ChipRow>

      {page === 'control' && <ControlPage state={s} gameId={gameId} run={run} />}
      {page === 'players' && <PlayersPage state={s} gameId={gameId} run={run} setMsg={setMsg} />}
      {page === 'rounds' && <RoundsPage state={s} gameId={gameId} roundId={Number.isFinite(roundId) ? roundId : null} run={run} />}
      {page === 'predictions' && <PredictionsPage state={s} run={run} />}
      {page === 'market' && <MarketPage state={s} gameId={gameId} run={run} />}
      {page === 'ledger' && <LedgerPage state={s} gameId={gameId} />}
      {page === 'settings' && <SettingsPage state={s} gameId={gameId} run={run} onReset={() => nav(`/admin/${gameId}/control`)} />}

      {(msg || error) && <div className="toast">{msg || 'LIVE CONNECTION INTERRUPTED'}</div>}
    </main>

    {phone && <PhonePreview state={s} gameId={gameId} onClose={() => setPhone(false)} />}
  </div>;
}

/**
 * Temporarily show the standings, then come straight back to the same step.
 *
 * `remember` is what makes the return trip possible: it saves the live presentation into
 * the previous slot before the dashboard takes over. Neither direction touches the round
 * or its cursor — this only changes what the audience is looking at.
 */
function PresentationToggle({ state: s, run }: { state: any; run: (path: string, body: Record<string, unknown>) => Promise<boolean> }) {
  const screen = s.screen || {};
  const onDashboard = screen.mode === 'DASHBOARD';
  const canReturn = Boolean(screen.previous?.mode);
  if (onDashboard) {
    return canReturn
      ? <button className="btn btn-primary btn-compact" onClick={() => run('/api/restore-screen', {})}>BACK TO RUN OF SHOW</button>
      : null;
  }
  return <button className="btn btn-lime btn-compact" onClick={() => run('/api/show-on-screen', { kind: 'dashboard', remember: true })}>MARKET DASHBOARD</button>;
}
