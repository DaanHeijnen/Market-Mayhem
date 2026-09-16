import { useEffect, useState } from 'react';
import type { RunMutation } from '../types';
import { Card } from '../ui';
import { SlotMachineSettings } from './SlotMachineSettings';

export function SettingsPage({ state: s, gameId, run, onReset }: { state: any; gameId: number; run: RunMutation; onReset: () => void }) {
  const g = s.game;
  const [form, setForm] = useState<any>({});
  const [detail, setDetail] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [resetDetail, setResetDetail] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');

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

    <SlotMachineSettings state={s} gameId={gameId} run={run} />

    {/* Full Reset comes before Delete Game Save because it is the one a host actually
        reaches for: it exists so the evening can be tested end to end and then played for
        real, without rebuilding a single round. Both halves are spelled out, since the
        half that survives is the reason to use it. */}
    <Card className="reset-card danger-inline">
      <div className="label reset-text">RESET AVOND</div>
      <h2 className="display">Full Reset</h2>
      <p className="muted">Wipes everything the test run produced and leaves the prepared evening exactly as you built it. Use this once you have tested the night and want to play it for real. The player list goes back to the ten standard players on 100 coins each.</p>
      <button className="text-button reset-detail-toggle" onClick={() => setResetDetail(x => !x)}>{resetDetail ? 'Hide what is reset and what is kept' : 'Show what is reset and what is kept'}</button>
      {resetDetail && <div className="reset-columns">
        <div>
          <div className="label reset-text">RESET</div>
          <ul className="danger-list">
            <li>the ten standard players back on their starting coins</li>
            <li>every player you added by hand during the test run</li>
            <li>the entire ledger and every deposit, payout and refund</li>
            <li>prediction deposits, results and participation</li>
            <li>roulette games, bets and spins</li>
            <li>slotmachine series and spins</li>
            <li>Pak een Zes predictions, draws and scoring</li>
            <li>Fotoronde photos and awarded credits</li>
            <li>live-question answers and rewards</li>
            <li>every round back to upcoming, with no round or step live</li>
            <li>the Big Screen back to the dashboard</li>
          </ul>
        </div>
        <div>
          <div className="label reset-keeps">KEPT</div>
          <ul className="danger-list">
            <li>all rounds, their order and their titles</li>
            <li>every round step, in order, with its content and settings</li>
            <li>predictions with their probability and payout settings</li>
            <li>slotmachine symbols, chances and payouts</li>
            <li>Pak een Zes, Fotoronde and roulette configuration</li>
            <li>teams and who is in them</li>
            <li>the ten standard players, with their join links and sessions</li>
            <li>the game settings on this page</li>
          </ul>
        </div>
      </div>}
      <p>Type exactly <b>RESET AVOND</b> to confirm.</p>
      <input className="field" value={resetPhrase} onChange={e => setResetPhrase(e.target.value)} placeholder="RESET AVOND" />
      <button className="btn btn-reset btn-danger-large" disabled={resetPhrase.trim() !== 'RESET AVOND'} onClick={async () => { if (await run('/api/full-reset-game', { confirmation: resetPhrase.trim() })) { setResetPhrase(''); onReset(); } }}>RESET AVOND</button>
    </Card>

    {/* The typed phrase is the gate, exactly as the design has it — the button stays
        dead until it matches, so the confirmation is the input rather than a first click.
        What gets removed is listed because it is not recoverable. */}
    <Card className="danger-card danger-inline">
      <div className="label danger-text">DANGER ZONE</div>
      <h2 className="display">Delete Game Save</h2>
      <p className="muted">Permanently resets only this game night — players, rounds, predictions, roulette and ledger history. Unlike Full Reset above, this also removes the evening you prepared: rounds, steps and their content are gone for good. Your Admin login remains available.</p>
      <button className="text-button danger-detail-toggle" onClick={() => setDetail(x => !x)}>{detail ? 'Hide exactly what is removed' : 'Show exactly what is removed'}</button>
      {detail && <ul className="danger-list">
        <li>players, join tokens and player sessions</li>
        <li>wallets and immutable ledger entries</li>
        <li>rounds, groups, memberships and round content</li>
        <li>live-question answers and reward state</li>
        <li>predictions, deposits and payouts</li>
        <li>roulette games and bets</li>
        <li>slotmachine symbols, odds, series and spins</li>
        <li>Pak een Zes predictions, draws and scoring</li>
        <li>Fotoronde photos, judgements and credits</li>
        <li>screen state and game settings</li>
      </ul>}
      <p className="muted">The ten standard players are created again afterwards, each on 100 coins. Everything else on the list is gone for good.</p>
      <p>Type exactly <b>yes delete</b> to confirm.</p>
      <input className="field" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="yes delete" />
      <button className="btn btn-danger btn-danger-large" disabled={phrase.trim() !== 'yes delete'} onClick={async () => { if (await run('/api/reset-game', { confirmation: phrase.trim() })) { setPhrase(''); onReset(); } }}>DELETE GAME SAVE</button>
    </Card>
  </div>;
}
