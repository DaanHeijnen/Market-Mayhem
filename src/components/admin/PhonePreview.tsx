import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { MobileViews, type MobileView } from '../mobile/MobileViews';

/**
 * What a player's phone shows right now, inside the Admin surface.
 *
 * It renders the real MobileViews from the real `player-state` payload, so it
 * cannot drift from the app the players are holding. Read-only: navigation works
 * so the host can look around, but nothing can be submitted on a player's behalf.
 *
 * One-shot fetch keyed on the Admin snapshot's `version`, never its own polling
 * loop — an open preview costs no extra database compute beyond the poll the
 * Admin surface was already doing.
 */
export function PhonePreview({ state: s, gameId, onClose }: { state: any; gameId: number; onClose: () => void }) {
  const players = s.players.filter((p: any) => p.active);
  const [playerId, setPlayerId] = useState<number | null>(players[0]?.id ?? null);
  const [view, setView] = useState<MobileView>('home');
  const [predictionId, setPredictionId] = useState<number | null>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (playerId == null) return;
    let stop = false;
    setError('');
    api<any>(`/api/player-state-preview?gameId=${gameId}&playerId=${playerId}`)
      .then(next => { if (!stop) setData(next); })
      .catch(e => { if (!stop) { setData(null); setError(e instanceof Error ? e.message : 'Could not load this player'); } });
    return () => { stop = true; };
  }, [gameId, playerId, s.version]);

  // MobileViews navigates with the same paths the live app uses, so the preview
  // parses them rather than inventing a second navigation vocabulary.
  const go = (path = '') => {
    const parts = path.split('/').filter(Boolean);
    setView((parts[0] as MobileView) || 'home');
    setPredictionId(parts[1] ? Number(parts[1]) : null);
    setNote('');
  };

  const selectPlayer = (id: number) => { setPlayerId(id); setView('home'); setPredictionId(null); setData(null); setNote(''); };

  return <div className="modal-backdrop phone-backdrop" onClick={onClose}>
    <div className="phone-frame" onClick={e => e.stopPropagation()}>
      <div className="phone-frame-head">
        <div className="label muted">PLAYER APP · READ-ONLY</div>
        <button className="btn btn-secondary btn-compact" onClick={onClose}>CLOSE</button>
      </div>
      {players.length === 0
        ? <p className="muted">Add a player first — there is no phone to preview yet.</p>
        : <>
          <div className="phone-player-tabs">
            {players.map((p: any) => <button key={p.id} className={`chip ${p.id === playerId ? 'chip-ink' : 'chip-white'}`} onClick={() => selectPlayer(p.id)}>
              <span className="legend-dot" style={{ background: p.public_color }} />{p.display_name}
            </button>)}
          </div>
          {error && <p className="neg"><b>{error}</b></p>}
          {/* Above the phone, not below it: the frame scrolls, and a note under the
              whole player app is a note nobody reads. Chips can be dropped on the
              roulette table locally, so the disabled PLACE button needs explaining. */}
          <p className="muted phone-note">{note || 'Read-only preview — you can look around, but only the player can act on their own wallet.'}</p>
          {!data ? <p className="muted">Loading this player's phone…</p> : <div className="mobile-shell phone-screen">
            <MobileViews
              state={data}
              gameId={gameId}
              view={view}
              predictionId={predictionId}
              /* busy=true keeps every submit control disabled; act() never fires a
                 mutation, so a stray click cannot bet on a player's behalf. */
              busy
              act={() => setNote('This is a preview — only the player can act on their own wallet.')}
              go={go}
            />
          </div>}
        </>}
    </div>
  </div>;
}
