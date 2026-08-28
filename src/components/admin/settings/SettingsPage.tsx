import { useEffect, useState } from 'react';
import type { RunMutation } from '../types';
import { Card } from '../ui';
import { SlotMachineSettings } from './SlotMachineSettings';

export function SettingsPage({ state: s, run, onReset }: { state: any; run: RunMutation; onReset: () => void }) {
  const g = s.game;
  const [form, setForm] = useState<any>({});
  const [danger, setDanger] = useState(false);
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

    <SlotMachineSettings gameId={Number(g.id)} state={s} run={run} />

    <Card className="danger-card">
      <div className="label danger-text">DANGER ZONE</div>
      <h2 className="display">Delete Game Save</h2>
      <p className="muted">Permanently reset only this game night. Your Admin login remains available.</p>
      <button className="btn btn-danger btn-danger-large" onClick={() => { setPhrase(''); setDanger(true); }}>DELETE GAME SAVE</button>
    </Card>

    {danger && <div className="modal-backdrop"><div className="modal card">
      <div className="label danger-text">PERMANENT RESET</div>
      <h2 className="display">Delete this game save?</h2>
      <p>The following game-specific data will be removed:</p>
      <ul className="danger-list">
        <li>players, join tokens and player sessions</li>
        <li>wallets and immutable ledger entries</li>
        <li>rounds, groups, memberships and round content</li>
        <li>live-question answers and reward state</li>
        <li>predictions, deposits and payouts</li>
        <li>roulette games and bets</li>
        <li>slot reel symbols, outcome distribution and spin series</li>
        <li>screen state and game settings</li>
      </ul>
      <p>Type exactly <b>yes delete</b> to continue.</p>
      <input autoFocus className="field" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="yes delete" />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={() => setDanger(false)}>CANCEL</button>
        <button className="btn btn-danger" disabled={phrase !== 'yes delete'} onClick={async () => { if (await run('/api/reset-game', { confirmation: phrase })) { setDanger(false); onReset(); } }}>DELETE EVERYTHING</button>
      </div>
    </div></div>}
  </div>;
}
