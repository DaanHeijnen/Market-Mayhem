import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useGamePolling } from '../../hooks/useGamePolling';
import { Card, MobileViews, Shell, type MobileView } from './MobileViews';

/**
 * The live player app: session-authenticated polling, URL-driven navigation. Every
 * screen it renders comes from MobileViews, which the Admin's phone preview also
 * uses — so the preview shows the real thing rather than a copy of it.
 */
export function MobileApp({ gameId }: { gameId: number }) {
  const { data: s, error, refresh } = useGamePolling<any>(gameId, 'mobile', `/api/player-state?gameId=${gameId}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const loc = useLocation();
  const nav = useNavigate();

  if (!s) {
    return <Shell><Card><div className="display mobile-connect-title">{error ? 'SESSION REQUIRED' : 'CONNECTING…'}</div>{error && <p className="muted">Open your personal join link to enter this game.</p>}</Card></Shell>;
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const go = (path = '') => nav(`/play/${gameId}${path}`);
  const parts = loc.pathname.split('/').filter(Boolean);
  const view = (parts[2] || 'home') as MobileView;
  const predictionId = parts[3] ? Number(parts[3]) : null;

  return <Shell>
    <MobileViews state={s} gameId={gameId} view={view} predictionId={predictionId} busy={busy} act={act} go={go} />
    {(msg || error) && <div className="mobile-alert">{msg || error}</div>}
  </Shell>;
}
