import { useEffect, useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Status } from '../ui';

/**
 * Pak een Zes scoring: one game-wide amount per correct prediction.
 *
 * Deliberately a single number rather than a rate per player, per six or per prediction
 * slot — every correct prediction is worth the same. The players' phones show this exact
 * value while they are predicting, so they know what a correct pick is worth before they
 * commit to one.
 */
export function PakEenZesSettings({ state: s, run }: { state: any; run: RunMutation }) {
  const stored = Number(s.game?.pak_een_zes_points_per_correct ?? 0);
  const [points, setPoints] = useState<string>(String(stored));
  useEffect(() => { setPoints(String(stored)); }, [stored]);

  const value = Number(points);
  const valid = Number.isInteger(value) && value >= 0;
  const dirty = String(stored) !== points;

  return <Card>
    <div className="section-heading">
      <div>
        <div className="label muted">PAK EEN ZES · SCORING</div>
        <h2 className="display">Punten per juiste voorspelling</h2>
      </div>
      <Status tone={value > 0 ? 'success' : 'neutral'}>{value > 0 ? `${value} PUNTEN` : 'GEEN PUNTEN'}</Status>
    </div>
    <p className="muted">
      Every correct prediction is worth this many points. A player who named the same person twice and saw them draw
      two sixes scores twice — so with {valid ? value : 0} points each, three correct predictions pay{' '}
      <b>{valid ? value * 3 : 0}</b>. Players see this amount on their phones before they predict.
    </p>

    <div className="form-grid compact">
      <label>Punten per juiste voorspelling<input className="field" type="number" min="0" value={points} onChange={e => setPoints(e.target.value)} /></label>
    </div>

    <button
      className="btn btn-primary"
      disabled={!dirty || !valid}
      onClick={() => run('/api/update-pak-een-zes-settings', { pointsPerCorrect: value })}
    >SAVE SCORING</button>
    <p className="muted microcopy">
      Changing this never rewrites a game that already paid out — a finished Pak een Zes keeps the rate it was scored
      at. Zero is allowed, if the prediction is for pride alone.
    </p>
  </Card>;
}
