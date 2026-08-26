import { useEffect, useState } from 'react';
import type { RunMutation } from '../types';
import { Card } from '../ui';

export function SettingsPage({ state: s, run, onReset }: { state: any; run: RunMutation; onReset: () => void }) {
  const g = s.game;
  const [form, setForm] = useState<any>({});
  const [detail, setDetail] = useState(false);
  const [phrase, setPhrase] = useState('');

  useEffect(() => setForm({
    name: g.name,
    startingBalance: g.starting_balance,
    maximumWalletPercentage: g.maximum_wallet_percentage ?? '',
  }), [g.name, g.starting_balance, g.maximum_wallet_percentage]);

  const field = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });

  return <div className="page-stack">
    <Card>
      <div className="section-heading"><div><div className="label muted">GAME SETTINGS</div><h2 className="display">Core game defaults</h2></div></div>
      <div className="form-grid">
        <label>Game name<input className="field" value={form.name || ''} onChange={field('name')} /></label>
        <label>Starting coins for new players<input className="field" type="number" min="0" value={form.startingBalance ?? ''} onChange={field('startingBalance')} /></label>
        <label>Max wallet % per prediction <span className="muted">(optional)</span><input className="field" type="number" min="1" max="100" placeholder="No percentage cap" value={form.maximumWalletPercentage ?? ''} onChange={field('maximumWalletPercentage')} /></label>
      </div>
      <p className="muted">Starting coins only affect players created after you save. Prediction duration and min/max deposits are configured per prediction market.</p>
      <button className="btn btn-primary" onClick={() => run('/api/update-settings', { ...form, maximumWalletPercentage: form.maximumWalletPercentage === '' ? null : Number(form.maximumWalletPercentage) })}>SAVE SETTINGS</button>
    </Card>

    {/* The typed phrase is the gate, exactly as the design has it — the button stays
        dead until it matches, so the confirmation is the input rather than a first click.
        What gets removed is listed because it is not recoverable. */}
    <Card className="danger-card danger-inline">
      <div className="label danger-text">DANGER ZONE</div>
      <h2 className="display">Delete Game Save</h2>
      <p className="muted">Permanently resets only this game night — players, rounds, predictions, roulette and ledger history. Your Admin login remains available.</p>
      <button className="text-button danger-detail-toggle" onClick={() => setDetail(x => !x)}>{detail ? 'Hide exactly what is removed' : 'Show exactly what is removed'}</button>
      {detail && <ul className="danger-list">
        <li>players, join tokens and player sessions</li>
        <li>wallets and immutable ledger entries</li>
        <li>rounds, groups, memberships and round content</li>
        <li>live-question answers and reward state</li>
        <li>predictions, deposits and payouts</li>
        <li>roulette games and bets</li>
        <li>screen state and game settings</li>
      </ul>}
      <p>Type exactly <b>yes delete</b> to confirm.</p>
      <input className="field" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="yes delete" />
      <button className="btn btn-danger btn-danger-large" disabled={phrase.trim() !== 'yes delete'} onClick={async () => { if (await run('/api/reset-game', { confirmation: phrase.trim() })) { setPhrase(''); onReset(); } }}>DELETE GAME SAVE</button>
    </Card>
  </div>;
}
