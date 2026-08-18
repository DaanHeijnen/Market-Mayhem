import { useMemo, useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Countdown, Empty, Status } from '../ui';

const initialForm = { question: '', roundId: '', probabilityPercent: 50, predictionTimeSeconds: 90, minimumStake: 5, maximumStake: 500, scheduled: false };

function multiplier(probabilityPercent: number, yes: boolean) {
  const p = probabilityPercent / 100;
  return 1 / (yes ? p : 1 - p);
}

function visibleStatus(prediction: any) {
  if (prediction.status === 'SETTLED' && prediction.result === 'YES') return 'RESOLVED YES';
  if (prediction.status === 'SETTLED' && prediction.result === 'NO') return 'RESOLVED NO';
  return prediction.status;
}

export function PredictionsPage({ state: s, run }: { state: any; run: RunMutation }) {
  const [form, setForm] = useState<any>(initialForm);
  const [editing, setEditing] = useState<number | null>(null);
  const yesMultiplier = useMemo(() => multiplier(Number(form.probabilityPercent), true), [form.probabilityPercent]);
  const noMultiplier = useMemo(() => multiplier(Number(form.probabilityPercent), false), [form.probabilityPercent]);

  const save = async () => {
    const path = editing ? '/api/edit-prediction' : '/api/create-prediction';
    const payload = {
      ...(editing ? { predictionId: editing } : {}),
      question: form.question,
      roundId: form.roundId ? Number(form.roundId) : null,
      probabilityPercent: Number(form.probabilityPercent),
      predictionTimeSeconds: Number(form.predictionTimeSeconds),
      minimumStake: Number(form.minimumStake),
      maximumStake: Number(form.maximumStake),
      scheduled: Boolean(form.scheduled),
    };
    if (await run(path, payload)) { setForm(initialForm); setEditing(null); }
  };

  const begin = (prediction: any) => {
    setEditing(prediction.id);
    setForm({
      question: prediction.question,
      roundId: prediction.round_id || '',
      probabilityPercent: Math.round(Number(prediction.probability_yes) * 100),
      predictionTimeSeconds: prediction.prediction_time_seconds,
      minimumStake: prediction.minimum_stake,
      maximumStake: prediction.maximum_stake,
      scheduled: prediction.status === 'SCHEDULED',
    });
  };

  const showPrediction = (prediction: any) => {
    const mode = prediction.status === 'OPEN' ? 'PREDICTIONS_OPEN' : ['RESULT','SETTLED'].includes(prediction.status) ? 'PREDICTION_RESULT' : 'PREDICTION_LOCKED';
    return run('/api/screen-mode', { mode, predictionId: prediction.id });
  };

  const canSave = form.question.trim() && Number(form.minimumStake) > 0 && Number(form.maximumStake) >= Number(form.minimumStake) && Number(form.predictionTimeSeconds) >= 5;

  return <div className="page-stack">
    <Card>
      <div className="label muted">{editing ? 'EDIT MARKET' : 'CREATE MARKET'}</div>
      <h2 className="display">Admin-set probability</h2>
      <div className="form-grid">
        <label className="span-2">Question<input className="field" value={form.question} onChange={e => setForm({ ...form, question: e.target.value })} /></label>
        <label>Linked round<select className="field" value={form.roundId} onChange={e => {
          const id = e.target.value;
          const round = s.rounds.find((item: any) => item.id === Number(id));
          setForm({ ...form, roundId: id, scheduled: Boolean(id) && round?.status === 'UPCOMING' ? form.scheduled : false });
        }}><option value="">No round</option>{s.rounds.filter((r: any) => r.status !== 'COMPLETED').map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}</select></label>
        <label>Duration (seconds)<input className="field" type="number" min="5" max="86400" value={form.predictionTimeSeconds} onChange={e => setForm({ ...form, predictionTimeSeconds: e.target.value })} /></label>
        <label>Minimum deposit<input className="field" type="number" min="1" value={form.minimumStake} onChange={e => setForm({ ...form, minimumStake: e.target.value })} /></label>
        <label>Maximum deposit<input className="field" type="number" min="1" value={form.maximumStake} onChange={e => setForm({ ...form, maximumStake: e.target.value })} /></label>
      </div>
      <div className="probability-builder">
        <div className="row-between"><div><div className="label muted">YES PROBABILITY</div><div className="display probability-value">{form.probabilityPercent}%</div></div><div className="odds-preview"><div className="yes"><span>YES</span><b>{yesMultiplier.toFixed(2)}×</b></div><div className="no"><span>NO</span><b>{noMultiplier.toFixed(2)}×</b></div></div></div>
        <input className="probability-slider" type="range" min="1" max="99" value={form.probabilityPercent} onChange={e => setForm({ ...form, probabilityPercent: Number(e.target.value) })} />
        <div className="slider-edge-labels"><span>1% YES</span><span>99% YES</span></div>
      </div>
      <label className="check"><input type="checkbox" checked={form.scheduled} disabled={!form.roundId || s.rounds.find((r: any) => r.id === Number(form.roundId))?.status !== 'UPCOMING'} onChange={e => setForm({ ...form, scheduled: e.target.checked })} /> Scheduled — automatically open on the linked round</label>
      <div className="actions">
        <button className="btn btn-primary" disabled={!canSave} onClick={save}>{editing ? 'SAVE MARKET' : 'CREATE MARKET'}</button>
        {editing && <button className="btn btn-secondary" onClick={() => { setEditing(null); setForm(initialForm); }}>CANCEL</button>}
      </div>
    </Card>

    {s.predictions.length === 0 ? <Empty title="No predictions yet — Create a market" /> : <div className="card-list">
      {s.predictions.map((prediction: any) => <Card key={prediction.id} className={['SETTLED','CANCELLED'].includes(prediction.status) ? 'settled-admin-card' : ''}>
        <div className="row-between">
          <div><div className="label muted">PREDICTION #{prediction.display_number}{prediction.round_number ? ` · R${String(prediction.round_number).padStart(2, '0')}` : ''}</div><div className="display row-title">{prediction.question}</div></div>
          <Status tone={prediction.status === 'OPEN' ? 'open' : prediction.status === 'CANCELLED' ? 'danger' : prediction.status === 'SETTLED' ? 'success' : 'neutral'}>{visibleStatus(prediction)}</Status>
        </div>
        <div className="odds-row prediction-metrics">
          <div><span>PROBABILITY</span><b>{Math.round(prediction.probability_yes * 100)}%</b></div>
          <div className="yes"><span>YES</span><b>{prediction.yes_odds.toFixed(2)}×</b></div>
          <div className="no"><span>NO</span><b>{prediction.no_odds.toFixed(2)}×</b></div>
          <div><span>DEPOSIT LIMITS</span><b>{prediction.minimum_stake}–{prediction.maximum_stake}</b></div>
          <div><span>PARTICIPATION</span><b>{prediction.participation_count} / {s.players.filter((p: any) => p.active).length}</b></div>
          {prediction.status === 'OPEN' && <div><span>TIME</span><b><Countdown closesAt={prediction.closes_at} /></b></div>}
        </div>
        <div className="actions actions-compact">
          {['DRAFT','SCHEDULED'].includes(prediction.status) && (() => {
            const waitingForRound = prediction.round_id && s.game.current_round_id !== prediction.round_id;
            return <><button className="btn btn-secondary btn-compact" onClick={() => begin(prediction)}>EDIT</button><button className="btn btn-primary btn-compact" disabled={Boolean(waitingForRound)} title={waitingForRound ? 'This market opens automatically when its linked round starts.' : undefined} onClick={() => run('/api/open-prediction', { predictionId: prediction.id })}>{waitingForRound ? 'WAITING FOR ROUND' : 'OPEN NOW'}</button><button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-prediction', { predictionId: prediction.id })}>DELETE</button></>;
          })()}
          {['OPEN','LOCKED','RESULT','SETTLED'].includes(prediction.status) && <button className="btn btn-secondary btn-compact" onClick={() => showPrediction(prediction)}>SHOW PREDICTION</button>}
          {prediction.status === 'OPEN' && <button className="btn btn-secondary btn-compact" onClick={() => run('/api/lock-prediction', { predictionId: prediction.id })}>LOCK NOW</button>}
          {prediction.status === 'LOCKED' && <><button className="btn btn-success btn-compact" onClick={() => run('/api/set-prediction-result', { predictionId: prediction.id, result: 'YES' })}>RESULT YES</button><button className="btn btn-danger btn-compact" onClick={() => run('/api/set-prediction-result', { predictionId: prediction.id, result: 'NO' })}>RESULT NO</button></>}
          {prediction.status === 'RESULT' && <button className="btn btn-primary btn-compact" onClick={() => run('/api/settle-prediction', { predictionId: prediction.id }, true)}>SETTLE PAYOUTS</button>}
          {['DRAFT','SCHEDULED','OPEN','LOCKED'].includes(prediction.status) && <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/cancel-prediction', { predictionId: prediction.id }, true)}>CANCEL + REFUND</button>}
        </div>
      </Card>)}
    </div>}
  </div>;
}
