import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Status } from '../ui';

/**
 * Round groups: the temporary teams a round is scored in.
 *
 * Round-scoped on purpose — `round_group_members` is unique by (round_id, player_id), so
 * a player is on at most one team per round. That uniqueness is what lets the server
 * derive a player's team from their session rather than trusting a team id from their
 * phone, which is what makes the Fotoronde's "upload for your own team" enforceable.
 *
 * Group adjustments create one ledger entry per member. There is no group wallet.
 */
export function RoundGroups({ state: s, round, run }: { state: any; round: any; run: RunMutation }) {
  const [groupName, setGroupName] = useState("");
  const [editingMembers, setEditingMembers] = useState<Record<number, number[]>>({});
  const [adjustments, setAdjustments] = useState<Record<number, { amount: string; reason: string; idempotencyKey: string }>>({});
  const [savingGroupId, setSavingGroupId] = useState<number | null>(null);
  const [groupNames, setGroupNames] = useState<Record<number, string>>({});
  const structureLocked = round.status === 'COMPLETED';
  const groups = round.groups || [];

  const membersFor = (group: any) => editingMembers[group.id] || group.members.map((m: any) => m.id);
  const toggleMember = (group: any, playerId: number) => {
    const current = membersFor(group);
    setEditingMembers({ ...editingMembers, [group.id]: current.includes(playerId) ? current.filter(id => id !== playerId) : [...current, playerId] });
  };

  return <Card>
    <div className="row-between"><div><div className="label muted">ROUND GROUPS</div><h2 className="display page-card-title">Temporary teams for this round</h2></div><Status>{groups.length} GROUP{groups.length === 1 ? '' : 'S'}</Status></div>
    {!structureLocked && <div className="inline-form"><input className="field" placeholder="Group name" value={groupName} onChange={e => setGroupName(e.target.value)} /><button className="btn btn-primary" disabled={!groupName.trim()} onClick={async () => { if (await run('/api/upsert-round-group', { roundId: round.id, name: groupName })) setGroupName(''); }}>CREATE GROUP</button></div>}
    {structureLocked && <p className="muted">Membership is frozen because this round is completed. Historical group coin adjustments remain available.</p>}
    {groups.length === 0 ? <div className="sub-empty">No groups in this round.</div> : <div className="group-grid">
      {groups.map((group: any) => {
        const selected = membersFor(group);
        const adjustment = adjustments[group.id] || { amount: '', reason: '', idempotencyKey: crypto.randomUUID() };
        return <div className="group-card" key={group.id}>
          <div className="row-between"><div><div className="label muted">GROUP</div><div className="display group-title">{group.name}</div></div>{!structureLocked && <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-round-group', { groupId: group.id })}>DELETE</button>}</div>
          {!structureLocked && <div className="inline-form group-rename"><input className="field" value={groupNames[group.id] ?? group.name} onChange={e => setGroupNames({ ...groupNames, [group.id]: e.target.value })} /><button className="btn btn-secondary btn-compact" disabled={!(groupNames[group.id] ?? group.name).trim() || (groupNames[group.id] ?? group.name).trim() === group.name} onClick={async () => { const name = (groupNames[group.id] ?? group.name).trim(); if (await run('/api/upsert-round-group', { roundId: round.id, groupId: group.id, name })) setGroupNames(current => { const next = { ...current }; delete next[group.id]; return next; }); }}>SAVE NAME</button></div>}
          <div className="group-members">
            {s.players.filter((player: any) => player.active || selected.includes(player.id)).map((player: any) => <label key={player.id} className={`group-member ${selected.includes(player.id) ? 'selected' : ''}`}><input type="checkbox" disabled={structureLocked} checked={selected.includes(player.id)} onChange={() => toggleMember(group, player.id)} /><span className="player-dot" style={{ background: player.public_color }} /><span>{player.display_name}</span></label>)}
          </div>
          {!structureLocked && <button className="btn btn-secondary btn-compact" onClick={async () => { if (await run('/api/set-round-group-members', { groupId: group.id, playerIds: selected })) setEditingMembers(current => { const next = { ...current }; delete next[group.id]; return next; }); }}>SAVE MEMBERS</button>}
          {round.status !== 'UPCOMING' ? <div className="group-adjustment">
            <div className="label muted">GROUP COIN ADJUSTMENT · ATTRIBUTED TO ROUND {String(round.sortOrder).padStart(2, '0')}</div>
            <div className="compact-adjust-grid"><input className="field" type="number" placeholder="+20 or -10" value={adjustment.amount} onChange={e => setAdjustments({ ...adjustments, [group.id]: { ...adjustment, amount: e.target.value } })} /><input className="field" placeholder="Mandatory reason" value={adjustment.reason} onChange={e => setAdjustments({ ...adjustments, [group.id]: { ...adjustment, reason: e.target.value } })} /><button className="btn btn-primary btn-compact" disabled={savingGroupId === group.id || !adjustment.amount || Number(adjustment.amount) === 0 || !adjustment.reason.trim()} onClick={async () => { if (savingGroupId !== null) return; setSavingGroupId(group.id); try { if (await run('/api/adjust-group-coins', { groupId: group.id, amount: Number(adjustment.amount), reason: adjustment.reason }, true, adjustment.idempotencyKey)) setAdjustments({ ...adjustments, [group.id]: { amount: '', reason: '', idempotencyKey: crypto.randomUUID() } }); } finally { setSavingGroupId(null); } }}>{savingGroupId === group.id ? 'SAVING…' : 'SAVE'}</button></div>
          </div> : <p className="muted group-scoring-note">Coin scoring becomes available when this round starts.</p>}
        </div>;
      })}
    </div>}
  </Card>;
}
