import { useEffect, useRef, useState } from 'react';
import { mutation } from '../../lib/api';
import { CoinIcon } from '../shared/CoinIcon';
import { RouletteTable, type RouletteMarker, type RoulettePosition } from '../shared/RouletteTable';

const QUESTION_EMOJIS = ['🍆', '🌽', '🍑', '😳'] as const;

export type MobileView = 'home' | 'predictions' | 'prediction' | 'roulette';

/**
 * Every screen a player can see, with no opinion about where the view name comes
 * from. The live app drives it from the URL; the Admin's phone preview drives it
 * from local state. One implementation, so the preview can never drift from the
 * thing it is previewing.
 *
 * A live Duolingo block still owns the phone regardless of `view` — that is
 * backend-driven and must stay that way.
 */
export function MobileViews({ state: s, gameId, view, predictionId, busy, act, go }: {
  state: any;
  gameId: number;
  view: MobileView;
  predictionId: number | null;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => void;
  go: (path?: string) => void;
}) {
  const currentPrediction = s.predictions.find((p: any) => p.id === predictionId);
  if (s.interactiveBlock) return <LiveQuestionView state={s} block={s.interactiveBlock} busy={busy} act={act} gameId={gameId} />;
  // Backend-driven, like the live question above it: while a slotmachine block is the
  // live content the phone becomes its controller, and it goes away again on its own
  // when the Admin moves to the next block. There is no route to reach it by hand.
  if (s.slotmachine) return <SlotControllerView state={s} slot={s.slotmachine} busy={busy} act={act} gameId={gameId} />;
  // Backend-driven for the same reason: the live block owns the phone, and Pak een Zes
  // goes away again on its own when the host moves on.
  if (s.pakEenZes) return <PakEenZesView state={s} game={s.pakEenZes} busy={busy} act={act} gameId={gameId} />;
  if (view === 'predictions') return <PredictionList state={s} go={go} busy={busy} act={act} gameId={gameId} />;
  if (view === 'prediction' && currentPrediction) return <PredictionDetail state={s} prediction={currentPrediction} busy={busy} act={act} go={go} gameId={gameId} />;
  if (view === 'roulette') return <RouletteView state={s} busy={busy} act={act} go={go} gameId={gameId} />;
  return <Home state={s} go={go} gameId={gameId} />;
}

export function Shell({ children }: { children: any }) { return <main className="mobile-shell">{children}</main>; }
export function Card({ children, className = '' }: { children: any; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }

function Home({ state: s, go, gameId }: { state: any; go: (x?: string) => void; gameId: number }) {
  const animatedBalance = useFirstLandingBalance(gameId, s.player.id, s.player.startingBalance, s.player.balance);
  return <>
    <div className="mobile-top">
      <div><div className="label muted">MARKET MAYHEM</div><h1 className="display mobile-player-name">{s.player.name}</h1></div>
      <div className="rank-chip">#{s.player.rank}</div>
    </div>
    <Card className="wallet-card">
      <div className="label muted">AVAILABLE WALLET</div>
      <div className="wallet-primary"><CoinIcon size={34} /><span>{animatedBalance}</span></div>
      <div className="wallet-breakdown">
        <span>Prediction deposits <b>{s.player.lockedPrediction}</b></span>
        <span>Roulette locked <b>{s.player.lockedRoulette}</b></span>
        <span>Slotmachine locked <b>{s.player.lockedSlot ?? 0}</b></span>
        <span>Total player value <b>{s.player.totalValue}</b></span>
      </div>
    </Card>
    <div className="mobile-actions">
      <button className="btn btn-primary big-mobile-btn" disabled={!s.predictionAvailable} onClick={() => go('/predictions')}>
        <span>PREDICTIONS</span><span className="button-count">{s.predictions.filter((p: any) => p.status === 'OPEN').length}</span>
      </button>
      {/* player-state only sends a roulette once it has left DRAFT, so its presence
          means the Admin has opened the spin. Showing a permanently disabled tile
          otherwise advertises a game that may never run. */}
      {s.roulette && <button className="btn btn-secondary big-mobile-btn" onClick={() => go('/roulette')}>
        <span>ROULETTE</span><span className="button-count">{s.roulette?.status === 'OPEN' ? 'LIVE' : 'VIEW'}</span>
      </button>}
    </div>
    {!s.actionable && <Card><div className="display card-title">No live actions</div><p className="muted">Your wallet stays ready. Prediction participation is optional: doing nothing creates no transaction.</p></Card>}
    <Ledger state={s} />
  </>;
}

function PredictionList({ state: s, go, busy, act, gameId }: { state: any; go: (x?: string) => void; busy: boolean; act: (x: () => Promise<unknown>) => void; gameId: number }) {
  return <>
    <Back go={go} />
    <div className="page-heading"><div className="label muted">PREDICTIONS</div><h1 className="display">Markets</h1></div>
    {s.predictions.length === 0
      ? <Card><b>No prediction markets are available.</b></Card>
      : <div className="mobile-market-list">{s.predictions.map((p: any) => {
        const active = p.status === 'OPEN';
        const resolved = ['RESULT', 'SETTLED', 'CANCELLED'].includes(p.status);
        return <button key={p.id} className={`mobile-market-card card ${active ? 'market-active' : ''} ${resolved ? 'market-settled' : ''}`} onClick={() => go(`/prediction/${p.id}`)}>
          <div className="row-between"><span className="label">#{p.number}{p.roundNumber ? ` · R${String(p.roundNumber).padStart(2, '0')}` : ''}</span><PublicPredictionPill p={p} /></div>
          <h2 className="display">{p.question}</h2>
          <div className="mobile-odds"><span className="yes-text">YES <b>@ {p.yesOdds.toFixed(2)}x</b></span><span className="no-text">NO <b>@ {p.noOdds.toFixed(2)}x</b></span></div>
          {p.status === 'OPEN' && <div className="market-timer">Time remaining <strong><LiveCountdown closesAt={p.closesAt} /></strong></div>}
          {p.ownBet && <BetPlacedMini bet={p.ownBet} />}
          {['RESULT','SETTLED'].includes(p.status) && <div className="settled-result">Resolved <b>{p.result}</b>{p.status === 'RESULT' ? ' · payout pending' : ''}</div>}
          {p.status === 'CANCELLED' && <div className="settled-result">Cancelled · deposit refunded</div>}
        </button>;
      })}</div>}
    <PredictionRequests state={s} busy={busy} act={act} gameId={gameId} />
  </>;
}

/**
 * Propose a market of your own. The limits are shown before the player types, so the
 * refusal is never a surprise — two requests each, and an hour between them.
 */
function PredictionRequests({ state: s, busy, act, gameId }: { state: any; busy: boolean; act: (x: () => Promise<unknown>) => void; gameId: number }) {
  const requests = s.predictionRequests || { mine: [], remaining: 0, cooldownMinutesLeft: 0 };
  const [text, setText] = useState('');
  const onCooldown = requests.cooldownMinutesLeft > 0;
  const canSend = requests.remaining > 0 && !onCooldown && text.trim().length > 0 && !busy;

  return <>
    {requests.mine.length > 0 && <Card className="request-mine">
      <div className="label muted">YOUR PREDICTION REQUESTS</div>
      {requests.mine.map((r: any) => <div className="request-mine-row" key={r.id}>
        <div className="request-mine-question">{r.question}</div>
        <span className={`pill status-pill ${r.status === 'PENDING' ? 'neutral' : r.status === 'APPROVED' ? 'yes' : 'no'}`}>{r.statusLabel}</span>
      </div>)}
    </Card>}

    <Card>
      <div className="label muted">SUBMIT YOUR OWN PREDICTION{requests.remaining > 0 ? ` · ${requests.remaining} LEFT` : ''}</div>
      {requests.remaining === 0
        ? <p className="muted">You have used both of your prediction requests.</p>
        : onCooldown
          ? <p className="muted">You can send another prediction in {requests.cooldownMinutesLeft} min.</p>
          : <div className="request-form">
            <textarea className="field" rows={2} placeholder="e.g. Wint Team Blauw de bonusronde?" value={text} onChange={e => setText(e.target.value)} />
            <button className="btn btn-primary btn-full" disabled={!canSend} onClick={() => act(async () => { await mutation('/api/create-prediction-request', { gameId, question: text.trim() }); setText(''); })}>SEND TO ADMINS</button>
          </div>}
    </Card>
  </>;
}

function PredictionDetail({ state: s, prediction: p, busy, act, go, gameId }: { state: any; prediction: any; busy: boolean; act: (x: () => Promise<unknown>) => void; go: (x?: string) => void; gameId: number }) {
  const [side, setSide] = useState<'YES' | 'NO'>('YES');
  const [stake, setStake] = useState<number>(p.minimumStake);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  useEffect(() => { setSubmissionKey(crypto.randomUUID()); }, [p.id]);
  const remaining = useRemaining(p.closesAt);
  const percent = s.settings.maximumWalletPercentage;
  const percentCap = percent == null ? s.player.balance : Math.floor(s.player.balance * percent / 100);
  const cap = Math.min(s.player.balance, p.maximumStake, percentCap);
  const maxStake = cap >= p.minimumStake ? cap : 0;
  useEffect(() => { setStake(x => Math.max(p.minimumStake, Math.min(x, maxStake || p.minimumStake))); }, [maxStake, p.minimumStake, p.id]);
  const multiplier = side === 'YES' ? p.yesOdds : p.noOdds;
  const potential = Math.round(stake * multiplier);

  return <>
    <Back go={() => go('/predictions')} />
    <Card className={`prediction-detail ${['RESULT', 'SETTLED', 'CANCELLED'].includes(p.status) ? 'market-settled' : p.status === 'OPEN' ? 'market-active' : ''}`}>
      <div className="row-between"><span className="label">PREDICTION #{p.number}</span><PublicPredictionPill p={p} /></div>
      <h1 className="display prediction-question">{p.question}</h1>
      {p.status === 'OPEN' && <div className="countdown-box"><div className="label">TIME REMAINING</div><div className="display countdown-large"><LiveCountdown closesAt={p.closesAt} /></div></div>}
      <div className="mobile-odds-buttons">
        <button disabled={!!p.ownBet || p.status !== 'OPEN'} className={`yes-option ${side === 'YES' ? 'selected' : ''}`} onClick={() => setSide('YES')}><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></button>
        <button disabled={!!p.ownBet || p.status !== 'OPEN'} className={`no-option ${side === 'NO' ? 'selected' : ''}`} onClick={() => setSide('NO')}><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></button>
      </div>
      {p.ownBet
        ? <BetReceipt bet={p.ownBet} status={p.status} result={p.result} />
        : p.status === 'OPEN'
          ? <div className="bet-form">
              <div className="balance-inline"><span>Available balance</span><b><CoinIcon size={18} /> {s.player.balance}</b></div>
              <div className="stake-bounds"><span>Market min {p.minimumStake}</span><span>Market max {p.maximumStake}</span></div>
              <label className="field-label">Deposit<input className="field" type="number" min={p.minimumStake} max={maxStake} value={stake} onChange={e => setStake(Number(e.target.value) || 0)} /></label>
              <input className="stake-range" type="range" min={p.minimumStake} max={Math.max(p.minimumStake, maxStake)} value={Math.min(stake, Math.max(p.minimumStake, maxStake))} onChange={e => setStake(Number(e.target.value))} />
              <div className="potential-card"><span>Locked multiplier</span><b>{multiplier.toFixed(2)}x</b><span>Potential payout</span><strong>{potential} coins</strong></div>
              <button className="btn btn-primary btn-full" disabled={busy || remaining <= 0 || maxStake === 0 || stake < p.minimumStake || stake > maxStake} onClick={() => act(() => mutation('/api/place-bet', { gameId, predictionId: p.id, side, stake }, true, submissionKey))}>LOCK {stake} ON {side}</button>
              <p className="muted microcopy">No bet is required. If you do nothing before the timer expires, there is no wallet movement.</p>
            </div>
          : <PredictionStatus prediction={p} />}
    </Card>
  </>;
}

function BetReceipt({ bet, status, result }: { bet: any; status: string; result: string | null }) {
  const won = status === 'SETTLED' && result === bet.side;
  const depositLabel = ['SETTLED','CANCELLED'].includes(status) ? 'Deposited amount' : 'Deposit locked';
  return <div className={`bet-receipt ${status === 'SETTLED' ? won ? 'receipt-win' : 'receipt-loss' : ''}`}>
    <div className="receipt-title">✓ BET PLACED</div>
    <div className="receipt-grid"><span>Side</span><b>{bet.side}</b><span>{depositLabel}</span><b>{bet.stake} coins</b><span>Locked multiplier</span><b>{Number(bet.odds).toFixed(2)}x</b><span>Potential payout</span><b>{bet.potentialReturn} coins</b></div>
    {status === 'SETTLED' && <div className="receipt-outcome">{won ? `WIN · ${bet.potentialReturn} returned` : 'LOSS · deposit settled at 0'}</div>}
    {status === 'CANCELLED' && <div className="receipt-outcome">CANCELLED · deposit returned</div>}
  </div>;
}

function BetPlacedMini({ bet }: { bet: any }) {
  return <div className="bet-placed-mini"><b>BET PLACED</b><span>{bet.side} · {bet.stake} coins · {Number(bet.odds).toFixed(2)}x</span></div>;
}

function PredictionStatus({ prediction: p }: { prediction: any }) {
  if (p.status === 'LOCKED') return <div className="state-panel"><b>Market locked</b><span>Waiting for the result.</span></div>;
  if (p.status === 'RESULT') return <div className="state-panel"><b>Result selected: {p.result}</b><span>Settlement is being confirmed.</span></div>;
  if (p.status === 'SETTLED') return <div className="state-panel settled"><b>{p.result} resolved</b><span>This market is settled.</span></div>;
  if (p.status === 'CANCELLED') return <div className="state-panel settled"><b>Market cancelled</b><span>Active deposits were returned.</span></div>;
  return <p className="muted">This market is not open.</p>;
}

function PublicPredictionPill({ p }: { p: any }) {
  const label = p.publicStatus === 'RESOLVED_YES' ? 'RESOLVED · YES' : p.publicStatus === 'RESOLVED_NO' ? 'RESOLVED · NO' : p.publicStatus || p.status;
  const cls = label.includes('YES') ? 'yes' : label.includes('NO') ? 'no' : label === 'OPEN' ? 'open' : 'neutral';
  return <span className={`pill status-pill ${cls}`}>{label}</span>;
}

function RouletteView({ state: s, busy, act, go, gameId }: { state: any; busy: boolean; act: (x: () => Promise<unknown>) => void; go: (x?: string) => void; gameId: number }) {
  const rg = s.roulette;
  const [chip, setChip] = useState(5);
  const [pending, setPending] = useState<Array<RoulettePosition & { stake: number }>>([]);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  useEffect(() => { setPending([]); setSubmissionKey(crypto.randomUUID()); }, [rg?.id]);
  if (!rg) return <><Back go={go} /><Card><b>No roulette game is active.</b><p className="muted">The Admin will make roulette available when its round block is live.</p></Card></>;

  const addPosition = (position: RoulettePosition) => {
    if (rg.status !== 'OPEN') return;
    setPending(current => {
      const sameIndex = current.findIndex(x => x.betType === position.betType && x.selection === position.selection);
      if (sameIndex >= 0) {
        const next = [...current];
        next[sameIndex] = { ...position, stake: chip };
        return next;
      }
      return [...current, { ...position, stake: chip }].slice(0, 24);
    });
  };
  const total = pending.reduce((sum, bet) => sum + bet.stake, 0);
  const markers: RouletteMarker[] = [
    ...(rg.own_bets || []).map((b: any) => ({ id: b.id, betType: b.bet_type, selection: String(b.selection), stake: Number(b.stake), displayName: 'YOU', color: s.player.color })),
    ...pending.map((b, i) => ({ ...b, id: `pending-${i}`, pending: true, displayName: 'NEXT', color: s.player.color })),
  ];

  return <>
    <Back go={go} />
    <Card className="roulette-mobile-card">
      <div className="row-between"><div><div className="label">ROULETTE #{rg.id}</div><h1 className="display roulette-title">{rg.block_title || 'Roulette'}</h1></div><span className={`pill status-pill ${rg.status === 'OPEN' ? 'open' : 'neutral'}`}>{rg.status}</span></div>
      {rg.result_number != null && <div className="roulette-result-badge"><span>WINNING NUMBER</span><b>{rg.result_number}</b></div>}
      {rg.status === 'OPEN' ? <>
        <div className="roulette-help"><b>1.</b> Choose a chip <b>2.</b> Tap one or more table positions <b>3.</b> Confirm</div>
        <div className="chip-picker">{[1, 5, 10, 25].map(v => <button key={v} className={`chip ${chip === v ? 'selected' : ''}`} onClick={() => setChip(v)}>{v}</button>)}<label className="custom-chip">Custom<input type="number" min="1" max={Math.max(1, s.player.balance)} value={chip} onChange={e => setChip(Math.max(1, Number(e.target.value) || 1))} /></label></div>
        <RouletteTable onSelect={addPosition} markers={markers} />
        {pending.length > 0 && <div className="pending-bets"><div className="row-between"><b>Next chips</b><button className="text-button" onClick={() => setPending([])}>Clear</button></div>{pending.map((b, i) => <div className="pending-bet" key={`${b.betType}-${b.selection}`}><span>{rouletteLabel(b)}</span><b>{b.stake}</b><button aria-label="Remove chip" onClick={() => setPending(x => x.filter((_, j) => j !== i))}>×</button></div>)}</div>}
        <div className="roulette-confirm"><div><span>Available</span><b>{s.player.balance}</b></div><div><span>New stake</span><b>{total}</b></div><button className="btn btn-primary btn-full" disabled={busy || pending.length === 0 || total > s.player.balance} onClick={() => act(async () => { await mutation('/api/place-roulette-bets', { gameId, rouletteGameId: rg.id, bets: pending }, true, submissionKey); setPending([]); setSubmissionKey(crypto.randomUUID()); })}>PLACE {pending.length} CHIP{pending.length === 1 ? '' : 'S'} · {total}</button></div>
      </> : <div className="state-panel"><b>{rg.status === 'SPINNING' ? 'Wheel spinning…' : rg.status === 'LOCKED' ? 'Betting locked' : rg.status === 'RESULT' ? `Result ${rg.result_number}` : rg.status === 'SETTLED' ? 'Spin settled' : 'Roulette closed'}</b><span>{rg.status === 'LOCKED' ? 'No more chips can be added.' : 'Your placed chips remain visible below.'}</span></div>}
      {(rg.own_bets || []).length > 0 && <div className="own-roulette-bets"><div className="label muted">YOUR CHIPS</div>{rg.own_bets.map((b: any) => <div className="ledger-line" key={b.id}><span>{rouletteLabel({ betType: b.bet_type, selection: String(b.selection) })}</span><b>{b.stake} · {b.payout_multiplier}x</b></div>)}</div>}
    </Card>
  </>;
}

function rouletteLabel(b: { betType: string; selection: string }) {
  if (b.betType === 'NUMBER') return `Number ${b.selection}`;
  if (b.selection === 'LOW') return '1–18';
  if (b.selection === 'HIGH') return '19–36';
  return b.selection;
}

function LiveQuestionView({ state: s, block, busy, act, gameId }: { state: any; block: any; busy: boolean; act: (x: () => Promise<unknown>) => void; gameId: number }) {
  const submitted = block.selectedAnswer != null;
  const revealed = block.status === 'REVEALED' || block.status === 'SETTLED';
  return <div className="live-question-mobile">
    <div className="live-question-header"><div className="label muted">LIVE ROUND QUESTION</div><div className="pill status-pill open">{block.status}</div></div>
    <p className="live-question-instruction muted">{block.status === 'READY' ? 'Get ready.' : block.status === 'OPEN' && !submitted ? 'Choose one emoji.' : block.status === 'CLOSED' ? 'Answers are closed.' : revealed ? 'Result revealed.' : ''}</p>
    <div className="emoji-answer-grid">
      {QUESTION_EMOJIS.map((emoji, index) => {
        const selected = block.selectedAnswer === index;
        const resultClass = revealed && selected ? block.isCorrect ? 'correct' : 'incorrect' : '';
        return <button key={emoji} className={`emoji-answer ${selected ? 'selected' : ''} ${resultClass}`} disabled={busy || block.status !== 'OPEN' || submitted} onClick={() => act(() => mutation('/api/submit-round-answer', { gameId, blockId: block.id, selectedAnswer: index }))}><span>{emoji}</span>{selected && <small>{revealed ? block.isCorrect ? 'CORRECT' : 'YOUR ANSWER' : 'LOCKED'}</small>}</button>;
      })}
    </div>
    {submitted && !revealed && <Card className="answer-locked"><b>ANSWER LOCKED</b><span>Your selection cannot be changed.</span></Card>}
    {revealed && <Card className={block.isCorrect ? 'answer-correct' : 'answer-wrong'}><b>{block.isCorrect ? 'CORRECT' : 'NOT THIS TIME'}</b><span>{block.isCorrect && block.rewardCoins > 0 ? `+${block.rewardCoins} coins credited automatically.` : block.isCorrect ? 'Correct answer.' : 'No reward on this question.'}</span></Card>}
    <div className="live-question-wallet"><CoinIcon size={18} /> {s.player.balance} available</div>
  </div>;
}

/**
 * The slotmachine controller.
 *
 * Deliberately shows no reels. The phone's whole job is choosing a stake and a number of
 * spins, committing that series, and then firing spins — the machine itself is on the
 * Big Screen, and this player is meant to be looking up at it.
 *
 * Two states: before the series is locked the stake and spin count are editable and the
 * total is shown; after it is locked they are fixed and only SPIN remains, until the
 * last spin is used and a new series can be started.
 */
function SlotControllerView({ state: s, slot, busy, act, gameId }: { state: any; slot: any; busy: boolean; act: (x: () => Promise<unknown>) => void; gameId: number }) {
  const series = slot.series;
  const [stakePerSpin, setStakePerSpin] = useState(5);
  const [spins, setSpins] = useState(() => Math.min(5, slot.maxSpins));
  const [lockKey, setLockKey] = useState(() => crypto.randomUUID());
  const [spinKey, setSpinKey] = useState(() => crypto.randomUUID());

  // A fresh key per series, so retrying a lock is idempotent but a genuinely new series
  // is never mistaken for a replay of the previous one.
  useEffect(() => { setLockKey(crypto.randomUUID()); }, [slot.blockId, series?.id]);
  // A fresh key per remaining-spin count: the same key would be treated as a replay and
  // return the previous spin instead of taking a new one.
  useEffect(() => { setSpinKey(crypto.randomUUID()); }, [series?.id, series?.spinsRemaining]);

  const affordableSpins = stakePerSpin > 0 ? Math.floor(s.player.balance / stakePerSpin) : 0;
  const maxSpins = Math.max(0, Math.min(slot.maxSpins, affordableSpins));
  useEffect(() => { setSpins(current => Math.max(1, Math.min(current, maxSpins || 1))); }, [maxSpins]);
  const totalStake = stakePerSpin * spins;

  const lastSpin = series?.lastSpin || slot.lastSeries?.lastSpin || null;
  const spinning = lastSpin?.status === 'SPINNING';
  const canLock = !busy && slot.configValid && slot.allowed && maxSpins > 0 && spins >= 1 && spins <= maxSpins && totalStake <= s.player.balance;

  return <div className="slot-mobile">
    <div className="slot-mobile-header">
      <div className="label muted">SLOTMACHINE</div>
      <span className={`pill status-pill ${series ? 'open' : 'neutral'}`}>{series ? 'SERIES LOCKED' : 'READY'}</span>
    </div>
    <h1 className="display slot-mobile-title">{slot.title}</h1>
    {slot.instructions && <p className="muted slot-mobile-instructions">{slot.instructions}</p>}
    <p className="muted slot-mobile-watch">Watch the reels on the big screen — this is your controller.</p>

    {!slot.allowed
      ? <Card><b>You are not taking part in this slotmachine.</b><span className="muted">The host chose which players play this one.</span></Card>
      : !slot.configValid
        ? <Card><b>The slotmachine is not ready yet.</b><span className="muted">{slot.configReason || 'The host is still setting it up.'}</span></Card>
        : series
          ? <>
            <Card className="slot-locked-card">
              <div className="slot-locked-title">INZET VASTGEZET</div>
              <div className="slot-locked-grid">
                <span>Stake per spin</span><b><CoinIcon size={16} /> {series.stakePerSpin}</b>
                <span>Spins remaining</span><b>{series.spinsRemaining} of {series.totalSpins}</b>
                <span>Total committed</span><b><CoinIcon size={16} /> {series.totalStake}</b>
              </div>
            </Card>
            <button
              className="btn btn-primary slot-spin-btn"
              disabled={busy || spinning || series.spinsRemaining <= 0}
              onClick={() => act(async () => {
                await mutation('/api/slot-spin', { gameId, seriesId: series.id }, true, spinKey);
                setSpinKey(crypto.randomUUID());
              })}
            >{spinning ? 'SPINNING…' : `SPIN · ${series.spinsRemaining} LEFT`}</button>
            <SlotLastSpin spin={lastSpin} />
          </>
          : <>
            {slot.lastSeries && <Card className="slot-series-done">
              <b>SERIES FINISHED</b>
              <span className="muted">{slot.lastSeries.status === 'CANCELLED' ? 'Unused spins were refunded.' : 'All spins used — lock a new series to keep playing.'}</span>
            </Card>}
            <Card className="slot-setup-card">
              <label className="slot-field">
                <span className="label muted">INZET PER SPIN</span>
                <div className="slot-stake-picker">
                  {[1, 5, 10, 25].map(value => <button key={value} className={`chip ${stakePerSpin === value ? 'selected' : ''}`} disabled={value > s.player.balance} onClick={() => setStakePerSpin(value)}>{value}</button>)}
                  <input className="field slot-stake-input" type="number" min={1} max={Math.max(1, s.player.balance)} value={stakePerSpin} onChange={e => setStakePerSpin(Math.max(1, Number(e.target.value) || 1))} />
                </div>
              </label>

              <label className="slot-field">
                <span className="label muted">AANTAL SPINS · MAX {slot.maxSpins}</span>
                <div className="slot-spin-picker">
                  <button className="btn btn-secondary btn-compact" disabled={spins <= 1} onClick={() => setSpins(x => Math.max(1, x - 1))}>−</button>
                  <b className="slot-spin-count">{spins}</b>
                  <button className="btn btn-secondary btn-compact" disabled={spins >= maxSpins} onClick={() => setSpins(x => Math.min(maxSpins, x + 1))}>+</button>
                </div>
                <input className="stake-range" type="range" min={1} max={Math.max(1, maxSpins)} value={Math.min(spins, Math.max(1, maxSpins))} onChange={e => setSpins(Number(e.target.value))} />
              </label>

              <div className="slot-total-card">
                <span>TOTALE INZET</span>
                <strong><CoinIcon size={22} /> {totalStake}</strong>
                <em className="muted">{s.player.balance} available</em>
              </div>

              <button className="btn btn-primary btn-full" disabled={!canLock} onClick={() => act(() => mutation('/api/slot-lock-series', { gameId, blockId: slot.blockId, stakePerSpin, spins }, true, lockKey))}>
                INZET VASTZETTEN
              </button>
              {maxSpins === 0 && <p className="muted microcopy">Your wallet does not cover a spin at this stake — lower the stake per spin.</p>}
              {maxSpins > 0 && <p className="muted microcopy">Once locked, the stake and spin count cannot be changed. Unused spins are refunded if the host moves on.</p>}
            </Card>
            <SlotLastSpin spin={lastSpin} />
          </>}

    <div className="live-question-wallet"><CoinIcon size={18} /> {s.player.balance} available</div>
  </div>;
}

/**
 * The last outcome, named. Withheld by the server until the reels have landed.
 *
 * The phone gets the category — "2 dezelfde naast elkaar" — and never the field itself:
 * the 3x3 belongs on the projector, which is where the player should be looking.
 */
function SlotLastSpin({ spin }: { spin: any }) {
  if (!spin) return null;
  if (spin.status !== 'RESULT') return <Card className="slot-last-spin"><b>SPINNING…</b><span className="muted">Look at the big screen.</span></Card>;
  const won = Number(spin.payout) > 0;
  return <Card className={`slot-last-spin ${won ? 'is-win' : ''}`}>
    <b className="slot-last-outcome">{spin.outcome}</b>
    <span>{won ? `+${spin.payout} coins at ${Number(spin.payoutMultiplier).toFixed(2).replace(/\.?0+$/, '')}x` : 'Geen winst — no payout on this spin'}</span>
  </Card>;
}

/**
 * Pak een Zes on the phone: predict, then take your turn.
 *
 * Two phases, both driven by the server's status. During PREDICTING the player names
 * four people — the same person may be named more than once, and naming yourself is
 * allowed, so the four fields are independent and nothing is filtered out. During
 * DRAWING there is one big button, enabled only when the server says it is your turn.
 *
 * The phone never sees the deck or the card before the projector does.
 */
function PakEenZesView({ state: s, game, busy, act, gameId }: { state: any; game: any; busy: boolean; act: (x: () => Promise<unknown>) => void; gameId: number }) {
  const players: Array<{ id: number; name: string }> = game.players || [];
  // Start from a saved prediction if there is one, so re-opening shows what was sent.
  const [picks, setPicks] = useState<Array<number | ''>>(() =>
    game.myPicks?.length === 4 ? [...game.myPicks] : ['', '', '', '']);
  const [drawKey, setDrawKey] = useState(() => crypto.randomUUID());
  // A fresh key per draw count: reusing one would be treated as a replay and hand back
  // the previous card instead of taking a new one.
  useEffect(() => { setDrawKey(crypto.randomUUID()); }, [game.blockId, game.drawnCount, game.status]);

  const complete = picks.every(p => p !== '');
  const setPick = (index: number, value: string) =>
    setPicks(current => current.map((p, i) => i === index ? (value === '' ? '' : Number(value)) : p));

  return <div className="pez-mobile">
    <div className="pez-mobile-header">
      <div className="label muted">PAK EEN ZES</div>
      <span className={`pill status-pill ${game.drawing ? 'open' : game.predicting ? 'warning' : 'neutral'}`}>
        {game.predicting ? 'VOORSPELLEN' : game.drawing ? 'KAARTEN' : game.finished ? 'KLAAR' : 'WACHTEN'}
      </span>
    </div>
    <h1 className="display pez-mobile-title">{game.title}</h1>
    {game.instructions && <p className="muted pez-mobile-instructions">{game.instructions}</p>}

    {game.status === 'READY' && <Card><b>Nog even wachten.</b><span className="muted">De host opent zo de voorspellingen.</span></Card>}

    {game.predicting && <>
      <Card className="pez-predict-card">
        <div className="display pez-question">Wie trekken volgens jou een zes?</div>
        <p className="muted microcopy">Je mag dezelfde speler meerdere keren kiezen, en jezelf ook.</p>
        {[0, 1, 2, 3].map(index => <label className="pez-pick" key={index}>
          <span className="pez-pick-number">{index + 1}</span>
          <select className="field" value={picks[index]} onChange={e => setPick(index, e.target.value)}>
            <option value="">Kies speler</option>
            {players.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}
          </select>
        </label>)}
        <button
          className="btn btn-primary btn-full"
          disabled={busy || !complete}
          onClick={() => act(() => mutation('/api/pak-een-zes-predict', { gameId, blockId: game.blockId, picks }))}
        >VOORSPELLING OPSLAAN</button>
      </Card>
      {game.hasPredicted && <Card className="pez-saved"><b>✓ VOORSPELLING OPGESLAGEN</b><span className="muted">Je kunt hem nog aanpassen tot de host de voorspellingen sluit.</span></Card>}
    </>}

    {game.status === 'LOCKED' && <Card>
      <b>Voorspellingen gesloten.</b>
      <span className="muted">{game.hasPredicted ? 'Jouw voorspelling is opgeslagen.' : 'Je hebt deze ronde niet voorspeld.'}</span>
    </Card>}

    {game.drawing && <>
      {game.isMyTurn
        ? <>
          <Card className="pez-your-turn"><b>JIJ BENT AAN DE BEURT</b><span className="muted">Kijk naar het grote scherm.</span></Card>
          <button
            className="btn btn-primary pez-draw-btn"
            disabled={busy}
            onClick={() => act(async () => {
              await mutation('/api/pak-een-zes-draw', { gameId, blockId: game.blockId }, true, drawKey);
              setDrawKey(crypto.randomUUID());
            })}
          >{busy ? 'PAKKEN…' : 'KAART PAKKEN'}</button>
        </>
        : <Card className="pez-waiting">
          <div className="label muted">AAN DE BEURT</div>
          <b className="pez-waiting-name">{game.currentPlayer ? game.currentPlayer.name : '—'}</b>
          <span className="muted">Wachten op je beurt.</span>
        </Card>}
    </>}

    {game.finished && <Card className="pez-saved"><b>ALLE VIER DE ZESSEN ZIJN GEVONDEN</b><span className="muted">Bekijk het overzicht op het grote scherm.</span></Card>}

    {game.turnOrder?.length > 0 && game.drawing && <Card>
      <div className="label muted">SPEELVOLGORDE</div>
      <div className="pez-order">
        {game.turnOrder.map((player: any) => <span
          key={player.id}
          className={`pez-order-name ${game.currentPlayer?.id === player.id ? 'is-current' : ''}`}
        >{player.name}</span>)}
      </div>
    </Card>}
  </div>;
}

function Ledger({ state: s }: { state: any }) {
  return <Card><div className="label muted">RECENT LEDGER</div>{s.recentLedger.length === 0 ? <p className="muted">No transactions yet.</p> : s.recentLedger.map((x: any) => <div className="ledger-line" key={x.id}><span>{x.description}</span><b className={x.amount >= 0 ? 'pos' : 'neg'}>{x.amount > 0 ? '+' : ''}{x.amount}</b></div>)}</Card>;
}

function Back({ go }: { go: (x?: string) => void }) { return <button className="btn btn-secondary back-button" onClick={() => go()}>← HOME</button>; }

function useRemaining(closesAt?: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, []);
  return closesAt ? Math.max(0, new Date(closesAt).getTime() - now) : 0;
}
function LiveCountdown({ closesAt }: { closesAt?: string | null }) {
  const remaining = useRemaining(closesAt);
  const seconds = Math.ceil(remaining / 1000);
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>;
}

function useFirstLandingBalance(gameId: number, playerId: number, startingBalance: number, currentBalance: number) {
  const key = `mm-balance-intro:${gameId}:${playerId}`;
  const [shouldAnimate] = useState(() => typeof window !== 'undefined' && !sessionStorage.getItem(key));
  const firstTarget = useRef(startingBalance);
  const [value, setValue] = useState(shouldAnimate ? 0 : currentBalance);
  const [done, setDone] = useState(!shouldAnimate);
  useEffect(() => {
    if (shouldAnimate) sessionStorage.setItem(key, '1');
  }, [key, shouldAnimate]);
  useEffect(() => {
    if (done) { setValue(currentBalance); return; }
    const target = firstTarget.current;
    const start = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, (time - start) / 1100);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick); else setDone(true);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [done, currentBalance]);
  return done ? currentBalance : value;
}
