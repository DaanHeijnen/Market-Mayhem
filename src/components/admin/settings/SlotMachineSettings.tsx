import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Status } from '../ui';

const POSITIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const letter = (position: number) => String.fromCharCode(64 + position);
const mediaUrl = (key: string) => `/api/block-media?key=${encodeURIComponent(key)}`;

/**
 * The five fixed outcome categories.
 *
 * Mirrors SLOT_OUTCOME_TYPES / SLOT_OUTCOME_LABELS in netlify/lib/slotmachine.ts. src
 * and netlify are separate TypeScript projects, so this is a local copy rather than
 * pulling backend code into the client bundle; the server rejects any type not on its
 * own list, so the two cannot silently diverge.
 */
const OUTCOME_TYPES = [
  { type: 'NO_WIN', label: 'Geen winst', hint: 'No winning pattern anywhere in the field.', pattern: 'A B C' },
  { type: 'TWO_SPLIT', label: '2 dezelfde gesplitst', hint: 'Two alike on the main row, separated by a different symbol.', pattern: 'C D C' },
  { type: 'TWO_ADJACENT', label: '2 dezelfde naast elkaar', hint: 'Two alike side by side on the main row. Pays more than split.', pattern: 'C C D' },
  { type: 'THREE_LINE', label: '3 dezelfde op lijn', hint: 'Three alike on a row or a diagonal.', pattern: 'A A A' },
  { type: 'THREE_ANYWHERE', label: '3 dezelfde ergens zichtbaar', hint: 'Three alike in the field but not on a line.', pattern: 'scattered' },
] as const;

type OutcomeType = typeof OUTCOME_TYPES[number]['type'];
type OutcomeRow = { type: OutcomeType; weight: number; payoutMultiplier: number };

const canPayout = (type: OutcomeType) => type !== 'NO_WIN';

/**
 * The game-wide slotmachine configuration: the symbol artwork and the chance/payout for
 * each of the five outcome categories.
 *
 * Global rather than per block because there is one machine for the night — the same
 * symbols and the same odds — and the Admin sets it up once. Per-round choices (title,
 * instructions, max spins, who plays) live on the block instead.
 *
 * The chances belong to *patterns*, not to pictures. There is no table of specific
 * symbol combinations any more: the server draws a category and then invents a field
 * that matches it, so "three alike on a line" carries one chance and one payout however
 * it happens to be filled.
 */
export function SlotMachineSettings({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const config = s.slotConfig;
  const status = config?.status;

  const [totalWeight, setTotalWeight] = useState<string>(String(config?.totalWeight ?? 100));
  useEffect(() => { setTotalWeight(String(config?.totalWeight ?? 100)); }, [config?.totalWeight]);

  // Local working copy so several numbers can be nudged before saving. Reset whenever
  // the server sends a different distribution.
  const serverRows: OutcomeRow[] = useMemo(() => OUTCOME_TYPES.map(({ type }) => {
    const found = (config?.outcomeTypes || []).find((row: any) => row.type === type);
    return {
      type,
      weight: Number(found?.weight ?? 0),
      payoutMultiplier: canPayout(type) ? Number(found?.payoutMultiplier ?? 0) : 0,
    };
  }), [config?.outcomeTypes]);

  const [rows, setRows] = useState<OutcomeRow[]>(serverRows);
  const signature = JSON.stringify(serverRows);
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setRows(serverRows);
  }, [signature, serverRows]);

  const total = Number(totalWeight) || 0;
  const allocated = rows.reduce((sum, row) => sum + (Number(row.weight) || 0), 0);
  const remaining = total - allocated;
  const dirty = signature !== JSON.stringify(rows) || String(config?.totalWeight ?? 100) !== totalWeight;

  const symbolFor = (position: number) => (config?.symbols || []).find((x: any) => x.position === position)?.mediaKey || '';
  const update = (type: OutcomeType, patch: Partial<OutcomeRow>) =>
    setRows(rows.map(row => row.type === type ? { ...row, ...patch } : row));

  const save = () => run('/api/update-slot-config', {
    totalWeight: total,
    outcomeTypes: rows.map(row => ({
      type: row.type,
      weight: Number(row.weight) || 0,
      payoutMultiplier: canPayout(row.type) ? Number(row.payoutMultiplier) || 0 : 0,
    })),
  });

  return <>
    <Card>
      <div className="section-heading">
        <div>
          <div className="label muted">SLOTMACHINE · SYMBOLS</div>
          <h2 className="display">Twelve symbols, shared by all reels</h2>
        </div>
        <Status tone={status?.valid ? 'success' : 'warning'}>{status?.valid ? 'READY' : 'INCOMPLETE'}</Status>
      </div>
      <p className="muted">
        Twelve symbols, shared by all three reels — upload each one once. The machine draws freely from all twelve, so
        every slot needs artwork; which symbol fills a winning pattern is decided per spin, not configured.
        {' '}{status?.symbolCount ?? 0} of 12 uploaded.
      </p>

      <div className="slot-symbol-grid">
        {POSITIONS.map(position => <SymbolSlot
          key={position}
          gameId={gameId}
          position={position}
          mediaKey={symbolFor(position)}
          run={run}
        />)}
      </div>
    </Card>

    <Card>
      <div className="section-heading">
        <div>
          <div className="label muted">SLOTMACHINE · KANSEN</div>
          <h2 className="display">Chance and payout per outcome</h2>
        </div>
        <Status tone={remaining === 0 ? 'success' : remaining < 0 ? 'danger' : 'warning'}>
          {allocated} / {total}
        </Status>
      </div>
      <p className="muted">
        Five fixed outcomes. The server draws one of them using these chances, then builds a 3×3 field that matches —
        so the payout belongs to the pattern, never to a particular picture. Percentage is <b>chance ÷ total × 100</b>,
        and the multiplier applies to the stake for a single spin.
      </p>

      <div className="form-grid compact">
        <label>Total number of chances<input className="field" type="number" min="1" value={totalWeight} onChange={e => setTotalWeight(e.target.value)} /></label>
      </div>

      <div className={`slot-validity ${status?.valid && !dirty ? 'is-valid' : 'is-invalid'}`}>
        <b>{remaining === 0 ? `Chances add up exactly · ${allocated} / ${total}` : remaining > 0 ? `${remaining} chances still unassigned` : `${Math.abs(remaining)} chances over the total`}</b>
        <span className="muted">{dirty ? 'Unsaved changes — save to apply.' : status?.reason || ''}</span>
      </div>

      <div className="table-wrap slot-outcome-table">
        <table>
          <thead><tr><th>Outcome</th><th>Pattern</th><th className="num">Kans</th><th className="num">Chance</th><th className="num">Payout</th></tr></thead>
          <tbody>
            {OUTCOME_TYPES.map(({ type, label, hint, pattern }) => {
              const row = rows.find(r => r.type === type) || { type, weight: 0, payoutMultiplier: 0 };
              // Multiply before dividing, matching outcomePercentage on the server:
              // 7 / 100 * 100 lands on 7.000000000000001 in floating point.
              const percentage = total > 0 ? ((Number(row.weight) || 0) * 100) / total : 0;
              return <tr key={type}>
                <td>
                  <b className="slot-outcome-name">{label}</b>
                  <div className="muted slot-outcome-hint">{hint}</div>
                </td>
                <td><span className="slot-pattern-chip">{pattern}</span></td>
                <td className="num">
                  <input className="field slot-num-input" type="number" min="0" value={row.weight}
                    onChange={e => update(type, { weight: Number(e.target.value) || 0 })} />
                </td>
                <td className="num mono">{percentage.toFixed(2)}%</td>
                <td className="num">
                  {canPayout(type)
                    ? <input className="field slot-num-input" type="number" min="0" step="0.1" value={row.payoutMultiplier}
                        onChange={e => update(type, { payoutMultiplier: Number(e.target.value) || 0 })} />
                    // No win pays nothing by definition, so this is stated rather than
                    // offered as an editable field that would be ignored.
                    : <span className="muted slot-fixed-payout">0x</span>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <button className="btn btn-primary" disabled={!dirty || total < 1} onClick={save}>SAVE CHANCES</button>
      <p className="muted microcopy">
        An incomplete distribution saves fine so you can nudge the numbers into place — but the slotmachine block
        refuses to run until the chances match the total exactly and all twelve symbols have artwork.
      </p>
    </Card>
  </>;
}

/**
 * One of the twelve shared symbols: upload, replace, remove, and a thumbnail.
 *
 * Uploads go through the existing round-media endpoint, so slot symbols land in the same
 * blob store as picture rounds and only the key is ever stored.
 */
function SymbolSlot({ gameId, position, mediaKey, run }: {
  gameId: number;
  position: number;
  mediaKey: string;
  run: RunMutation;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const upload = async (file: File | undefined | null) => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('gameId', String(gameId));
      form.append('kind', 'image');
      form.append('file', file);
      const response = await fetch('/api/upload-block-media', { method: 'POST', credentials: 'include', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');
      await run('/api/update-slot-config', { symbols: [{ position, mediaKey: data.key }] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return <div className="slot-symbol-slot">
    <div
      className={`slot-symbol-drop ${dragging ? 'is-dragging' : ''} ${mediaKey ? 'has-file' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files?.[0]); }}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      aria-label={`Symbol ${letter(position)}, position ${position}${mediaKey ? ' — replace image' : ' — upload image'}`}
    >
      {mediaKey
        ? <img src={mediaUrl(mediaKey)} alt="" />
        : <span className="slot-symbol-placeholder">{busy ? '…' : '+'}</span>}
    </div>
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/png,image/*" disabled={busy} onChange={e => void upload(e.target.files?.[0])} />
    <div className="slot-symbol-meta">
      <b>{position}</b>
      <span>{letter(position)}</span>
      {mediaKey && !busy && <button className="text-button slot-symbol-remove" onClick={() => run('/api/update-slot-config', { symbols: [{ position, mediaKey: '' }] })}>remove</button>}
    </div>
    {error && <span className="neg slot-symbol-error">{error}</span>}
  </div>;
}
