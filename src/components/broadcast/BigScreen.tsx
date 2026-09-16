import { useGamePolling } from '../../hooks/useGamePolling';
import { RouletteTable, type RouletteMarker } from '../shared/RouletteTable';
import { RouletteWheel } from '../shared/RouletteWheel';
import { CoinIcon } from '../shared/CoinIcon';
import { PlayerValueGraph } from '../shared/PlayerValueGraph';
import { SlotReels } from '../shared/SlotReels';
import { CardDeck, PlayingCard } from '../shared/PlayingCard';

const QUESTION_EMOJIS = ['🍆', '🌽', '🍑', '😳'] as const;
const money = (n: number) => new Intl.NumberFormat().format(n);
// Must match SLOT_SPIN_MS in netlify/lib/slotmachine.ts: the server flips a spin from
// SPINNING to RESULT after that window, and the reels must have landed by then.
const SLOT_SPIN_MS = 3200;

export function BigScreen({ gameId }: { gameId: number }) {
  const { data: s, error } = useGamePolling<any>(gameId, 'screen', `/api/screen-state?gameId=${gameId}`);
  if (!s) return <div className="screen-loading">{error ? 'LIVE CONNECTION INTERRUPTED' : 'MARKET MAYHEM'}</div>;
  if (s.mode === 'ROUND_BLOCK' && s.block) return <BlockScene block={s.block} round={s.round} />;
  if (s.mode === 'PREDICTIONS_OPEN' && s.prediction) return <PredictionScene p={s.prediction} phase="OPEN" />;
  if (s.mode === 'PREDICTION_LOCKED' && s.prediction) return <PredictionScene p={s.prediction} phase="LOCKED" />;
  if (s.mode === 'PREDICTION_RESULT' && s.prediction) return <PredictionScene p={s.prediction} phase="RESULT" />;
  if (s.mode === 'ROULETTE') return <RouletteScene roulette={s.roulette} round={s.round} block={s.block} />;
  if (s.mode === 'SLOTMACHINE') return <SlotScene slot={s.slotmachine} round={s.round} block={s.block} />;
  if (s.mode === 'PAK_EEN_ZES') return <PakEenZesScene game={s.pakEenZes} round={s.round} block={s.block} />;
  if (s.mode === 'FOTORONDE') return <PhotoRoundScene photo={s.photoRound} round={s.round} block={s.block} />;
  return <Dashboard s={s} error={error} />;
}

function Dashboard({ s, error }: { s: any; error: string }) {
  return <div className="exchange-screen">
    <header className="exchange-header">
      <div><div className="label muted">MARKET MAYHEM · LIVE EXCHANGE</div><div className="display exchange-title">{s.round ? `R${String(s.round.number).padStart(2, '0')} · ${s.round.title}` : s.game.name}</div></div>
      <div className="screen-stats"><Stat label="MARKETS OPEN" value={s.marketsOpen} /><Stat label="TOTAL COINS IN PLAY" value={money(s.totalCoinsInPlay)} coin /></div>
    </header>
    <div className="exchange-dashboard-grid">
      <section className="exchange-panel graph-panel">
        <div className="exchange-panel-title"><div><div className="label muted">PLAYER VALUE · ECONOMIC CHRONOLOGY</div><div className="display panel-title">LIVE VALUE GRAPH</div></div></div>
        <PlayerValueGraph players={s.leaderboard} />
      </section>
      <aside className="exchange-panel results-panel">
        <div className="label muted">LATEST RESOLVED MARKETS</div>
        <h2 className="display panel-title">Prediction results</h2>
        {s.recentPredictionResults.length === 0 ? <div className="dashboard-empty">No settled predictions yet.</div> : <div className="result-stack">{s.recentPredictionResults.map((p: any) => <div className={`prediction-result-row result-${String(p.result).toLowerCase()}`} key={p.id}><div><span className="label">PREDICTION #{p.number}</span><p>{p.question}</p></div><div className="result-side">{p.result}</div></div>)}</div>}
        <div className="market-values market-values-vertical">{s.leaderboard.map((p: any) => <ValueChip key={p.id} p={p} />)}</div>
      </aside>
    </div>
    <Ticker items={s.ticker} />
    {error && <div className="screen-error">LIVE CONNECTION INTERRUPTED</div>}
  </div>;
}

function ValueChip({ p }: { p: any }) {
  const base = Number(p.starting_balance), current = Number(p.current_balance);
  const pct = base > 0 ? Math.round(((current - base) / base) * 100) : null;
  const up = pct != null && pct >= 0;
  return <div className="value-chip"><span><i style={{ background: p.public_color }} />{String(p.display_name).toUpperCase()}</span><b>{current}</b><em className={pct == null ? 'muted' : up ? 'pos' : 'neg'}>{pct == null ? '—' : `${up ? '▲' : '▼'} ${pct > 0 ? '+' : ''}${pct}%`}</em></div>;
}

function Ticker({ items }: { items: any[] }) {
  if (!items.length) return <div className="ticker"><div className="ticker-track"><span className="display">NO TRANSACTIONS YET · MARKET MAYHEM</span></div></div>;
  const labels = items.map(t => {
    const name = String(t.display_name).toUpperCase();
    const amount = `${t.amount > 0 ? '+' : ''}${t.amount}`;
    if (t.transaction_type === 'PREDICTION_DEPOSIT') return `${name} ${amount} AVAILABLE · PREDICTION #${t.prediction_number} DEPOSIT LOCKED`;
    if (t.transaction_type === 'ROULETTE_STAKE') return `${name} ${amount} AVAILABLE · ROULETTE #${t.roulette_game_id} CHIP LOCKED`;
    const context = t.prediction_number ? `PREDICTION #${t.prediction_number}` : t.roulette_game_id ? `ROULETTE #${t.roulette_game_id}` : t.round_number ? `ROUND ${String(t.round_number).padStart(2, '0')}` : String(t.description).toUpperCase();
    return `${name} ${amount} · ${context}`;
  });
  return <div className="ticker"><div className="ticker-track">{[...labels, ...labels].map((x, i) => <span className="display" key={i}>{x}</span>)}</div></div>;
}

const mediaUrl = (key: string) => `/api/block-media?key=${encodeURIComponent(key)}`;

function BlockScene({ block, round }: { block: any; round: any }) {
  if (block.type === 'DUOLINGO_QUESTION') return <DuolingoScene block={block} round={round} />;
  if (block.type === 'PICTURE') return <PictureScene block={block} round={round} />;
  if (block.type === 'MUSIC') return <MusicScene block={block} round={round} />;
  const kicker = ({ QUESTION: 'QUESTION', BUZZER: 'BUZZER ROUND', WAGER: 'WAGER ROUND' } as any)[block.type] || 'ROUND NOTE';
  const question = block.type !== 'TEXT';
  return <Scene className={question ? 'question-scene' : 'text-scene'}><div className="scene-eyebrow">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'ROUND CONTENT'}</div><div className="scene-kicker">{kicker}</div>{block.title && <h1>{block.title}</h1>}{block.payload?.body && <p className="scene-body">{block.payload.body}</p>}{block.payload?.correctAnswer && <div className="scene-reveal">{block.payload.correctAnswer}</div>}</Scene>;
}

// The title is the answer, so the server withholds it until reveal — which is why this
// renders whatever it was given rather than deciding for itself.
function PictureScene({ block, round }: { block: any; round: any }) {
  return <Scene className="picture-scene">
    <div className="scene-eyebrow">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'PICTURE ROUND'}</div>
    <div className="scene-kicker">WHAT IS THIS?</div>
    {block.payload?.imageKey
      ? <img className="picture-scene-image" src={mediaUrl(block.payload.imageKey)} alt="" />
      : <div className="scene-body">No image on this round yet.</div>}
    {block.title && <div className="scene-reveal">{block.title}</div>}
  </Scene>;
}

function MusicScene({ block, round }: { block: any; round: any }) {
  return <Scene className="music-scene">
    <div className="scene-eyebrow">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'MUSIC ROUND'}</div>
    <div className="scene-kicker">NAME THAT SONG</div>
    <div className="music-scene-art" aria-hidden="true">♫</div>
    {block.payload?.audioKey
      // Controls are shown rather than autoplaying: browsers block unprompted audio, so
      // the host presses play once on the projector.
      ? <audio className="music-scene-player" controls preload="auto" src={mediaUrl(block.payload.audioKey)} />
      : <div className="scene-body">No audio on this round yet.</div>}
    {block.title && <div className="scene-reveal">{block.title}</div>}
  </Scene>;
}

function DuolingoScene({ block, round }: { block: any; round: any }) {
  const correct = block.payload?.correctAnswerIndex;
  const revealed = ['REVEALED', 'SETTLED'].includes(block.interactive_status) && Number.isInteger(Number(correct));
  const part = block.participation;

  // The context photo is its own step, and once the host calls for it the photo *is* the
  // slide — the question shrinks to a line above it and the answer to a line below, so
  // the room still knows what it is looking at and why.
  //
  // The server only sends contextImageKey from the reveal onwards, so this cannot render
  // early even if the flag were wrong.
  if (block.showingContextPhoto && block.payload?.contextImageKey) {
    return <div className="duo-screen duo-photo-screen">
      <div className="duo-topline"><span>{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'LIVE QUESTION'}</span><span className="pill">CONTEXT</span></div>
      <h2 className="duo-photo-question">{block.title}</h2>
      <img className="duo-photo-image" src={mediaUrl(block.payload.contextImageKey)} alt="" />
      {revealed && <div className="duo-photo-answer">🟢 {(block.payload?.answers || [])[Number(correct)] || ''}</div>}
    </div>;
  }

  return <div className="duo-screen">
    <div className="duo-topline">
      <span>{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'LIVE QUESTION'}</span>
      <span className="pill">{block.interactive_status || 'READY'} · {part ? `${part.answered}/${part.eligible}` : block.answer_count || 0} ANSWERS</span>
    </div>
    <h1>{block.title}</h1>
    {block.payload?.body && <p className="duo-support">{block.payload.body}</p>}
    <div className="duo-answer-grid">{(block.payload?.answers || []).map((answer: string, index: number) => <div className={`duo-answer-card ${revealed && Number(correct) === index ? 'correct' : revealed ? 'dimmed' : ''}`} key={index}><span className="duo-emoji">{QUESTION_EMOJIS[index]}</span><b>{answer}</b>{revealed && Number(correct) === index && <small>CORRECT</small>}</div>)}</div>
    {revealed && <div className="duo-reveal-banner"><span>JUISTE ANTWOORD</span><b>🟢 {(block.payload?.answers || [])[Number(correct)] || ''}</b></div>}
    <div className="duo-footer">{block.interactive_status === 'OPEN' ? 'ANSWER NOW ON YOUR PHONE' : block.interactive_status === 'CLOSED' ? 'ANSWERS LOCKED' : revealed ? `CORRECT ANSWER REVEALED${Number(block.payload?.rewardCoins || 0) > 0 ? ` · +${block.payload.rewardCoins} COINS` : ''}` : 'GET READY'}</div>
  </div>;
}

function PredictionScene({ p, phase }: { p: any; phase: 'OPEN' | 'LOCKED' | 'RESULT' }) {
  if (phase === 'RESULT') return <div className={`prediction-screen result-${String(p.result).toLowerCase()}`}><div className="scene-eyebrow">PREDICTION #{p.number} · RESOLVED</div><h1>{p.result} WINS</h1><p>{p.question}</p><div className="big-odds"><div className="yes"><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></div><div className="no"><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></div></div></div>;
  return <div className={`prediction-screen prediction-${phase.toLowerCase()}`}><div className="scene-eyebrow">PREDICTION #{p.number}</div><h1>{phase === 'OPEN' ? 'PREDICTION OPEN' : 'MARKET LOCKED'}</h1><p>{p.question}</p><div className="big-odds"><div className="yes"><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></div><div className="no"><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></div></div><div className="scene-footer">{phase === 'OPEN' ? 'PLACE YOUR BET ON YOUR PHONE' : 'NO MORE BETS · WAITING FOR RESULT'}</div></div>;
}

function RouletteScene({ roulette: r, round, block }: { roulette: any; round: any; block: any }) {
  const markers: RouletteMarker[] = (r?.public_bets || []).map((b: any) => ({ id: b.id, betType: b.betType, selection: String(b.selection), stake: Number(b.stake), displayName: b.displayName, color: b.color }));
  return <div className="roulette-screen">
    <div className="roulette-screen-header"><div><div className="label muted">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div><h1 className="display">{block?.title || 'ROULETTE'}</h1></div><div className="roulette-status"><span>{r?.status || 'READY'}</span><b>{markers.length} chips</b></div></div>
    {!r ? <div className="screen-center-message">ROULETTE READY</div> : r.status === 'CANCELLED' ? <div className="screen-center-message">ROULETTE CANCELLED<small>Active stakes refunded</small></div> : <div className="roulette-screen-grid"><RouletteWheel status={r.status} resultNumber={r.result_number} /><div className="roulette-board-wrap"><RouletteTable markers={markers} disabled compact={false} /><div className="roulette-board-caption">{r.status === 'OPEN' ? 'BETTING OPEN · CHIPS UPDATE LIVE' : r.status === 'LOCKED' ? 'BETS LOCKED' : r.status === 'SPINNING' ? 'SPINNING…' : r.result_number != null ? `RESULT · ${r.result_number}` : 'ROULETTE'}</div></div></div>}
  </div>;
}

/**
 * The slotmachine, on the projector.
 *
 * The only surface in the product that draws the field: phones are controllers and never
 * show it. Everything here presents a decision the backend already made and stored —
 * `currentSpin.grid` is the committed 3x3 field, `winCells` are the cells that form its
 * winning pattern, and `spinning` only says whether the animation window has elapsed.
 */
function SlotScene({ slot, round, block }: { slot: any; round: any; block: any }) {
  const spin = slot?.currentSpin || null;
  // While the reels are still turning the numbers below them would give the result
  // away — so the scene withholds them until the animation has landed, exactly as the
  // roulette wheel withholds its winning number.
  const spinning = Boolean(spin?.spinning);
  const revealed = Boolean(spin) && !spinning;
  const field = spin && Array.isArray(spin.grid) && spin.grid.length === 3 ? spin.grid : null;
  const turn = slot?.turn || null;
  // A player is "done" the moment their run is used up and the final spin has resolved —
  // that is when the projector hands over to the next player.
  const handingOver = Boolean(
    turn && !turn.spinning && turn.current && turn.current.spinsRemaining === 0,
  );

  return <div className="slot-screen">
    <div className="slot-screen-header">
      <div className="slot-screen-title">
        <div className="label muted">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div>
        <h1 className="display">{block?.title || 'SLOTMACHINE'}</h1>
      </div>
      {/* The turn, not the last spin: this stays put for the player's whole run so the
          room always knows who is up. Only the remaining count moves between spins. */}
      <div className="slot-screen-player">
        <span>{turn?.current ? `${String(turn.current.playerName || '').toUpperCase()} IS AAN DE BEURT` : 'WACHTEN OP EEN SPELER'}</span>
        <b>{turn?.current
          ? `${turn.current.spinsRemaining} VAN ${turn.current.totalSpins} SPINS OVER`
          : 'ZET JE REEKS VAST OP JE TELEFOON'}</b>
      </div>
    </div>

    {!slot?.configValid
      ? <div className="screen-center-message">SLOTMACHINE NOT CONFIGURED<small>{slot?.configReason || 'Finish the setup in Settings'}</small></div>
      : <>
        <SlotReels
          field={field}
          strip={slot.strip}
          winCells={revealed ? (spin.winCells || []) : []}
          spinning={spinning}
          spinMs={SLOT_SPIN_MS}
          spinId={spin?.id ?? null}
        />

        {/* The category is the headline: the payout belongs to the pattern, so naming
            the pattern is what explains the win to the room. */}
        <div className="slot-outcome-bar">
          <div className={`slot-outcome ${revealed && spin.payout > 0 ? 'is-win' : ''}`}>
            <span>UITKOMST</span>
            <b>{spinning ? '· · ·' : revealed ? spin.outcome : '—'}</b>
          </div>
          <SlotStat label="INZET PER SPIN" value={turn?.current ? turn.current.stakePerSpin : spin ? spin.stakePerSpin : '—'} coin />
          <SlotStat label="PAYOUT" value={spinning || !spin ? '—' : `${formatMultiplier(spin.payoutMultiplier)}x`} />
          <SlotStat label="GEWONNEN" value={spinning || !spin ? '—' : spin.payout} coin highlight={revealed && spin.payout > 0} />
          <SlotStat label="SPINS OVER" value={turn?.current ? turn.current.spinsRemaining : '—'} />
        </div>

        {/* Handing over is its own moment: the run is finished, so name who is next
            rather than leaving the last result up with no explanation. */}
        {handingOver && <div className="slot-handover">
          <b>{String(turn.current.playerName || '').toUpperCase()} IS KLAAR</b>
          <span>{turn.next
            ? `VOLGENDE SPELER: ${String(turn.next.playerName || '').toUpperCase()}`
            : 'ALLE SPELERS ZIJN KLAAR'}</span>
        </div>}

        <div className="slot-screen-footer">
          {spinning
            ? 'DRAAIT…'
            : handingOver
              ? turn.next ? 'DE VOLGENDE SPELER KAN BEGINNEN' : 'SLOTMACHINE AFGEROND'
              : revealed
                ? spin.payout > 0
                  ? `${String(spin.playerName).toUpperCase()} WINT ${spin.payout} COINS · ${String(spin.outcome).toUpperCase()}`
                  : `${String(spin.playerName).toUpperCase()} — GEEN WINST`
                : turn?.current
                  ? 'DRUK OP SPIN OP JE TELEFOON'
                  : 'ZET JE REEKS VAST OP JE TELEFOON'}
        </div>

        {/* Who is still waiting, so the room can see the running order. */}
        {(turn?.queue?.length ?? 0) > 1 && <div className="slot-queue">
          {turn.queue.map((entry: any) => <span
            key={entry.seriesId}
            className={`slot-queue-name ${turn.current?.seriesId === entry.seriesId ? 'is-current' : ''}`}
          >{entry.playerName} · {entry.spinsRemaining}</span>)}
        </div>}

        {slot.recentSpins.length > 0 && <div className="slot-history">
          {slot.recentSpins.map((previous: any) => <div className={`slot-history-row ${previous.payout > 0 ? 'is-win' : ''}`} key={previous.id}>
            <span>{String(previous.playerName).toUpperCase()}</span>
            <b>{previous.status === 'RESULT' ? previous.outcome : '· · ·'}</b>
            <em>{previous.status === 'RESULT' ? previous.payout > 0 ? `+${previous.payout}` : '—' : ''}</em>
          </div>)}
        </div>}
      </>}
  </div>;
}

function SlotStat({ label, value, coin = false, highlight = false }: { label: string; value: any; coin?: boolean; highlight?: boolean }) {
  return <div className={`slot-stat ${highlight ? 'is-win' : ''}`}>
    <span>{label}</span>
    <b>{coin && typeof value === 'number' && <CoinIcon size={22} />}{value}</b>
  </div>;
}

/** 3x rather than 3.000x — trailing zeros are noise at projector size. */
function formatMultiplier(value: number) {
  return Number(value).toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Pak een Zes, on the projector.
 *
 * Three faces of the same scene, driven entirely by the server's status: counting
 * predictions before the game, the deck and the turn during it, and the four sixes
 * afterwards. A six gets its own celebration because that is the moment the room is
 * waiting for.
 */
function PakEenZesScene({ game, round, block }: { game: any; round: any; block: any }) {
  const status = game?.status || 'READY';
  const last = game?.lastDraw || null;
  const finished = status === 'FINISHED';
  // The last card being a six is the celebration trigger — but only while the game runs,
  // so the final summary is not permanently flashing.
  const celebrating = Boolean(last?.isSix) && !finished;

  return <div className={`pez-screen ${celebrating ? 'is-celebrating' : ''}`}>
    <div className="pez-header">
      <div className="pez-title">
        <div className="label muted">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div>
        <h1 className="display">{block?.title || 'PAK EEN ZES'}</h1>
      </div>
      <div className="pez-status">
        <span>{PEZ_STATUS_LABELS[status] || status}</span>
        <b>{game ? `${game.sixesFound} / 4 ZESSEN` : 'NOG NIET GESTART'}</b>
      </div>
    </div>

    {status === 'READY' && <div className="screen-center-message">PAK EEN ZES<small>De host opent zo de voorspellingen</small></div>}

    {(status === 'PREDICTING' || status === 'LOCKED') && <div className="pez-predicting">
      <div className="pez-big-question">Wie trekken volgens jou een zes?</div>
      <div className="pez-prediction-count">
        <b>{game?.predictionCount ?? 0}</b>
        <span>van {game?.activePlayerCount ?? 0} spelers hebben voorspeld</span>
      </div>
      {game?.pointsPerCorrect > 0 && <div className="pez-points-note">
        ELKE JUISTE VOORSPELLING IS {game.pointsPerCorrect} PUNTEN WAARD
      </div>}
      <div className="pez-footer">
        {status === 'PREDICTING' ? 'VUL JE VOORSPELLING IN OP JE TELEFOON' : 'VOORSPELLINGEN GESLOTEN · DE HOST START HET SPEL'}
      </div>
    </div>}

    {status === 'DRAWING' && <div className="pez-playing">
      <div className="pez-turn">
        <div className="label muted">AAN DE BEURT</div>
        <div className="display pez-turn-name">{game?.currentPlayer ? String(game.currentPlayer.name).toUpperCase() : '—'}</div>
      </div>

      <div className="pez-table">
        <CardDeck cardsRemaining={game?.cardsRemaining ?? 52} drawing />
        <div className="pez-last">
          {last
            ? <>
              <PlayingCard rank={last.rank} suit={last.suit} six={last.isSix} />
              <div className="pez-last-who">{String(last.playerName).toUpperCase()}</div>
            </>
            : <div className="pez-last-empty">NOG GEEN KAART</div>}
        </div>
      </div>

      {celebrating && <div className="pez-six-banner">
        <b>ZES!</b>
        <span>{String(last.playerName).toUpperCase()} HEEFT EEN ZES GETROKKEN</span>
      </div>}

      <div className="pez-meta">
        <PezStat label="KAARTEN GETROKKEN" value={`${game?.drawnCount ?? 0} / 52`} />
        <PezStat label="ZESSEN GEVONDEN" value={`${game?.sixesFound ?? 0} / 4`} />
        <PezStat label="LAATSTE KAART" value={last ? last.label : '—'} />
      </div>

      {!celebrating && <div className="pez-footer">DRUK OP KAART PAKKEN OP JE TELEFOON</div>}
    </div>}

    {finished && <div className="pez-finished">
      <div className="display pez-finished-title">ALLE VIER DE ZESSEN GEVONDEN</div>
      <div className="pez-six-list">
        {(game?.sixes || []).map((six: any) => <div className="pez-six-row" key={six.id}>
          <PlayingCard rank={six.rank} suit={six.suit} size="small" six />
          <span>{String(six.playerName).toUpperCase()}</span>
          <em>trek {six.drawNumber}</em>
        </div>)}
      </div>
      {/* Only the players who scored: a list of zeros tells the room nothing. */}
      {(game?.results?.length ?? 0) > 0 && <div className="pez-scoreboard">
        <div className="label muted">JUISTE VOORSPELLINGEN</div>
        {game.results.map((result: any) => <div className="pez-score-row" key={result.playerId}>
          <span>{String(result.playerName).toUpperCase()}</span>
          <b>{result.correct} goed</b>
          <em>+{result.points}</em>
        </div>)}
      </div>}

      <div className="pez-footer">{game?.drawnCount ?? 0} kaarten getrokken</div>
    </div>}
  </div>;
}

/**
 * Fotoronde, on the projector.
 *
 * Two faces. While submissions are open it shows progress per subject, which is the one
 * thing the room wants to know — who still owes a photo. While judging, the Admin puts a
 * single photo up and it fills the screen with its team's name, because that is what
 * everyone is looking at and arguing about.
 */
function PhotoRoundScene({ photo, round, block }: { photo: any; round: any; block: any }) {
  const shown = photo?.shown || null;
  const status = photo?.status || 'DRAFT';

  return <div className="photo-screen">
    <div className="photo-screen-header">
      <div className="photo-screen-title">
        <div className="label muted">{round ? `ROUND ${String(round.number).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div>
        <h1 className="display">{block?.title || 'FOTORONDE'}</h1>
      </div>
      <div className="photo-screen-status">
        <span>{PHOTO_STATUS_LABELS[status] || status}</span>
        <b>{photo?.submissionCount ?? 0} FOTO&apos;S · {photo?.teamCount ?? 0} TEAMS</b>
      </div>
    </div>

    {/* One photo, judged. The team name is the headline — the photo speaks for itself. */}
    {shown
      ? <div className="photo-stage">
        <div className="photo-stage-subject">{String(shown.subjectLabel || '').toUpperCase()}</div>
        <img className="photo-stage-image" src={`/api/block-media?key=${encodeURIComponent(shown.mediaKey)}`} alt="" />
        <div className="photo-stage-team">
          <b>{String(shown.teamName).toUpperCase()}</b>
          {shown.creditsAwarded != null && <span className="photo-stage-credits">{shown.creditsAwarded} CREDITS</span>}
        </div>
      </div>
      : <div className="photo-progress">
        {(photo?.subjects || []).map((subject: any) => <div className="photo-progress-row" key={subject.key}>
          <span>{subject.label}</span>
          <b>{subject.submittedCount} / {photo?.teamCount ?? 0}</b>
        </div>)}
        {(photo?.subjects?.length ?? 0) === 0 && <div className="screen-center-message">FOTORONDE</div>}
      </div>}

    <div className="photo-screen-footer">
      {status === 'OPEN'
        ? 'UPLOAD JE FOTO\u2019S OP JE TELEFOON'
        : status === 'DRAFT'
          ? 'DE HOST OPENT ZO HET INZENDEN'
          : shown
            ? 'BEOORDELING'
            : 'INZENDEN GESLOTEN'}
    </div>

    {/* The standings, once credits have started landing. */}
    {!shown && (photo?.teamTotals?.length ?? 0) > 0 && photo.teamTotals.some((t: any) => t.credits > 0) && <div className="photo-standings">
      {photo.teamTotals.filter((t: any) => t.credits > 0).map((team: any) => <div className="photo-standing" key={team.groupId}>
        <span>{String(team.name).toUpperCase()}</span>
        <b>{team.credits}</b>
      </div>)}
    </div>}
  </div>;
}

const PHOTO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'NOG NIET OPEN',
  OPEN: 'INZENDEN OPEN',
  CLOSED: 'BEOORDELING',
  COMPLETED: 'AFGEROND',
};

const PEZ_STATUS_LABELS: Record<string, string> = {
  READY: 'KLAAR OM TE STARTEN',
  PREDICTING: 'VOORSPELLEN',
  LOCKED: 'VOORSPELLINGEN GESLOTEN',
  DRAWING: 'KAARTEN TREKKEN',
  FINISHED: 'AFGEROND',
  CANCELLED: 'GESTOPT',
};

function PezStat({ label, value }: { label: string; value: any }) {
  return <div className="pez-stat"><span>{label}</span><b>{value}</b></div>;
}

function Scene({ children, className = '' }: { children: any; className?: string }) { return <div className={`screen-scene ${className}`}>{children}</div>; }
function Stat({ label, value, coin = false }: { label: string; value: any; coin?: boolean }) { return <div className="screen-stat"><div className="label muted">{label}</div><div className="display">{coin && <CoinIcon size={24} />}{value}</div></div>; }
