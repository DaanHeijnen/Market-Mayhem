import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Status } from '../ui';
import { api } from '../../../lib/api';
import {
  SLOT_COMBINATION_COUNT,
  SLOT_REELS,
  SLOT_SYMBOL_SLOT_COUNT,
  formatSlotPercentage,
  slotConfigurationSummary,
  slotOutcomeKey,
  slotOutcomeLabel,
  slotPositions,
  slotSymbolLetter,
  slotSymbolUrl,
} from '../../../lib/slot';

interface SlotSymbol { reel: number; position: number; checksum: string; byteSize: number; originalFilename: string | null }
interface SlotOutcome { reel1: number; reel2: number; reel3: number; weight: number; payoutMultiplier: number }
interface SlotConfig {
  settings: { totalProbabilityPool: number; maximumSpins: number; minimumStake: number; maximumStake: number };
  symbols: SlotSymbol[];
  outcomes: SlotOutcome[];
}

type Draft = { weight: string; payout: string };

const PAGE_SIZE = 48;
const SAVE_CHUNK = 400;
const ANY = 'any';

const toNumber = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; };

export function SlotMachineSettings({ gameId, state, run }: { gameId: number; state: any; run: RunMutation }) {
  const [config, setConfig] = useState<SlotConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState({ totalProbabilityPool: '100', maximumSpins: '20', minimumStake: '1', maximumStake: '500' });
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [filters, setFilters] = useState({ reel1: ANY, reel2: ANY, reel3: ANY, onlyConfigured: true });
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      const next = await api<SlotConfig>(`/api/slot-config?gameId=${gameId}`);
      setConfig(next);
      setRules({
        totalProbabilityPool: String(next.settings.totalProbabilityPool),
        maximumSpins: String(next.settings.maximumSpins),
        minimumStake: String(next.settings.minimumStake),
        maximumStake: String(next.settings.maximumStake),
      });
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load slot configuration');
    }
  }, [gameId]);

  useEffect(() => { void load(); }, [load]);

  const symbolIndex = useMemo(() => {
    const map = new Map<string, SlotSymbol>();
    (config?.symbols || []).forEach(symbol => map.set(`${symbol.reel}-${symbol.position}`, symbol));
    return map;
  }, [config?.symbols]);

  const outcomeIndex = useMemo(() => {
    const map = new Map<string, SlotOutcome>();
    (config?.outcomes || []).forEach(outcome => map.set(slotOutcomeKey(outcome.reel1, outcome.reel2, outcome.reel3), outcome));
    return map;
  }, [config?.outcomes]);

  const totalPool = toNumber(rules.totalProbabilityPool);
  const assignedWeight = useMemo(() => {
    let total = 0;
    outcomeIndex.forEach((outcome, key) => { if (!drafts.has(key)) total += outcome.weight; });
    drafts.forEach(draft => { total += toNumber(draft.weight); });
    return total;
  }, [outcomeIndex, drafts]);
  const summary = slotConfigurationSummary(totalPool, assignedWeight, symbolIndex.size);

  const rows = useMemo(() => {
    const reel1 = filters.reel1 === ANY ? slotPositions : [Number(filters.reel1)];
    const reel2 = filters.reel2 === ANY ? slotPositions : [Number(filters.reel2)];
    const reel3 = filters.reel3 === ANY ? slotPositions : [Number(filters.reel3)];
    const list: Array<{ key: string; reel1: number; reel2: number; reel3: number; weight: number; payout: number; dirty: boolean }> = [];
    for (const a of reel1) for (const b of reel2) for (const c of reel3) {
      const key = slotOutcomeKey(a, b, c);
      const stored = outcomeIndex.get(key);
      const draft = drafts.get(key);
      const weight = draft ? toNumber(draft.weight) : stored?.weight || 0;
      const payout = draft ? toNumber(draft.payout) : stored?.payoutMultiplier || 0;
      if (filters.onlyConfigured && weight === 0 && payout === 0 && !draft) continue;
      list.push({ key, reel1: a, reel2: b, reel3: c, weight, payout, dirty: Boolean(draft) });
    }
    return list;
  }, [filters, outcomeIndex, drafts]);

  useEffect(() => { setPage(0); }, [filters.reel1, filters.reel2, filters.reel3, filters.onlyConfigured]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  const readDraft = (key: string) => {
    const stored = outcomeIndex.get(key);
    return drafts.get(key) || { weight: String(stored?.weight ?? 0), payout: String(stored?.payoutMultiplier ?? 0) };
  };
  const setDraft = (key: string, patch: Partial<Draft>, base: Draft) => {
    setDrafts(current => { const next = new Map(current); next.set(key, { ...base, ...patch }); return next; });
  };

  const act = async (fn: () => Promise<boolean | void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const saveRules = () => act(async () => {
    const saved = await run('/api/update-slot-settings', {
      totalProbabilityPool: Number(rules.totalProbabilityPool),
      maximumSpins: Number(rules.maximumSpins),
      minimumStake: Number(rules.minimumStake),
      maximumStake: Number(rules.maximumStake),
    });
    if (saved) await load();
  });

  const saveOutcomes = () => act(async () => {
    const payload = Array.from(drafts.entries()).map(([key, draft]) => {
      const [reel1, reel2, reel3] = key.split('-').map(Number);
      return { reel1, reel2, reel3, weight: toNumber(draft.weight), payoutMultiplier: toNumber(draft.payout) };
    });
    if (payload.length === 0) return;
    for (let index = 0; index < payload.length; index += SAVE_CHUNK) {
      const saved = await run('/api/update-slot-outcomes', { outcomes: payload.slice(index, index + SAVE_CHUNK) });
      if (!saved) return;
    }
    setDrafts(new Map());
    await load();
  });

  const clearOutcomes = () => act(async () => {
    if (!window.confirm('Remove every configured outcome weight and payout?')) return;
    if (await run('/api/update-slot-outcomes', { clearAll: true })) { setDrafts(new Map()); await load(); }
  });

  const uploadSymbol = (reel: number, position: number, file: File) => act(async () => {
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read the selected file'));
      reader.readAsDataURL(file);
    });
    if (await run('/api/upload-slot-symbol', { reel, position, image, filename: file.name })) await load();
  });

  const deleteSymbol = (reel: number, position: number) => act(async () => {
    if (await run('/api/delete-slot-symbol', { reel, position })) await load();
  });

  const activeSession = state?.slot?.activeSession || null;

  return <>
    <Card>
      <div className="section-heading">
        <div><div className="label muted">SLOT MACHINE</div><h2 className="display">Rules and limits</h2></div>
        <Status tone={summary.tone}>{summary.headline}</Status>
      </div>
      <p className="muted">{summary.message} The slot machine refuses every spin until this configuration is valid.</p>
      {loadError && <p className="neg"><b>{loadError}</b></p>}
      <div className="form-grid">
        <label>Total probability pool<input className="field" type="number" min="1" value={rules.totalProbabilityPool} onChange={e => setRules({ ...rules, totalProbabilityPool: e.target.value })} /></label>
        <label>Maximum spins per series<input className="field" type="number" min="1" max="500" value={rules.maximumSpins} onChange={e => setRules({ ...rules, maximumSpins: e.target.value })} /></label>
        <label>Minimum stake per spin<input className="field" type="number" min="1" value={rules.minimumStake} onChange={e => setRules({ ...rules, minimumStake: e.target.value })} /></label>
        <label>Maximum stake per spin<input className="field" type="number" min="1" value={rules.maximumStake} onChange={e => setRules({ ...rules, maximumStake: e.target.value })} /></label>
      </div>
      <div className="slot-summary-grid">
        <SummaryTile label="TOTAL" value={totalPool} />
        <SummaryTile label="ASSIGNED" value={assignedWeight} />
        <SummaryTile label="REMAINING" value={summary.remaining} tone={summary.remaining === 0 ? 'ok' : 'warn'} />
        <SummaryTile label="REEL SYMBOLS" value={`${symbolIndex.size}/${SLOT_SYMBOL_SLOT_COUNT}`} tone={symbolIndex.size === SLOT_SYMBOL_SLOT_COUNT ? 'ok' : 'warn'} />
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={saveRules}>SAVE SLOT RULES</button>
    </Card>

    {activeSession && <Card className="slot-active-card">
      <div className="section-heading">
        <div><div className="label muted">LIVE SERIES</div><h2 className="display">{activeSession.playerName} is playing</h2></div>
        <Status tone="open">{activeSession.usedSpins}/{activeSession.totalSpins} SPINS USED</Status>
      </div>
      <p className="muted">Stake per spin {activeSession.stakePerSpin} · remaining spins {activeSession.remainingSpins} · locked value {activeSession.lockedValue}. Only one series can be live, because one slot machine is presented on the Big Screen.</p>
      <button className="btn btn-danger-ghost" disabled={busy} onClick={() => act(async () => { if (window.confirm('Cancel this series and refund the unspun stake?')) await run('/api/cancel-slot-session', {}, true); })}>CANCEL SERIES AND REFUND</button>
    </Card>}

    <Card>
      <div className="section-heading"><div><div className="label muted">REEL SYMBOLS</div><h2 className="display">12 PNG symbols per reel</h2></div></div>
      <p className="muted">Every reel needs all 12 positions filled. Positions are labelled A–L and those letters are what the outcome table below refers to. Maximum 1 MB per PNG.</p>
      <div className="slot-reel-columns">
        {SLOT_REELS.map(reel => <div className="slot-reel-column" key={reel}>
          <div className="slot-reel-column-head">
            <b className="display">REEL {reel}</b>
            <span className="muted">{slotPositions.filter(position => symbolIndex.has(`${reel}-${position}`)).length}/12</span>
          </div>
          <div className="slot-symbol-grid">
            {slotPositions.map(position => <SymbolSlot
              key={position}
              gameId={gameId}
              reel={reel}
              position={position}
              symbol={symbolIndex.get(`${reel}-${position}`)}
              busy={busy}
              onUpload={file => uploadSymbol(reel, position, file)}
              onDelete={() => deleteSymbol(reel, position)}
            />)}
          </div>
        </div>)}
      </div>
    </Card>

    <Card>
      <div className="section-heading">
        <div><div className="label muted">OUTCOME DISTRIBUTION</div><h2 className="display">{SLOT_COMBINATION_COUNT.toLocaleString()} possible outcomes</h2></div>
        <Status tone={drafts.size ? 'warning' : 'neutral'}>{drafts.size ? `${drafts.size} UNSAVED` : 'SAVED'}</Status>
      </div>
      <p className="muted">Give a combination a number of chances out of the total pool. The percentage is derived as chances ÷ total × 100. Payout is a multiplier of the stake for that spin.</p>
      <div className="slot-filter-bar">
        {SLOT_REELS.map(reel => <label className="field-label" key={reel}>Reel {reel}
          <select className="field" value={(filters as any)[`reel${reel}`]} onChange={e => setFilters({ ...filters, [`reel${reel}`]: e.target.value })}>
            <option value={ANY}>Any</option>
            {slotPositions.map(position => <option key={position} value={position}>{slotSymbolLetter(position)} · position {position}</option>)}
          </select>
        </label>)}
        <label className="field-label">Show
          <select className="field" value={filters.onlyConfigured ? 'configured' : 'all'} onChange={e => setFilters({ ...filters, onlyConfigured: e.target.value === 'configured' })}>
            <option value="configured">Configured only</option>
            <option value="all">All combinations</option>
          </select>
        </label>
      </div>

      {rows.length === 0
        ? <div className="sub-empty">No combination matches this filter yet. Switch to “All combinations” to give one a chance and a payout.</div>
        : <>
          <div className="slot-table-wrap">
            <table className="slot-outcome-table">
              <thead><tr><th>Outcome</th><th>Symbols</th><th className="numeric">Chances</th><th className="numeric">Chance</th><th className="numeric">Payout</th></tr></thead>
              <tbody>
                {visible.map(row => {
                  const draft = readDraft(row.key);
                  return <tr key={row.key} className={row.dirty ? 'slot-row-dirty' : ''}>
                    <td className="mono slot-outcome-label">{slotOutcomeLabel(row.reel1, row.reel2, row.reel3)}</td>
                    <td>
                      <div className="slot-thumb-row">
                        {[row.reel1, row.reel2, row.reel3].map((position, index) => <Thumb key={index} gameId={gameId} reel={index + 1} position={position} symbol={symbolIndex.get(`${index + 1}-${position}`)} />)}
                      </div>
                    </td>
                    <td className="numeric"><input className="field slot-cell-input" type="number" min="0" value={draft.weight} onChange={e => setDraft(row.key, { weight: e.target.value }, draft)} /></td>
                    <td className="numeric mono">{formatSlotPercentage(row.weight, totalPool)}</td>
                    <td className="numeric"><input className="field slot-cell-input" type="number" min="0" step="0.25" value={draft.payout} onChange={e => setDraft(row.key, { payout: e.target.value }, draft)} /></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <div className="slot-pager">
            <button className="btn btn-secondary btn-compact" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← PREVIOUS</button>
            <span className="muted">{rows.length.toLocaleString()} combinations · page {currentPage + 1} of {pageCount}</span>
            <button className="btn btn-secondary btn-compact" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>NEXT →</button>
          </div>
        </>}

      <div className="actions">
        <button className="btn btn-primary" disabled={busy || drafts.size === 0} onClick={saveOutcomes}>SAVE {drafts.size || ''} OUTCOME{drafts.size === 1 ? '' : 'S'}</button>
        <button className="btn btn-secondary" disabled={busy || drafts.size === 0} onClick={() => setDrafts(new Map())}>DISCARD CHANGES</button>
        <button className="btn btn-danger-ghost" disabled={busy} onClick={clearOutcomes}>CLEAR DISTRIBUTION</button>
      </div>
    </Card>
  </>;
}

function SummaryTile({ label, value, tone }: { label: string; value: number | string; tone?: 'ok' | 'warn' }) {
  return <div className={`slot-summary-tile ${tone ? `tone-${tone}` : ''}`}><div className="label muted">{label}</div><b className="display">{value}</b></div>;
}

function Thumb({ gameId, reel, position, symbol }: { gameId: number; reel: number; position: number; symbol?: SlotSymbol }) {
  if (!symbol) return <span className="slot-thumb slot-thumb-empty">{slotSymbolLetter(position)}</span>;
  return <img className="slot-thumb" src={slotSymbolUrl(gameId, reel, position, symbol.checksum)} alt={`Reel ${reel} ${slotSymbolLetter(position)}`} />;
}

function SymbolSlot({ gameId, reel, position, symbol, busy, onUpload, onDelete }: {
  gameId: number; reel: number; position: number; symbol?: SlotSymbol; busy: boolean;
  onUpload: (file: File) => void; onDelete: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <div className={`slot-symbol-slot ${symbol ? 'filled' : 'empty'}`}>
    <div className="slot-symbol-index"><b>{position}</b><span>{slotSymbolLetter(position)}</span></div>
    <div className="slot-symbol-preview">
      {symbol
        ? <img src={slotSymbolUrl(gameId, reel, position, symbol.checksum)} alt={`Reel ${reel} symbol ${slotSymbolLetter(position)}`} />
        : <span className="muted">EMPTY</span>}
    </div>
    <div className="slot-symbol-actions">
      <button className="text-button" disabled={busy} onClick={() => input.current?.click()}>{symbol ? 'REPLACE' : 'UPLOAD'}</button>
      {symbol && <button className="text-button danger-text" disabled={busy} onClick={onDelete}>REMOVE</button>}
    </div>
    <input
      ref={input}
      type="file"
      accept="image/png"
      hidden
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpload(file); }}
    />
  </div>;
}
