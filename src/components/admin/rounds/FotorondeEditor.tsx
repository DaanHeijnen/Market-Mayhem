import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Empty } from '../ui';
import { MediaField } from './MediaField';

/** Mirrors DEFAULT_PHOTO_SUBJECTS in netlify/lib/photo-round.ts. */
const STANDARD_SIX = [
  'Iets kunstigs',
  'Iets lelijks',
  'Iets moois',
  'Iets opwindends',
  'Iets wat met het geloof heeft te maken',
  'Iets kinderlijks',
];

/**
 * The FOTORONDE editor: the subjects every team photographs, each worth its own credits.
 *
 * A subject's key is derived once, when it is created, and never changes — that is what
 * keeps a renamed subject attached to the photos already filed under it. The editor
 * therefore lets the label be edited freely and never offers the key.
 */
export function FotorondeEditor({ round, gameId, run, readOnly }: { round: any; gameId: number; run: RunMutation; readOnly: boolean }) {
  const [form, setForm] = useState({ label: '', points: String(round.defaultPoints), referenceMediaKey: '' });
  const [editingId, setEditingId] = useState<number | null>(null);
  const subjects: any[] = round.subjects || [];
  const [minutes, setMinutes] = useState(String(round.fotoronde?.submissionDurationMinutes ?? 15));

  const reset = () => { setEditingId(null); setForm({ label: '', points: String(round.defaultPoints), referenceMediaKey: '' }); };

  const submit = async () => {
    const ok = await run('/api/upsert-fotoronde-subject', {
      roundId: round.id,
      subjectId: editingId,
      label: form.label,
      points: Number(form.points) || 0,
      referenceMediaKey: form.referenceMediaKey || null,
    });
    if (ok) reset();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...subjects];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await run('/api/reorder-fotoronde-subjects', { roundId: round.id, subjectIds: next.map((s: any) => s.id) });
  };

  const addStandardSix = async () => {
    for (const label of STANDARD_SIX) {
      await run('/api/upsert-fotoronde-subject', { roundId: round.id, label, points: round.defaultPoints });
    }
  };

  return <>
    {/* The round's own setting. It decides the length of the *next* window the host opens
        and never moves one that is already running — teams are photographing against that
        clock. */}
    <Card>
      <div className="label muted">FOTORONDE — THIS ROUND</div>
      <div className="form-grid compact">
        <label>Inzendtijd (minuten)
          <input
            className="field" type="number" min="1" max="240" disabled={readOnly}
            value={minutes} onChange={e => setMinutes(e.target.value)}
          />
        </label>
      </div>
      <p className="muted type-note">
        De klok begint pas wanneer je tijdens de ronde op OPEN INZENDEN klikt, en loopt daarna door
        op de servertijd — ook als niemand naar een scherm kijkt. Je kunt altijd eerder sluiten.
      </p>
      {!readOnly && <div className="actions">
        <button
          className="btn btn-primary btn-compact"
          onClick={() => run('/api/update-fotoronde-round', {
            roundId: round.id,
            submissionDurationMinutes: Number(minutes) || 15,
          })}
        >SAVE INZENDTIJD</button>
      </div>}
    </Card>

    {!readOnly && <Card>
      <div className="label muted">{editingId ? 'EDIT SUBJECT' : 'ADD A SUBJECT'}</div>
      <p className="muted type-note">
        Every team gets this same list and uploads one photo per subject. You award credits per photo once submissions
        are closed — the value below is what the award field starts at.
      </p>
      <div className="form-grid compact">
        <label className="span-2">Subject<input className="field" placeholder="Iets moois" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} /></label>
        <label>Credits<input className="field" type="number" min="0" value={form.points} onChange={e => setForm({ ...form, points: e.target.value })} /></label>
      </div>
      <MediaField
        kind="image" gameId={gameId} value={form.referenceMediaKey}
        label="Reference image (optional)"
        hint="Your own note about what you are looking for. Never sent to phones or the projector."
        onChange={({ key }) => setForm({ ...form, referenceMediaKey: key })}
      />
      <div className="actions">
        <button className="btn btn-primary" disabled={!form.label.trim()} onClick={submit}>{editingId ? 'SAVE SUBJECT' : 'ADD SUBJECT'}</button>
        {editingId && <button className="btn btn-secondary" onClick={reset}>CANCEL</button>}
        {!editingId && subjects.length === 0 && <button className="btn btn-secondary" onClick={addStandardSix}>ADD THE STANDARD SIX</button>}
      </div>
    </Card>}

    {subjects.length === 0
      ? <Empty title="No subjects yet — add one, or start from the standard six" />
      : <div className="card-list block-list">
        {subjects.map((subject: any, index: number) => <Card key={subject.id} className="round-block-card accent-cyan-deep">
          <div className="row-between">
            <div>
              <div className="label muted">{String(index + 1).padStart(2, '0')} · {subject.points} CREDIT{subject.points === 1 ? '' : 'S'}</div>
              <div className="display row-title">{subject.label}</div>
              <div className="muted">key: {subject.key}</div>
            </div>
          </div>
          {subject.referenceMediaKey && <img className="block-thumb" src={`/api/block-media?key=${encodeURIComponent(subject.referenceMediaKey)}`} alt="" />}
          {!readOnly && <div className="actions actions-compact">
            <button className="btn btn-secondary btn-compact" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button className="btn btn-secondary btn-compact" disabled={index === subjects.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button className="btn btn-secondary btn-compact" onClick={() => {
              setEditingId(subject.id);
              setForm({ label: subject.label, points: String(subject.points), referenceMediaKey: subject.referenceMediaKey || '' });
            }}>EDIT</button>
            <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-fotoronde-subject', { subjectId: subject.id })}>DELETE</button>
          </div>}
        </Card>)}
      </div>}
  </>;
}
