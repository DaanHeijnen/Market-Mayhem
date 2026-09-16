import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Card } from '../ui';

/**
 * The SLOTMACHINE editor: the round's own settings only.
 *
 * The reel artwork and the outcome distribution are one machine shared by the whole
 * night, so they live in Settings and this links there rather than duplicating them per
 * round — a round is only half the setup, and the notice says so before the host finds
 * out live.
 */
export function SlotmachineEditor({ state: s, round, gameId, run, readOnly }: {
  state: any; round: any; gameId: number; run: RunMutation; readOnly: boolean;
}) {
  const nav = useNavigate();
  const config = round.slotmachine || { maxSpins: 10, allowedPlayerIds: [] as number[] };
  const [maxSpins, setMaxSpins] = useState(String(config.maxSpins));
  const [allowed, setAllowed] = useState<number[]>(config.allowedPlayerIds);
  const status = s.slotConfig?.status;

  const save = () => run('/api/update-slotmachine-round', {
    roundId: round.id,
    maxSpins: Number(maxSpins) || 10,
    allowedPlayerIds: allowed,
  });

  return <Card>
    <div className="label muted">SLOTMACHINE — THIS ROUND</div>

    {status && <div className={`slot-config-notice ${status.valid ? 'is-valid' : 'is-invalid'}`}>
      <div>
        <b>{status.valid ? 'Slotmachine is configured' : 'Slotmachine needs setup'}</b>
        <span className="muted">{status.reason} {status.symbolCount} of 12 symbols uploaded.</span>
      </div>
      <button className="btn btn-secondary btn-compact" onClick={() => nav(`/admin/${gameId}/settings`)}>OPEN SETTINGS</button>
    </div>}

    <div className="form-grid compact">
      <label>Maximum spins per series
        <input className="field" type="number" min="1" max="10" disabled={readOnly} value={maxSpins} onChange={e => setMaxSpins(e.target.value)} />
      </label>
    </div>

    <div className="slot-participants">
      <div className="label muted">WHO CAN PLAY {allowed.length === 0 ? '· EVERYONE' : `· ${allowed.length} SELECTED`}</div>
      <p className="muted type-note">Leave all unchecked for everyone, which is the usual case.</p>
      <div className="group-members">
        {s.players.filter((player: any) => player.active).map((player: any) => {
          const selected = allowed.includes(player.id);
          return <label key={player.id} className={`group-member ${selected ? 'selected' : ''}`}>
            <input
              type="checkbox"
              disabled={readOnly}
              checked={selected}
              onChange={() => setAllowed(selected ? allowed.filter(id => id !== player.id) : [...allowed, player.id])}
            />
            <span className="player-dot" style={{ background: player.public_color }} />
            <span>{player.display_name}</span>
          </label>;
        })}
      </div>
    </div>

    {!readOnly && <div className="actions"><button className="btn btn-primary" onClick={save}>SAVE SETTINGS</button></div>}
  </Card>;
}
