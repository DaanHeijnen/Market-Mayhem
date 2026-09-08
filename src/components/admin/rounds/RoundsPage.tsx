import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Card, Empty, Status } from '../ui';
import { AUTHORABLE_BLOCK_TYPES, blockLabel, blockMeta } from '../blockMeta';
import { MediaField } from './MediaField';

const QUESTION_EMOJIS = ['🍆','🌽','🍑','😳'] as const;

/** Mirrors DEFAULT_PHOTO_SUBJECTS in netlify/lib/photo-round.ts; the server normalises. */
const DEFAULT_PHOTO_SUBJECT_LABELS = [
  'Iets kunstigs',
  'Iets lelijks',
  'Iets moois',
  'Iets opwindends',
  'Iets wat met het geloof heeft te maken',
  'Iets kinderlijks',
];

const blankBlock = { type: 'TEXT', title: '', body: '', answers: ['', '', '', ''], correctAnswerIndex: 0, rewardCoins: 10, imageKey: '', audioKey: '', audioName: '', correctAnswer: '', maxSpins: 10, allowedPlayerIds: [] as number[], subjects: [...DEFAULT_PHOTO_SUBJECT_LABELS] };

export function RoundsPage({ state: s, gameId, roundId, run }: { state: any; gameId: number; roundId: number | null; run: RunMutation }) {
  const nav = useNavigate();
  const [selected, setSelected] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [newRound, setNewRound] = useState({ roundNumber: '', title: '', description: '' });
  const round = useMemo(() => s.rounds.find((r: any) => r.id === roundId) || null, [s.rounds, roundId]);
  if (round) return <RoundDetail state={s} round={round} gameId={gameId} run={run} back={() => nav(`/admin/${gameId}/rounds`)} />;

  const cancelCreate = () => { setCreating(false); setNewRound({ roundNumber: '', title: '', description: '' }); };

  return <div className="page-stack">
    <div className="explainer">A round is one segment of the night — a quiz, a mini-game, a break. Build it with content blocks; in Control Center you step through them in this exact order.</div>

    {!creating
      ? <div className="row-end"><button className="btn btn-primary" onClick={() => setCreating(true)}>+ NEW ROUND</button></div>
      : <Card>
        <div className="label muted">CREATE ROUND</div>
        <div className="form-grid compact">
          <label>Round number<input className="field" type="number" min="1" value={newRound.roundNumber} onChange={e => setNewRound({ ...newRound, roundNumber: e.target.value })} /></label>
          <label>Title<input className="field" value={newRound.title} onChange={e => setNewRound({ ...newRound, title: e.target.value })} /></label>
        </div>
        <label>Description<textarea className="field" rows={2} value={newRound.description} onChange={e => setNewRound({ ...newRound, description: e.target.value })} /></label>
        <div className="actions">
          <button className="btn btn-primary" disabled={!newRound.roundNumber || !newRound.title.trim()} onClick={async () => { if (await run('/api/create-round', { roundNumber: Number(newRound.roundNumber), title: newRound.title, description: newRound.description })) cancelCreate(); }}>CREATE ROUND</button>
          <button className="btn btn-secondary" onClick={cancelCreate}>CANCEL</button>
        </div>
      </Card>}

    {s.rounds.length === 0 ? <Empty title="No rounds yet — Create your first round" /> : <div className="card-list round-list">
      {s.rounds.map((item: any) => <Card key={item.id} className={`round-card round-${String(item.status).toLowerCase()}`}>
        <div className="row-between"><div><div className="label muted">ROUND {String(item.round_number).padStart(2, '0')}</div><div className="display row-title">{item.title}</div><div className="muted">{item.blocks.length} content block{item.blocks.length === 1 ? '' : 's'} · {item.groups.length} group{item.groups.length === 1 ? '' : 's'}</div></div><Status tone={item.status === 'ACTIVE' ? 'open' : item.status === 'COMPLETED' ? 'success' : 'neutral'}>{item.status}</Status></div>
        {selected?.id === item.id ? <div className="compact-edit-row multi"><input className="field" type="number" value={selected.round_number} onChange={e => setSelected({ ...selected, round_number: Number(e.target.value) })} /><input className="field" value={selected.title} onChange={e => setSelected({ ...selected, title: e.target.value })} /><textarea className="field" value={selected.description || ''} onChange={e => setSelected({ ...selected, description: e.target.value })} /><button className="btn btn-primary btn-compact" onClick={async () => { if (await run('/api/edit-round', { roundId: item.id, roundNumber: selected.round_number, title: selected.title, description: selected.description || '' })) setSelected(null); }}>SAVE</button></div> : <div className="actions actions-compact">
          <button className="btn btn-secondary btn-compact" onClick={() => nav(`/admin/${gameId}/rounds/${item.id}`)}>{item.status === 'COMPLETED' ? 'INSPECT + GROUPS' : 'CONTENT + GROUPS'}</button>
          {item.status !== 'COMPLETED' && <button className="btn btn-secondary btn-compact" onClick={() => setSelected({ ...item })}>EDIT</button>}
          {item.status === 'UPCOMING' && <><button className="btn btn-primary btn-compact" onClick={() => run('/api/start-round', { roundId: item.id })}>START</button><button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-round', { roundId: item.id })}>DELETE</button></>}
          {item.status === 'ACTIVE' && <button className="btn btn-primary btn-compact" onClick={() => run('/api/complete-round', { roundId: item.id })}>COMPLETE</button>}
        </div>}
      </Card>)}
    </div>}
  </div>;
}

function RoundDetail({ state: s, round, gameId, run, back }: { state: any; round: any; gameId: number; run: RunMutation; back: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const [blockForm, setBlockForm] = useState<any>(blankBlock);
  const [groupName, setGroupName] = useState('');
  const blocks = round.blocks || [];
  const readOnlyContent = round.status === 'COMPLETED';

  const resetBlock = () => { setEdit(null); setBlockForm(blankBlock); };
  const submitBlock = async () => {
    const payload = {
      roundId: round.id, blockId: edit?.id || null, type: blockForm.type, title: blockForm.title, body: blockForm.body,
      ...(blockForm.type === 'DUOLINGO_QUESTION' ? { answers: blockForm.answers, correctAnswerIndex: Number(blockForm.correctAnswerIndex), rewardCoins: Number(blockForm.rewardCoins) } : {}),
      ...(blockForm.type === 'PICTURE' ? { imageKey: blockForm.imageKey || null } : {}),
      ...(blockForm.type === 'MUSIC' ? { audioKey: blockForm.audioKey || null, audioName: blockForm.audioName } : {}),
      ...(blockForm.type === 'WAGER' ? { correctAnswer: blockForm.correctAnswer } : {}),
      ...(blockForm.type === 'SLOTMACHINE' ? { maxSpins: Number(blockForm.maxSpins) || 1, allowedPlayerIds: blockForm.allowedPlayerIds } : {}),
      // Labels only; the server derives and preserves each subject's stable key.
      ...(blockForm.type === 'FOTORONDE' ? { subjects: blockForm.subjects.filter((label: string) => label.trim()).map((label: string) => ({ label })) } : {}),
    };
    if (await run('/api/upsert-round-block', payload)) resetBlock();
  };
  const beginEdit = (block: any) => {
    setEdit(block);
    setBlockForm({
      type: block.type,
      title: block.title || '',
      body: block.payload?.body || '',
      answers: block.payload?.answers || ['', '', '', ''],
      correctAnswerIndex: block.payload?.correctAnswerIndex ?? 0,
      rewardCoins: block.payload?.rewardCoins ?? 10,
      imageKey: block.payload?.imageKey || '',
      audioKey: block.payload?.audioKey || '',
      audioName: block.payload?.audioName || '',
      correctAnswer: block.payload?.correctAnswer || '',
      maxSpins: block.payload?.maxSpins ?? 10,
      allowedPlayerIds: Array.isArray(block.payload?.allowedPlayerIds) ? block.payload.allowedPlayerIds : [],
      subjects: Array.isArray(block.payload?.subjects) && block.payload.subjects.length
        ? block.payload.subjects.map((s: any) => String(s?.label ?? ''))
        : [...DEFAULT_PHOTO_SUBJECT_LABELS],
    });
  };
  const move = async (index: number, dir: -1 | 1) => {
    const next = [...blocks]; const target = index + dir; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await run('/api/reorder-round-blocks', { roundId: round.id, blockIds: next.map((b: any) => b.id) });
  };
  const show = (block: any) => run('/api/set-active-round-block', { roundId: round.id, blockId: block.id });
  const questionAction = (block: any, action: string) => run('/api/question-action', { blockId: block.id, action });

  return <div className="page-stack">
    <button className="btn btn-secondary back-btn" onClick={back}>← ALL ROUNDS</button>
    <Card>
      <div className="row-between"><div><div className="label muted">ROUND {String(round.round_number).padStart(2, '0')}</div><h2 className="display page-card-title">{round.title}</h2><p className="muted">{round.description || 'No description'}</p></div><Status tone={round.status === 'ACTIVE' ? 'open' : round.status === 'COMPLETED' ? 'success' : 'neutral'}>{round.status}</Status></div>
    </Card>

    {!readOnlyContent && <Card>
      <div className="label muted">{edit ? 'EDIT BLOCK' : 'ADD CONTENT — CHOOSE WHAT HAPPENS'}</div>
      <div className="block-type-grid">
        {AUTHORABLE_BLOCK_TYPES.map(type => {
          const meta = blockMeta(type);
          return <button key={type} className={`block-type-tile accent-${meta.accent} ${blockForm.type === type ? 'selected' : ''}`} aria-pressed={blockForm.type === type} onClick={() => setBlockForm({ ...blankBlock, type })}>
            <span className="accent-swatch" />
            <b>{meta.label}</b>
            <span>{meta.description}</span>
          </button>;
        })}
      </div>
      <div className="form-grid compact">
        <label className="span-2">{blockForm.type === 'QUESTION' || blockForm.type === 'DUOLINGO_QUESTION' ? 'Question text' : blockForm.type === 'TEXT' ? 'Optional title' : 'Title'}<input className="field" value={blockForm.title} onChange={e => setBlockForm({ ...blockForm, title: e.target.value })} /></label>
      </div>
      {['TEXT','QUESTION','PICTURE','MUSIC','BUZZER','WAGER','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'].includes(blockForm.type) && <label>{blockForm.type === 'TEXT' ? 'Body / instructions' : ['SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'].includes(blockForm.type) ? 'Instructions shown on the players\u2019 phones' : 'Optional supporting text'}<textarea className="field" rows={blockForm.type === 'TEXT' ? 4 : 2} value={blockForm.body} onChange={e => setBlockForm({ ...blockForm, body: e.target.value })} /></label>}

      {blockForm.type === 'PICTURE' && <MediaField
        kind="image" gameId={gameId} value={blockForm.imageKey}
        label="Round image"
        hint="Shown on the projector. The title above is what players are guessing, so it stays hidden until you reveal it."
        onChange={({ key }) => setBlockForm({ ...blockForm, imageKey: key })}
      />}

      {blockForm.type === 'MUSIC' && <MediaField
        kind="audio" gameId={gameId} value={blockForm.audioKey} name={blockForm.audioName}
        label="Song audio"
        hint="Players hear this. The title above is the song title and stays hidden until you reveal it."
        onChange={({ key, name }) => setBlockForm({ ...blockForm, audioKey: key, audioName: name })}
      />}

      {blockForm.type === 'WAGER' && <label>Correct answer<input className="field" placeholder="Used to judge who wins their wager" value={blockForm.correctAnswer} onChange={e => setBlockForm({ ...blockForm, correctAnswer: e.target.value })} /></label>}

      {/* Only this block's own settings. The reel artwork and the outcome distribution
          are one machine shared by the whole night, so they live in Settings — this
          links there rather than duplicating them per block. */}
      {blockForm.type === 'SLOTMACHINE' && <div className="slot-block-editor">
        <div className="form-grid compact">
          <label>Maximum spins per series<input className="field" type="number" min="1" max="100" value={blockForm.maxSpins} onChange={e => setBlockForm({ ...blockForm, maxSpins: e.target.value })} /></label>
        </div>
        <SlotConfigNotice state={s} gameId={gameId} />
        <div className="slot-participants">
          <div className="label muted">WHO CAN PLAY {blockForm.allowedPlayerIds.length === 0 ? '· EVERYONE' : `· ${blockForm.allowedPlayerIds.length} SELECTED`}</div>
          <p className="muted type-note">Leave all unchecked for everyone, which is the usual case.</p>
          <div className="group-members">
            {s.players.filter((player: any) => player.active).map((player: any) => {
              const selected = blockForm.allowedPlayerIds.includes(player.id);
              return <label key={player.id} className={`group-member ${selected ? 'selected' : ''}`}>
                <input type="checkbox" checked={selected} onChange={() => setBlockForm({
                  ...blockForm,
                  allowedPlayerIds: selected
                    ? blockForm.allowedPlayerIds.filter((id: number) => id !== player.id)
                    : [...blockForm.allowedPlayerIds, player.id],
                })} />
                <span className="player-dot" style={{ background: player.public_color }} />
                <span>{player.display_name}</span>
              </label>;
            })}
          </div>
        </div>
      </div>}

      {/* The subject list. Editable while the round has not started; the server keeps
          each subject's key stable so renaming one never detaches its photos. */}
      {blockForm.type === 'FOTORONDE' && <div className="photo-subject-editor">
        <div className="label muted">FOTO-OPDRACHTEN · {blockForm.subjects.filter((x: string) => x.trim()).length}</div>
        <p className="muted type-note">
          Every team gets this same list and uploads one photo per subject. You award credits per photo once
          submissions are closed.
        </p>
        {blockForm.subjects.map((label: string, index: number) => <div className="photo-subject-row" key={index}>
          <span className="photo-subject-number">{index + 1}</span>
          <input
            className="field"
            value={label}
            placeholder="Onderwerp"
            onChange={e => setBlockForm({ ...blockForm, subjects: blockForm.subjects.map((x: string, i: number) => i === index ? e.target.value : x) })}
          />
          <button
            className="btn btn-danger-ghost btn-compact"
            disabled={blockForm.subjects.length <= 1}
            onClick={() => setBlockForm({ ...blockForm, subjects: blockForm.subjects.filter((_: string, i: number) => i !== index) })}
          >×</button>
        </div>)}
        <div className="actions actions-compact">
          <button
            className="btn btn-secondary btn-compact"
            disabled={blockForm.subjects.length >= 20}
            onClick={() => setBlockForm({ ...blockForm, subjects: [...blockForm.subjects, ''] })}
          >+ ONDERWERP</button>
          <button
            className="btn btn-secondary btn-compact"
            onClick={() => setBlockForm({ ...blockForm, subjects: [...DEFAULT_PHOTO_SUBJECT_LABELS] })}
          >RESET NAAR STANDAARD ZES</button>
        </div>
      </div>}

      {blockForm.type === 'PAK_EEN_ZES' && <p className="muted type-note">
        Nothing else to configure: the deck is a fixed 52 cards, the game ends when all four sixes are out, and every
        active player takes a turn. You open the predictions, close them and start the game from the Control Center;
        the turn order is fixed when you start.
      </p>}

      {['BUZZER','WAGER'].includes(blockForm.type) && <p className="muted type-note">
        {blockMeta(blockForm.type).label} content is authored and presented on the Big Screen, but has no phone-side flow yet — run it out loud and score with group or coin adjustments.
      </p>}
      {blockForm.type === 'DUOLINGO_QUESTION' && <div className="duo-editor">
        <div className="form-grid">
          {QUESTION_EMOJIS.map((emoji, index) => <label key={emoji}>{emoji} Answer {index + 1}<input className="field" value={blockForm.answers[index]} onChange={e => { const answers = [...blockForm.answers]; answers[index] = e.target.value; setBlockForm({ ...blockForm, answers }); }} /></label>)}
          <label>Correct answer<select className="field" value={blockForm.correctAnswerIndex} onChange={e => setBlockForm({ ...blockForm, correctAnswerIndex: Number(e.target.value) })}>{QUESTION_EMOJIS.map((emoji, i) => <option key={emoji} value={i}>{emoji} Answer {i + 1}</option>)}</select></label>
          <label>Reward coins<input className="field" type="number" min="0" value={blockForm.rewardCoins} onChange={e => setBlockForm({ ...blockForm, rewardCoins: e.target.value })} /></label>
        </div>
      </div>}
      <div className="actions"><button className="btn btn-primary" onClick={submitBlock}>{edit ? 'SAVE BLOCK' : 'ADD BLOCK'}</button>{edit && <button className="btn btn-secondary" onClick={resetBlock}>CANCEL</button>}</div>
    </Card>}

    {blocks.length === 0 ? <Empty title="No round content yet — Add the first block" /> : <div className="card-list block-list">
      {blocks.map((block: any, index: number) => <Card key={block.id} className={`round-block-card accent-${blockMeta(block.type).accent} ${s.game.current_round_block_id === block.id ? 'live-card' : ''}`}>
        <div className="row-between"><div><div className="label muted">{String(index + 1).padStart(2, '0')} · {blockMeta(block.type).label}</div><div className="display row-title">{blockLabel(block)}</div>{block.payload?.body && <p className="muted block-copy">{block.payload.body}</p>}{block.type === 'DUOLINGO_QUESTION' && <div className="duo-block-summary"><Status tone={block.interactive_status === 'OPEN' ? 'open' : block.interactive_status === 'SETTLED' ? 'success' : 'neutral'}>{block.interactive_status}</Status><span>{block.answer_count} answers</span><span>{block.payload.rewardCoins} coin reward</span></div>}</div>{s.game.current_round_block_id === block.id && <Status tone="open">LIVE</Status>}</div>
        {!readOnlyContent && <div className="actions actions-compact"><button className="btn btn-secondary btn-compact" disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button className="btn btn-secondary btn-compact" disabled={index === blocks.length - 1} onClick={() => move(index, 1)}>↓</button><button className="btn btn-secondary btn-compact" onClick={() => beginEdit(block)}>EDIT</button>{round.status === 'ACTIVE' && <button className="btn btn-primary btn-compact" onClick={() => show(block)}>SHOW</button>}<button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-round-block', { blockId: block.id })}>DELETE</button></div>}
        {block.type === 'PICTURE' && block.payload?.imageKey && <img className="block-thumb" src={`/api/block-media?key=${encodeURIComponent(block.payload.imageKey)}`} alt="" />}
        {block.type === 'MUSIC' && block.payload?.audioKey && <div className="media-audio"><audio controls preload="none" src={`/api/block-media?key=${encodeURIComponent(block.payload.audioKey)}`} /><span className="muted">{block.payload.audioName || 'Audio'}</span></div>}
        {block.type === 'WAGER' && block.payload?.correctAnswer && <p className="muted block-copy">Correct answer: <b>{block.payload.correctAnswer}</b></p>}
        {block.type === 'FOTORONDE' && <p className="muted block-copy">
          {(block.payload?.subjects?.length ?? 6)} foto-opdrachten · teams uploaden vanaf hun telefoon · run it from the Control Center
        </p>}
        {block.type === 'PAK_EEN_ZES' && <p className="muted block-copy">
          Predict four names, then draw cards until all four sixes are out · run it from the Control Center
        </p>}
        {block.type === 'SLOTMACHINE' && <p className="muted block-copy">
          Max {block.payload?.maxSpins ?? 10} spins per series · {(block.payload?.allowedPlayerIds || []).length === 0 ? 'everyone plays' : `${block.payload.allowedPlayerIds.length} selected player${block.payload.allowedPlayerIds.length === 1 ? '' : 's'}`}
          {s.slotConfig && !s.slotConfig.status.valid && <> · <b className="neg">machine not configured</b></>}
        </p>}

        {/* Picture and music titles are the answer, so they are withheld from the
            projector until the host reveals them. */}
        {['PICTURE','MUSIC','BUZZER','WAGER'].includes(block.type) && round.status === 'ACTIVE' && s.game.current_round_block_id === block.id && <div className="interactive-controls">
          {block.interactive_status === 'REVEALED'
            ? <button className="btn btn-secondary" onClick={() => run('/api/reveal-block', { blockId: block.id, revealed: false })}>HIDE ANSWER AGAIN</button>
            : <button className="btn btn-success" onClick={() => run('/api/reveal-block', { blockId: block.id, revealed: true })}>REVEAL ANSWER</button>}
        </div>}

        {block.type === 'DUOLINGO_QUESTION' && round.status === 'ACTIVE' && s.game.current_round_block_id === block.id && <div className="interactive-controls">
          {block.interactive_status === 'READY' && <button className="btn btn-primary" onClick={() => questionAction(block, 'OPEN')}>OPEN ANSWERS</button>}
          {block.interactive_status === 'OPEN' && <button className="btn btn-secondary" onClick={() => questionAction(block, 'CLOSE')}>CLOSE ANSWERS</button>}
          {block.interactive_status === 'CLOSED' && <button className="btn btn-primary" onClick={() => questionAction(block, 'REVEAL')}>REVEAL + REWARD</button>}
          {block.interactive_status === 'REVEALED' && <button className="btn btn-primary" onClick={() => questionAction(block, 'SETTLE')}>MARK SETTLED</button>}
        </div>}
      </Card>)}
    </div>}

    <RoundGroups state={s} round={round} run={run} groupName={groupName} setGroupName={setGroupName} />
  </div>;
}

/**
 * Whether the shared machine is usable, shown where the block is authored.
 *
 * Without this the Admin can build a perfectly good slot block, go live on it, and only
 * then discover the distribution does not add up — the block is only half the setup.
 */
function SlotConfigNotice({ state: s, gameId }: { state: any; gameId: number }) {
  const nav = useNavigate();
  const status = s.slotConfig?.status;
  if (!status) return null;
  return <div className={`slot-config-notice ${status.valid ? 'is-valid' : 'is-invalid'}`}>
    <div>
      <b>{status.valid ? 'Slotmachine is configured' : 'Slotmachine needs setup'}</b>
      <span className="muted">{status.reason} {status.symbolCount} of 36 symbols uploaded.</span>
    </div>
    <button className="btn btn-secondary btn-compact" onClick={() => nav(`/admin/${gameId}/settings`)}>OPEN SETTINGS</button>
  </div>;
}

function RoundGroups({ state: s, round, run, groupName, setGroupName }: { state: any; round: any; run: RunMutation; groupName: string; setGroupName: (value: string) => void }) {
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
            <div className="label muted">GROUP COIN ADJUSTMENT · ATTRIBUTED TO R{String(round.round_number).padStart(2, '0')}</div>
            <div className="compact-adjust-grid"><input className="field" type="number" placeholder="+20 or -10" value={adjustment.amount} onChange={e => setAdjustments({ ...adjustments, [group.id]: { ...adjustment, amount: e.target.value } })} /><input className="field" placeholder="Mandatory reason" value={adjustment.reason} onChange={e => setAdjustments({ ...adjustments, [group.id]: { ...adjustment, reason: e.target.value } })} /><button className="btn btn-primary btn-compact" disabled={savingGroupId === group.id || !adjustment.amount || Number(adjustment.amount) === 0 || !adjustment.reason.trim()} onClick={async () => { if (savingGroupId !== null) return; setSavingGroupId(group.id); try { if (await run('/api/adjust-group-coins', { groupId: group.id, amount: Number(adjustment.amount), reason: adjustment.reason }, true, adjustment.idempotencyKey)) setAdjustments({ ...adjustments, [group.id]: { amount: '', reason: '', idempotencyKey: crypto.randomUUID() } }); } finally { setSavingGroupId(null); } }}>{savingGroupId === group.id ? 'SAVING…' : 'SAVE'}</button></div>
          </div> : <p className="muted group-scoring-note">Coin scoring becomes available when this round starts.</p>}
        </div>;
      })}
    </div>}
  </Card>;
}
