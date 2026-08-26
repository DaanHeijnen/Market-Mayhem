import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { RunMutation } from '../types';
import { Card, Empty } from '../ui';
import { PlayerValueGraph } from '../../shared/PlayerValueGraph';

/**
 * Admin view of the projector's exchange chart. It reads the same
 * `/api/screen-state` payload the Big Screen reads and renders the same
 * PlayerValueGraph, so what the host inspects here cannot drift from what the
 * audience sees.
 *
 * Deliberately a one-shot fetch keyed on `state.version` rather than its own
 * useGamePolling loop — a second loop here would double the Admin surface's
 * version polling and pull a 12-query screen snapshot on every change. Same
 * pattern as LedgerPage.
 */
export function MarketPage({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const [screen, setScreen] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    api<any>(`/api/screen-state?gameId=${gameId}`)
      .then(next => { if (!stop) { setScreen(next); setError(''); } })
      .catch(e => { if (!stop) setError(e instanceof Error ? e.message : 'Failed to load exchange data'); });
    return () => { stop = true; };
  }, [gameId, s.version]);
  const onDashboard = s.screen?.mode === 'DASHBOARD';

  return <div className="page-stack">
    <Card>
      <div className="market-intro">
        <div>
          <div className="label muted">EXCHANGE CHART</div>
          <p>This is the exact chart shown on the Big Screen dashboard — each player's coin value plotted chronologically against their starting balance.</p>
        </div>
        <button className="btn btn-primary" disabled={onDashboard} onClick={() => run('/api/screen-mode', { mode: 'DASHBOARD' })}>
          {onDashboard ? 'ON BIG SCREEN NOW' : 'SHOW ON BIG SCREEN'}
        </button>
      </div>
      {error && <p className="neg"><b>{error}</b></p>}
    </Card>

    {!screen ? <Empty title="Loading exchange data…" /> : screen.leaderboard.length === 0
      ? <Empty title="No players yet — the chart appears once players are added" />
      : <div className="market-chart-panel graph-panel-admin">
        <div className="label muted">PLAYER VALUE · ECONOMIC CHRONOLOGY</div>
        <PlayerValueGraph players={screen.leaderboard} />
      </div>}

    <Card>
      <div className="label muted">CURRENT VALUE</div>
      <div className="summary-grid">
        {s.players.filter((p: any) => p.active).map((p: any) => <div key={p.id} className="summary-chip" style={{ borderLeftColor: p.public_color }}>
          <b>{p.display_name}</b>
          <strong>{p.current_balance + p.locked_prediction}</strong>
        </div>)}
      </div>
    </Card>
  </div>;
}
