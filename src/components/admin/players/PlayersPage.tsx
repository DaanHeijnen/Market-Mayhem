import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, CoinAmount, Empty, Status } from '../ui';

const defaultColor = '#6366F1';

type Adjustment = { playerId: number; amount: string; reason: string; roundId: string; idempotencyKey: string } | null;

export function PlayersPage({ state: s, gameId, run, setMsg }: { state: any; gameId: number; run: RunMutation; setMsg: (value: string) => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(defaultColor);
  const [editing, setEditing] = useState<any>(null);
  const [links, setLinks] = useState<Record<number, string>>({});
  const [adjustment, setAdjustment] = useState<Adjustment>(null);
  const [savingAdjustment, setSavingAdjustment] = useState(false);

  const create = async () => {
    if (await run('/api/create-player', { displayName: name, color })) {
      setName('');
      setColor(defaultColor);
    }
  };

  const generateLink = async (player: any, revoke = false) => {
    try {
      const response = await fetch('/api/player-join-link', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameId, playerId: player.id, revokeSessions: revoke }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed');
      setLinks(current => ({ ...current, [player.id]: location.origin + data.path }));
      setMsg(revoke ? 'New join link generated; existing session revoked.' : 'Join link generated.');
    } catch (error) {
      setMsg((error as Error).message);
    }
  };

  const copyAndHide = async (playerId: number) => {
    const value = links[playerId];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setLinks(current => {
        const next = { ...current };
        delete next[playerId];
        return next;
      });
      setMsg('Join link copied. The token is now hidden.');
    } catch {
      setMsg('Could not copy the join link. It remains visible so you can copy it manually.');
    }
  };

  const saveAdjustment = async () => {
    if (!adjustment || savingAdjustment) return;
    setSavingAdjustment(true);
    try {
      if (await run('/api/adjust-coins', {
        playerId: adjustment.playerId,
        amount: Number(adjustment.amount),
        reason: adjustment.reason,
        roundId: adjustment.roundId ? Number(adjustment.roundId) : null,
      }, true, adjustment.idempotencyKey)) setAdjustment(null);
    } finally {
      setSavingAdjustment(false);
    }
  };

  return <div className="page-stack">
    <Card>
      <div className="label muted">ADD PLAYER</div>
      <div className="inline-form">
        <input className="field" placeholder="Display name" value={name} onChange={e => setName(e.target.value)} />
        <label className="color-field"><span>Public color</span><input aria-label="Player color" type="color" value={color} onChange={e => setColor(e.target.value)} className="color-input" /></label>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={create}>ADD PLAYER</button>
      </div>
    </Card>

    {s.players.length === 0 ? <Empty title="No players yet — Add your first player" /> : <div className="card-list">
      {s.players.map((player: any) => <Card key={player.id} className={!player.active ? 'is-muted-card' : ''}>
        <div className="player-row">
          <div className="player-identity">
            <span className="player-dot" style={{ background: player.public_color }} />
            <div><div className="display row-title">{player.display_name}</div><div className="player-meta"><CoinAmount value={player.current_balance} />{player.locked_prediction > 0 && <span className="muted">+ {player.locked_prediction} locked</span>}<span className="muted">· {player.active ? (player.joined ? 'Joined' : 'Not joined') : 'Deactivated'}</span></div></div>
          </div>
          <Status tone={player.active ? 'success' : 'neutral'}>{player.active ? 'ACTIVE' : 'INACTIVE'}</Status>
        </div>

        {editing?.id === player.id ? <div className="compact-edit-row">
          <input className="field" value={editing.display_name} onChange={e => setEditing({ ...editing, display_name: e.target.value })} />
          <input type="color" value={editing.public_color} onChange={e => setEditing({ ...editing, public_color: e.target.value })} className="color-input" />
          <button className="btn btn-primary btn-compact" onClick={async () => { if (await run('/api/edit-player', { playerId: player.id, displayName: editing.display_name, color: editing.public_color })) setEditing(null); }}>SAVE</button>
          <button className="btn btn-secondary btn-compact" onClick={() => setEditing(null)}>CANCEL</button>
        </div> : player.active && <div className="actions actions-compact">
          <button className="btn btn-secondary btn-compact" onClick={() => setEditing({ ...player })}>EDIT</button>
          <button className="btn btn-secondary btn-compact" onClick={() => generateLink(player, false)}>{player.joined ? 'REGENERATE JOIN LINK' : 'GENERATE JOIN LINK'}</button>
          {player.joined && <button className="btn btn-secondary btn-compact" onClick={() => generateLink(player, true)}>NEW LINK + REVOKE SESSION</button>}
          <button className="btn btn-secondary btn-compact" onClick={() => setAdjustment({ playerId: player.id, amount: '', reason: '', roundId: '', idempotencyKey: crypto.randomUUID() })}>ADJUST COINS</button>
          <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/remove-player', { playerId: player.id })}>DEACTIVATE</button>
        </div>}

        {links[player.id] && <div className="link-box">
          <input className="field mono" readOnly value={links[player.id]} />
          <button className="btn btn-primary btn-compact" onClick={() => copyAndHide(player.id)}>COPY</button>
        </div>}
        {!links[player.id] && <div className="join-link-safe-state muted">Join tokens are only shown until they are copied.</div>}

        {adjustment?.playerId === player.id && <div className="inline-adjustment-panel">
          <div className="label muted">COIN ADJUSTMENT</div>
          <div className="form-grid compact admin-dense-form">
            <input className="field" type="number" placeholder="25 or -10" value={adjustment.amount} onChange={e => setAdjustment({ ...adjustment, amount: e.target.value })} />
            <input className="field" placeholder="Mandatory reason" value={adjustment.reason} onChange={e => setAdjustment({ ...adjustment, reason: e.target.value })} />
            <select className="field" value={adjustment.roundId} onChange={e => setAdjustment({ ...adjustment, roundId: e.target.value })}>
              <option value="">General / no round</option>
              {s.rounds.map((round: any) => <option key={round.id} value={round.id}>R{String(round.round_number).padStart(2, '0')} · {round.title}</option>)}
            </select>
          </div>
          <div className="actions actions-compact">
            <button className="btn btn-primary btn-compact" disabled={savingAdjustment || !adjustment.amount || Number(adjustment.amount) === 0 || !adjustment.reason.trim()} onClick={saveAdjustment}>{savingAdjustment ? 'SAVING…' : 'SAVE'}</button>
            <button className="btn btn-secondary btn-compact" onClick={() => setAdjustment(null)}>CANCEL</button>
          </div>
        </div>}
      </Card>)}
    </div>}
  </div>;
}
