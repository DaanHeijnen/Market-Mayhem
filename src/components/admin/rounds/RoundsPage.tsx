import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Card, Empty, Status } from '../ui';
import { ROUND_TYPES, describeContent, roundMeta } from '../roundMeta';
import { QuizEditor } from './QuizEditor';
import { PresentationEditor } from './PresentationEditor';
import { PubquizEditor } from './PubquizEditor';
import { FotorondeEditor } from './FotorondeEditor';
import { SlotmachineEditor } from './SlotmachineEditor';
import { RoundGroups } from './RoundGroups';

/**
 * Rounds management.
 *
 * A round is one segment of the evening and has exactly one type, chosen when it is
 * created. That choice decides which editor opens afterwards — there is no shared
 * "content block" form any more, because a quiz question and a Fotoronde subject never
 * had the same fields and pretending otherwise produced one form with fourteen.
 */
export function RoundsPage({ state: s, gameId, roundId, run }: { state: any; gameId: number; roundId: number | null; run: RunMutation }) {
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const round = useMemo(() => s.rounds.find((r: any) => r.id === roundId) || null, [s.rounds, roundId]);

  if (round) return <RoundDetail state={s} round={round} gameId={gameId} run={run} back={() => nav(`/admin/${gameId}/rounds`)} />;

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...s.rounds];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await run('/api/reorder-rounds', { roundIds: next.map((r: any) => r.id) });
  };

  return <div className="page-stack">
    <div className="explainer">
      A round is one segment of the night. Pick what kind of round it is when you create it — the editor that opens
      afterwards is the one that belongs to that kind.
    </div>

    {!creating
      ? <div className="row-end"><button className="btn btn-primary" onClick={() => setCreating(true)}>+ NEW ROUND</button></div>
      : <CreateRound gameId={gameId} run={run} onDone={() => setCreating(false)} />}

    {s.rounds.length === 0 ? <Empty title="No rounds yet — Create your first round" /> : <div className="card-list round-list">
      {s.rounds.map((item: any, index: number) => {
        const meta = roundMeta(item.type);
        return <Card key={item.id} className={`round-card accent-${meta.accent} round-${String(item.status).toLowerCase()}`}>
          <div className="row-between">
            <div>
              <div className="label muted">ROUND {String(item.sortOrder).padStart(2, '0')} · {meta.label.toUpperCase()}</div>
              <div className="display row-title">{item.title}</div>
              <div className="muted">{describeContent(item)} · {item.groups.length} group{item.groups.length === 1 ? '' : 's'}</div>
            </div>
            <Status tone={item.status === 'ACTIVE' ? 'open' : item.status === 'COMPLETED' ? 'success' : 'neutral'}>{item.status}</Status>
          </div>

          {editing?.id === item.id
            ? <EditRound round={editing} setRound={setEditing} run={run} onDone={() => setEditing(null)} />
            : <div className="actions actions-compact">
              <button className="btn btn-secondary btn-compact" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button className="btn btn-secondary btn-compact" disabled={index === s.rounds.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button className="btn btn-secondary btn-compact" onClick={() => nav(`/admin/${gameId}/rounds/${item.id}`)}>
                {item.status === 'COMPLETED' ? 'INSPECT' : 'OPEN'}
              </button>
              {item.status !== 'COMPLETED' && <button className="btn btn-secondary btn-compact" onClick={() => setEditing({ ...item })}>EDIT</button>}
              {item.status === 'UPCOMING' && <>
                <button className="btn btn-primary btn-compact" onClick={() => run('/api/start-round', { roundId: item.id })}>START</button>
                <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-round', { roundId: item.id })}>DELETE</button>
              </>}
              {item.status === 'ACTIVE' && <button className="btn btn-primary btn-compact" onClick={() => run('/api/complete-round', { roundId: item.id })}>COMPLETE</button>}
            </div>}
        </Card>;
      })}
    </div>}
  </div>;
}

/**
 * Create a round.
 *
 * The type comes first and is not editable afterwards: content authored under one type
 * has nowhere to go under another, so changing it would mean quietly discarding work.
 */
function CreateRound({ gameId, run, onDone }: { gameId: number; run: RunMutation; onDone: () => void }) {
  const [form, setForm] = useState({ type: '', title: '', description: '', instructions: '', defaultPoints: '10', maxSpins: '10' });
  const meta = form.type ? roundMeta(form.type) : null;

  return <Card>
    <div className="label muted">CREATE ROUND — WHAT KIND OF ROUND IS THIS?</div>
    <div className="round-type-grid">
      {ROUND_TYPES.map(type => {
        const m = roundMeta(type);
        return <button
          key={type}
          className={`round-type-tile accent-${m.accent} ${form.type === type ? 'selected' : ''}`}
          aria-pressed={form.type === type}
          onClick={() => setForm({ ...form, type })}
        >
          <span className="accent-swatch" />
          <b>{m.label}</b>
          <span>{m.description}</span>
        </button>;
      })}
    </div>

    {meta && <>
      <div className="form-grid compact">
        <label className="span-2">Round title<input className="field" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
      </div>
      <label>Description — your own note, never shown to players
        <textarea className="field" rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
      </label>
      {meta.interactive && <label>Instructions shown on the players’ phones
        <textarea className="field" rows={2} value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} />
      </label>}

      <div className="form-grid compact">
        <label>
          {form.type === 'LIVE_QUIZ' || form.type === 'PUBQUIZ' ? 'Default points per question'
            : form.type === 'FOTORONDE' ? 'Default credits per subject'
              : form.type === 'PAK_EEN_ZES' ? 'Points per correct prediction'
                : 'Default points'}
          <input className="field" type="number" min="0" value={form.defaultPoints} onChange={e => setForm({ ...form, defaultPoints: e.target.value })} />
        </label>
        {form.type === 'SLOTMACHINE' && <label>Maximum spins per series
          <input className="field" type="number" min="1" max="10" value={form.maxSpins} onChange={e => setForm({ ...form, maxSpins: e.target.value })} />
        </label>}
      </div>
      <p className="muted type-note">
        {form.type === 'LIVE_QUIZ' && 'New questions start at this value; every question can override it.'}
        {form.type === 'PUBQUIZ' && 'New questions start at this value; every question can override it. A right answer pays it, a wrong one pays nothing.'}
        {form.type === 'FOTORONDE' && 'New subjects start at this value; every subject can override it, and you can still award any amount while judging.'}
        {form.type === 'PAK_EEN_ZES' && 'Every correct prediction is worth this much. The rate is snapshotted when the game finishes, so changing it later never rewrites history.'}
        {form.type === 'PRESENTATIE' && 'A presentation round does not score, so this value is unused.'}
        {form.type === 'ROULETTE' && 'Roulette pays from the bet type itself, so this value is unused.'}
        {form.type === 'SLOTMACHINE' && 'The reel artwork and the odds are one machine shared by the whole night and live in Settings.'}
      </p>
    </>}

    <div className="actions">
      <button
        className="btn btn-primary"
        disabled={!form.type || !form.title.trim()}
        onClick={async () => {
          const ok = await run('/api/create-round', {
            type: form.type,
            title: form.title,
            description: form.description,
            instructions: form.instructions,
            defaultPoints: Number(form.defaultPoints) || 0,
            ...(form.type === 'SLOTMACHINE' ? { maxSpins: Number(form.maxSpins) || 10 } : {}),
          });
          if (ok) onDone();
        }}
      >CREATE ROUND</button>
      <button className="btn btn-secondary" onClick={onDone}>CANCEL</button>
    </div>
  </Card>;
}

function EditRound({ round, setRound, run, onDone }: { round: any; setRound: (r: any) => void; run: RunMutation; onDone: () => void }) {
  const meta = roundMeta(round.type);
  return <div className="compact-edit-row multi">
    <input className="field" value={round.title} onChange={e => setRound({ ...round, title: e.target.value })} />
    <textarea className="field" placeholder="Description" value={round.description || ''} onChange={e => setRound({ ...round, description: e.target.value })} />
    {meta.interactive && <textarea className="field" placeholder="Phone instructions" value={round.instructions || ''} onChange={e => setRound({ ...round, instructions: e.target.value })} />}
    <input className="field" type="number" min="0" value={round.defaultPoints} onChange={e => setRound({ ...round, defaultPoints: Number(e.target.value) })} />
    <button className="btn btn-primary btn-compact" onClick={async () => {
      const ok = await run('/api/edit-round', {
        roundId: round.id,
        title: round.title,
        description: round.description || '',
        instructions: round.instructions || '',
        defaultPoints: round.defaultPoints,
      });
      if (ok) onDone();
    }}>SAVE</button>
    <button className="btn btn-secondary btn-compact" onClick={onDone}>CANCEL</button>
  </div>;
}

/** The round's own page: its header, then the editor that belongs to its type. */
function RoundDetail({ state: s, round, gameId, run, back }: { state: any; round: any; gameId: number; run: RunMutation; back: () => void }) {
  const meta = roundMeta(round.type);
  const readOnly = round.status === 'COMPLETED';

  return <div className="page-stack">
    <button className="btn btn-secondary back-btn" onClick={back}>← ALL ROUNDS</button>
    <Card className={`accent-${meta.accent}`}>
      <div className="row-between">
        <div>
          <div className="label muted">ROUND {String(round.sortOrder).padStart(2, '0')} · {meta.label.toUpperCase()}</div>
          <h2 className="display page-card-title">{round.title}</h2>
          <p className="muted">{round.description || meta.description}</p>
        </div>
        <Status tone={round.status === 'ACTIVE' ? 'open' : round.status === 'COMPLETED' ? 'success' : 'neutral'}>{round.status}</Status>
      </div>
    </Card>

    {round.type === 'LIVE_QUIZ' && <QuizEditor round={round} gameId={gameId} run={run} readOnly={readOnly} />}
    {round.type === 'PRESENTATIE' && <PresentationEditor state={s} round={round} gameId={gameId} run={run} readOnly={readOnly} />}
    {round.type === 'PUBQUIZ' && <PubquizEditor state={s} round={round} gameId={gameId} run={run} readOnly={readOnly} />}
    {round.type === 'FOTORONDE' && <FotorondeEditor round={round} gameId={gameId} run={run} readOnly={readOnly} />}
    {round.type === 'SLOTMACHINE' && <SlotmachineEditor state={s} round={round} gameId={gameId} run={run} readOnly={readOnly} />}
    {round.type === 'ROULETTE' && <Card>
      <div className="label muted">ROULETTE</div>
      <p className="muted">
        Nothing to author: the wheel, the bet types and their payouts are the game itself. Players place chips from
        their phones once you open the table from the Control Center.
      </p>
    </Card>}
    {round.type === 'PAK_EEN_ZES' && <Card>
      <div className="label muted">PAK EEN ZES</div>
      <p className="muted">
        Nothing to author: the deck is a fixed 52 cards, the game ends when all four sixes are out, and every active
        player takes a turn. Each correct prediction is worth <b>{round.defaultPoints}</b> — change that with EDIT on
        the round list. You open the predictions, close them and start the game from the Control Center.
      </p>
      <p className="muted microcopy">
        A player who named the same person twice and saw them draw two sixes scores twice, so three correct
        predictions pay <b>{round.defaultPoints * 3}</b>. The rate is snapshotted when the game finishes, so changing
        it afterwards never rewrites history. Zero is allowed, if the prediction is for pride alone.
      </p>
    </Card>}

    <RoundGroups state={s} round={round} run={run} />
  </div>;
}
