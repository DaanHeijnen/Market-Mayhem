import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Accordion, Card, Empty } from '../ui';

/**
 * The design's ledger is a plain readable list — player, what happened, amount —
 * because during a game night that is all the host wants to scan. The filter, the
 * per-round summary and the full attributed table are all still here, one click down.
 *
 * One-shot fetch keyed on `state.version`, never its own polling loop.
 */
export function LedgerPage({ state: s, gameId }: { state: any; gameId: number }) {
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    let stop = false;
    api<any>(`/api/ledger-state?gameId=${gameId}&round=${filter}`).then(x => { if (!stop) { setData(x); setError(''); } }).catch(e => !stop && setError(e.message));
    return () => { stop = true; };
  }, [filter, gameId, s.version]);

  const entries = data?.entries ?? [];

  return <div className="page-stack">
    <Card><div className="row-between"><div><div className="label muted">LEDGER FILTER</div><h2 className="display card-heading">Immutable economy history</h2></div><select className="field compact-field" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All rounds</option><option value="general">General / no round</option>{s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.round_number).padStart(2, '0')} · {r.title}</option>)}</select></div>{error && <p className="neg"><b>{error}</b></p>}</Card>

    {!data ? <Empty title="Loading ledger…" /> : entries.length === 0 ? <Empty title="No transactions yet" /> : <>
      <div className="ledger-simple">
        {entries.map((x: any) => <div className="ledger-simple-row" key={x.id}>
          <span><b>{x.display_name}</b> · {x.description}</span>
          <b className={x.amount >= 0 ? 'pos' : 'neg'}>{x.amount > 0 ? '+' : ''}{x.amount}</b>
        </div>)}
      </div>

      <Accordion title={`FULL DETAIL · ${entries.length} ENTR${entries.length === 1 ? 'Y' : 'IES'}`} open={detail} onToggle={() => setDetail(x => !x)}>
        {data.summary?.length > 0 && <>
          <div className="label muted">ROUND ECONOMY SUMMARY</div>
          <div className="summary-grid">{data.summary.map((x: any) => <div key={x.id} className="summary-chip"><b>{x.display_name}</b><span className="pos">+{x.earned}</span><span className="neg">−{x.lost}</span><strong className={x.net >= 0 ? 'pos' : 'neg'}>{x.net > 0 ? '+' : ''}{x.net}</strong></div>)}</div>
        </>}
        <div className="table-wrap"><table><thead><tr><th>Timestamp</th><th>Player</th><th>Amount</th><th>Description</th><th>Type</th><th>Round</th><th>Group / block</th><th>Prediction</th><th>Roulette</th></tr></thead><tbody>{entries.map((x: any) => <tr key={x.id}><td>{new Date(x.created_at).toLocaleString()}</td><td>{x.display_name}</td><td className={x.amount >= 0 ? 'pos' : 'neg'}><b>{x.amount > 0 ? '+' : ''}{x.amount}</b></td><td>{x.description}</td><td><span className="mono">{x.transaction_type}</span></td><td>{x.round_number ? `R${String(x.round_number).padStart(2, '0')}` : '—'}</td><td>{x.group_name || x.block_title || '—'}</td><td>{x.prediction_number ? `#${x.prediction_number}` : '—'}</td><td>{x.roulette_game_id ? `#${x.roulette_game_id}` : '—'}</td></tr>)}</tbody></table></div>
      </Accordion>
    </>}
  </div>;
}
