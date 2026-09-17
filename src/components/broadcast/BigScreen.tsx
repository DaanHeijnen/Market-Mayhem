import { useEffect, useState } from 'react';
import { useGamePolling } from '../../hooks/useGamePolling';
import { RouletteTable, type RouletteMarker } from '../shared/RouletteTable';
import { RouletteWheel } from '../shared/RouletteWheel';
import { CoinIcon } from '../shared/CoinIcon';
import { PlayerValueGraph } from '../shared/PlayerValueGraph';
import { SlotReels } from '../shared/SlotReels';
import { CardDeck, PlayingCard } from '../shared/PlayingCard';
import { useHeldReveal } from '../shared/useHeldReveal';
import { AuthoredText } from '../shared/AuthoredText';

const QUESTION_EMOJIS = ['🍆', '🌽', '🍑', '😳'] as const;
const money = (n: number) => new Intl.NumberFormat().format(n);
// Must match SLOT_SPIN_MS in netlify/lib/slotmachine.ts: the server flips a spin from
// SPINNING to RESULT after that window, and the reels must have landed by then.
const SLOT_SPIN_MS = 3200;

/**
 * One projector snapshot, drawn.
 *
 * Exported because the Admin's LIVE and NEXT panes render with this exact component, fed
 * the exact same public DTO — the live one polled from `/api/screen-state`, the next one
 * from `/api/next-screen-state`. There is no second rendering of a scene anywhere, so the
 * Admin cannot show the host something the room will not see.
 */
/**
 * One projector snapshot, drawn.
 *
 * Exported because the Admin's LIVE and NEXT panes render with this exact component, fed
 * the exact same public DTO — the live one polled from `/api/screen-state`, the next one
 * from `/api/next-screen-state`. There is no second rendering of a scene anywhere, so the
 * Admin cannot show the host something the room will not see.
 *
 * The dashboard is reached only when the mode actually *is* DASHBOARD. It used to be the
 * fallback for every unmatched case, which meant a scene whose payload failed to load —
 * a slide pointer at a deleted slide, a mode this build does not know — rendered as a
 * perfectly healthy-looking standings screen. A broken state that looks like a working one
 * is worse than an ugly error, so those now say what went wrong instead.
 */
export function ScreenRender({ s, error = '' }: { s: any; error?: string }) {
  if (!s) return <div className="screen-loading">{error ? 'LIVE CONNECTION INTERRUPTED' : 'MARKET MAYHEM'}</div>;
  if (s.mode === 'DASHBOARD') return <Dashboard s={s} error={error} />;
  if (s.mode === 'ROUND_INTRO' && s.roundIntro) return <RoundIntroScene intro={s.roundIntro} />;
  if (s.mode === 'QUIZ_QUESTION' && s.quizQuestion) return <QuizScene question={s.quizQuestion} round={s.round} />;
  if (s.mode === 'SLIDE' && s.slide) return <SlideScene slide={s.slide} round={s.round} />;
  if (s.mode === 'PUBQUIZ_QUESTION' && s.pubquizQuestion) return <PubquizScene question={s.pubquizQuestion} round={s.round} />;
  if (s.mode === 'PREDICTIONS_OPEN' && s.prediction) return <PredictionScene p={s.prediction} phase="OPEN" />;
  if (s.mode === 'PREDICTION_LOCKED' && s.prediction) return <PredictionScene p={s.prediction} phase="LOCKED" />;
  if (s.mode === 'PREDICTION_RESULT' && s.prediction) return <PredictionScene p={s.prediction} phase="RESULT" />;
  if (s.mode === 'ROULETTE') return <RouletteScene roulette={s.roulette} round={s.round} />;
  if (s.mode === 'SLOTMACHINE') return <SlotScene slot={s.slotmachine} round={s.round} />;
  if (s.mode === 'PAK_EEN_ZES') return <PakEenZesScene game={s.pakEenZes} round={s.round} />;
  if (s.mode === 'FOTORONDE') return <PhotoRoundScene photo={s.photoRound} round={s.round} />;
  // Named rather than swallowed: the host can see which scene failed to arrive.
  return <Scene className="screen-unavailable">
    <div className="scene-eyebrow">{s.mode}</div>
    <h1>SCENE NIET BESCHIKBAAR</h1>
    <p className="scene-body">De projector wijst naar iets dat niet geladen kon worden. Kies iets anders in het Control Center.</p>
  </Scene>;
}

/**
 * The round's title card.
 *
 * No content of its own: it is the round row — its title, its description, the
 * instructions the host wrote for the players — given a moment on screen before the round
 * begins. That moment is the point. A round that opens on its first question gives the
 * room nothing to orient on and the host nowhere to stand while explaining it.
 */
function RoundIntroScene({ intro }: { intro: any }) {
  const meta: Record<string, string> = {
    LIVE_QUIZ: 'LIVE QUIZ', PRESENTATIE: 'PRESENTATIE', PUBQUIZ: 'PUBQUIZ',
    ROULETTE: 'ROULETTE', SLOTMACHINE: 'SLOTMACHINE', PAK_EEN_ZES: 'PAK EEN ZES', FOTORONDE: 'FOTORONDE',
  };
  return <Scene className={`round-intro-scene accent-${String(intro.type).toLowerCase()}`}>
    <div className="scene-eyebrow">ROUND {String(intro.sortOrder).padStart(2, '0')} · {meta[intro.type] || intro.type}</div>
    <h1 className="round-intro-title">{intro.title}</h1>
    <AuthoredText className="round-intro-description" text={intro.description} />
    {intro.itemCount > 0 && <div className="round-intro-count">{intro.itemCount} {intro.itemCount === 1 ? 'onderdeel' : 'onderdelen'}</div>}
    {/* Written for the players, so it belongs on the wall they are all looking at — with
        the paragraphs, blank lines and list items the host actually typed. */}
    <AuthoredText className="round-intro-instructions" text={intro.instructions} />
  </Scene>;
}

export function BigScreen({ gameId }: { gameId: number }) {
  const { data: s, error } = useGamePolling<any>(gameId, 'screen', `/api/screen-state?gameId=${gameId}`);
  return <ScreenRender s={s} error={error} />;
}

function Dashboard({ s, error }: { s: any; error: string }) {
  return <div className="exchange-screen">
    <header className="exchange-header">
      <div><div className="label muted">MARKET MAYHEM · LIVE EXCHANGE</div><div className="display exchange-title">{s.round ? `R${String(s.round.sortOrder).padStart(2, '0')} · ${s.round.title}` : s.game.name}</div></div>
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

/**
 * One presentation slide.
 *
 * The server sends a title only when it is public, so a picture or music slide whose
 * title is the answer arrives with `title: null` and `titleHidden: true` until the host
 * reveals. There is nothing here to "hide" — the secret was never sent.
 */
function SlideScene({ slide, round }: { slide: any; round: any }) {
  const eyebrow = round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'ROUND CONTENT';

  if (slide.mediaKind === 'IMAGE' && slide.mediaKey) {
    return <Scene className="picture-scene">
      <div className="scene-eyebrow">{eyebrow}</div>
      <img className="picture-scene-image" src={mediaUrl(slide.mediaKey)} alt="" />
      {/* The body belongs with the picture, not only on a text page. A theory question is
          a photo plus its answer options, and dropping the body here lost the options on
          exactly the questions that have an image. `white-space: pre-wrap` keeps
          "A. …\nB. …\nC. …" on three lines. */}
      <AuthoredText className="scene-body picture-scene-body" text={slide.body} />
      {slide.title && <div className="scene-reveal">{slide.title}</div>}
      {slide.revealText && <div className="scene-reveal">{slide.revealText}</div>}
    </Scene>;
  }

  if (slide.mediaKind === 'AUDIO' && slide.mediaKey) {
    return <Scene className="music-scene">
      <div className="scene-eyebrow">{eyebrow}</div>
      <div className="scene-kicker">MUSIC</div>
      <AuthoredText className="scene-body" text={slide.body} />
      {/* Controls are shown rather than autoplaying: browsers block unprompted audio, so
          an autoplay attempt would silently do nothing on the projector. */}
      <audio className="music-scene-player" controls preload="auto" src={mediaUrl(slide.mediaKey)} />
      {slide.title && <div className="scene-reveal">{slide.title}</div>}
      {slide.revealText && <div className="scene-reveal">{slide.revealText}</div>}
    </Scene>;
  }

  return <Scene className={slide.title ? 'question-scene' : 'text-scene'}>
    <div className="scene-eyebrow">{eyebrow}</div>
    {slide.titleHidden && <div className="scene-kicker">HIDDEN UNTIL REVEALED</div>}
    {slide.title && <h1>{slide.title}</h1>}
    <AuthoredText className="scene-body" text={slide.body} />
    {slide.revealText && <div className="scene-reveal">{slide.revealText}</div>}
  </Scene>;
}

/**
 * One live quiz question.
 *
 * Which options are correct arrives only from the reveal onwards — before that the option
 * objects simply have no `isCorrect` field — so this cannot leak the answer even if the
 * flag below were wrong. Same for the context photo: its key is absent until the host
 * asks for it, so an early render has no file to name.
 */
/**
 * One pubquiz question, on the projector.
 *
 * A presentation page that happens to be a question: the question is the headline, its
 * image sits with it from the start, and the answers are the page's body.
 *
 * Nothing here decides what may be shown. Before the reveal the options simply have no
 * `isCorrect` and no `count` — the server never put them on the wire — so this renders
 * whatever it was given and cannot leak an answer by getting a condition wrong.
 */
function PubquizScene({ question, round }: { question: any; round: any }) {
  const revealed = question.status === 'REVEALED';
  const correct = question.options.find((o: any) => o.isCorrect) || null;
  const part = question.participation;
  const topline = round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'PUBQUIZ';
  // The widest bar is the scale, so a unanimous room and a split one both read clearly.
  const most = revealed ? Math.max(1, ...question.options.map((o: any) => Number(o.count) || 0)) : 1;

  return <div className="duo-screen pubquiz-screen">
    <div className="duo-topline">
      <span>{topline}</span>
      <span className="pill">{question.status} · {part ? `${part.answered}/${part.eligible}` : 0} ANSWERS</span>
    </div>
    <h1>{question.question}</h1>
    <AuthoredText className="duo-support" text={question.body} />
    {question.mediaKey && <img className="pubquiz-image" src={mediaUrl(question.mediaKey)} alt="" />}

    <div className="duo-answer-grid">{question.options.map((option: any, index: number) => <div
      className={`duo-answer-card ${revealed && option.isCorrect ? 'correct' : revealed ? 'dimmed' : ''}`}
      key={option.id}
    >
      <span className="duo-emoji">{QUESTION_EMOJIS[index]}</span>
      <b>{option.text}</b>
      {/* Counts and correctness arrive together, at the reveal, or not at all — a tally
          before the answer is the answer. */}
      {revealed && <span className="pubquiz-tally">
        <span className="pubquiz-bar" style={{ width: `${Math.round((Number(option.count) || 0) / most * 100)}%` }} />
        <small>{option.count} {Number(option.count) === 1 ? 'speler' : 'spelers'}{option.isCorrect ? ' ✓' : ''}</small>
      </span>}
    </div>)}</div>

    {revealed && correct && <div className="duo-reveal-banner">
      <span>JUISTE ANTWOORD</span>
      <b>🟢 {correct.text}</b>
    </div>}
    <div className="duo-footer">{
      question.status === 'OPEN' ? 'ANSWER NOW ON YOUR PHONE'
        : question.status === 'CLOSED' ? 'ANSWERS LOCKED'
          : revealed ? `${question.correctCount} / ${part?.eligible ?? 0} CORRECT${question.points > 0 ? ` · +${question.points} POINTS` : ''}`
            : 'GET READY'
    }</div>
  </div>;
}

function QuizScene({ question, round }: { question: any; round: any }) {
  const revealed = ['REVEALED', 'SETTLED'].includes(question.status);
  const correct = question.options.filter((o: any) => o.isCorrect);
  const part = question.participation;
  const topline = round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'LIVE QUESTION';

  // The context photo is its own step, and once the host calls for it the photo *is* the
  // slide — the question shrinks to a line above it and the answer to a line below, so
  // the room still knows what it is looking at and why.
  if (question.showingContextPhoto && question.contextMediaKey) {
    return <div className="duo-screen duo-photo-screen">
      <div className="duo-topline"><span>{topline}</span><span className="pill">CONTEXT</span></div>
      <h2 className="duo-photo-question">{question.prompt}</h2>
      <img className="duo-photo-image" src={mediaUrl(question.contextMediaKey)} alt="" />
      {revealed && correct.length > 0 && <div className="duo-photo-answer">🟢 {correct.map((o: any) => o.text).join(' / ')}</div>}
    </div>;
  }

  return <div className="duo-screen">
    <div className="duo-topline">
      <span>{topline}</span>
      <span className="pill">{question.status || 'READY'} · {part ? `${part.answered}/${part.eligible}` : 0} ANSWERS</span>
    </div>
    <h1>{question.prompt}</h1>
    <AuthoredText className="duo-support" text={question.body} />
    <div className="duo-answer-grid">{question.options.map((option: any, index: number) => <div
      className={`duo-answer-card ${revealed && option.isCorrect ? 'correct' : revealed ? 'dimmed' : ''}`}
      key={option.id}
    >
      <span className="duo-emoji">{QUESTION_EMOJIS[index]}</span>
      <b>{option.text}</b>
      {revealed && option.isCorrect && <small>CORRECT</small>}
    </div>)}</div>
    {revealed && correct.length > 0 && <div className="duo-reveal-banner">
      <span>JUISTE ANTWOORD</span>
      <b>🟢 {correct.map((o: any) => o.text).join(' / ')}</b>
    </div>}
    <div className="duo-footer">{
      question.status === 'OPEN' ? 'ANSWER NOW ON YOUR PHONE'
        : question.status === 'CLOSED' ? 'ANSWERS LOCKED'
          : revealed ? `CORRECT ANSWER REVEALED${question.points > 0 ? ` · +${question.points} POINTS` : ''}`
            : 'GET READY'
    }</div>
  </div>;
}

function PredictionScene({ p, phase }: { p: any; phase: 'OPEN' | 'LOCKED' | 'RESULT' }) {
  if (phase === 'RESULT') return <div className={`prediction-screen result-${String(p.result).toLowerCase()}`}><div className="scene-eyebrow">PREDICTION #{p.number} · RESOLVED</div><h1>{p.result} WINS</h1><p>{p.question}</p><div className="big-odds"><div className="yes"><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></div><div className="no"><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></div></div></div>;
  return <div className={`prediction-screen prediction-${phase.toLowerCase()}`}><div className="scene-eyebrow">PREDICTION #{p.number}</div><h1>{phase === 'OPEN' ? 'PREDICTION OPEN' : 'MARKET LOCKED'}</h1><p>{p.question}</p><div className="big-odds"><div className="yes"><span>YES</span><b>@ {p.yesOdds.toFixed(2)}x</b></div><div className="no"><span>NO</span><b>@ {p.noOdds.toFixed(2)}x</b></div></div><div className="scene-footer">{phase === 'OPEN' ? 'PLACE YOUR BET ON YOUR PHONE' : 'NO MORE BETS · WAITING FOR RESULT'}</div></div>;
}

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const pocketColour = (n: number) => (n === 0 ? 'GROEN' : RED_NUMBERS.has(n) ? 'ROOD' : 'ZWART');

// Must match ROULETTE_SPIN_MS in netlify/lib/roulette.ts.
const ROULETTE_SPIN_MS = 5500;

function RouletteScene({ roulette: r, round }: { roulette: any; round: any }) {
  const markers: RouletteMarker[] = (r?.publicBets || []).map((b: any) => ({ id: b.id, betType: b.betType, selection: String(b.selection), stake: Number(b.stake), displayName: b.displayName, color: b.color }));
  const runLabel = r?.runNumber ? `SPIN ${r.runNumber}` : 'ROULETTE';
  // The wheel gets the same guarantee the reels do: a run that settles between two polls
  // still spins before the room is shown what it cost them.
  const held = useHeldReveal(r?.spunAt ?? null, ROULETTE_SPIN_MS, Boolean(r?.spunAt));
  const spinning = r?.status === 'SPINNING' || held;
  return <div className="roulette-screen">
    <div className="roulette-screen-header"><div><div className="label muted">{round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div><h1 className="display">{round?.title || 'ROULETTE'}</h1></div><div className="roulette-status"><span>{r?.status || 'READY'}</span><b>{runLabel}</b></div></div>
    {!r ? <div className="screen-center-message">ROULETTE READY</div>
      : r.status === 'CANCELLED' ? <div className="screen-center-message">ROULETTE CANCELLED<small>Active stakes refunded</small></div>
        : <div className="roulette-screen-grid">
          <RouletteWheel status={spinning ? 'SPINNING' : r.status} resultNumber={r.resultNumber} />
          <div className="roulette-board-wrap">
            {/* Once the run has paid out, the board gives way to what it cost the room.
                The numbers come from the settled run on the server — nothing here adds
                anything up. */}
            {r.settlement && !spinning
              ? <RouletteSettlement r={r} />
              : <><RouletteTable markers={markers} disabled compact={false} />
                <div className="roulette-board-caption">{r.status === 'OPEN' ? 'BETTING OPEN · CHIPS UPDATE LIVE' : r.status === 'LOCKED' ? 'BETS LOCKED' : spinning ? 'SPINNING…' : r.resultNumber != null ? `RESULT · ${r.resultNumber}` : 'ROULETTE'}</div></>}
          </div>
        </div>}
  </div>;
}

/**
 * What one spin did to the room's coins.
 *
 * Three numbers that are easy to confuse, so each is labelled for what it is: everything
 * staked, everything paid back (gross — the returned stake is in there too), and the
 * difference. `net` arrives already subtracted, so this cannot render it the wrong way up.
 */
function RouletteSettlement({ r }: { r: any }) {
  const { staked, payout, net, participants, eligiblePlayers, participationPercentage, players } = r.settlement;
  const rows: any[] = players || [];
  return <div className="roulette-settlement">
    <div className="roulette-settlement-result">
      <span className="label muted">UITSLAG</span>
      <b className="display">{r.resultNumber} {pocketColour(Number(r.resultNumber))}</b>
    </div>
    <div className="roulette-settlement-grid">
      <Stat label="TOTALE INZET" value={money(staked)} coin />
      <Stat label="UITBETAALD" value={money(payout)} coin />
      <div className={`screen-stat ${net >= 0 ? 'pos' : 'neg'}`}>
        <div className="label muted">NETTO RESULTAAT SPELERS</div>
        <div className="display"><CoinIcon size={24} />{net > 0 ? '+' : ''}{money(net)}</div>
      </div>
    </div>

    {/* Per player, biggest winner first. Every number here was settled on the server; the
        projector only draws them. Tightens up as the list grows so a full table still
        fits on one screen rather than scrolling somewhere nobody can scroll it. */}
    {rows.length > 0 && <div className={`roulette-player-results ${rows.length > 6 ? 'is-dense' : ''}`}>
      <div className="roulette-player-row is-head">
        <span>SPELER</span><span>INZET</span><span>UITBETAALD</span><span>NETTO</span>
      </div>
      {rows.map((player: any, index: number) => <div className="roulette-player-row" key={`${player.displayName}-${index}`}>
        <span className="roulette-player-name">
          <span className="player-dot" style={{ background: player.color || '#888' }} />
          {player.displayName}
        </span>
        <span>{money(player.stake)}</span>
        <span>{money(player.payout)}</span>
        <b className={player.net > 0 ? 'pos' : player.net < 0 ? 'neg' : ''}>
          {player.net > 0 ? '+' : ''}{money(player.net)}
        </b>
      </div>)}
    </div>}

    <div className="roulette-settlement-foot">
      {participants} van {eligiblePlayers} spelers deden mee · {participationPercentage}%
    </div>
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
function SlotScene({ slot, round }: { slot: any; round: any }) {
  const spin = slot?.currentSpin || null;
  // While the reels are still turning the numbers below them would give the result
  // away — so the scene withholds them until the animation has landed, exactly as the
  // roulette wheel withholds its winning number.
  //
  // Two sources, and the animation needs both. `spin.spinning` is the server's window,
  // which is the right answer while the projector is polling often enough to see it. But
  // the big screen polls every five seconds and the window is 3.2, so a poll can arrive
  // after the server has already revealed — and a spin whose reels never turned is
  // exactly what the hard requirement forbids. `held` is this surface deciding, on first
  // sight of a new spin, to play the animation out regardless.
  const held = useHeldReveal(spin?.id ?? null, SLOT_SPIN_MS, Boolean(spin));
  const spinning = Boolean(spin?.spinning) || held;
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
        <div className="label muted">{round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div>
        <h1 className="display">{round?.title || 'SLOTMACHINE'}</h1>
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
function PakEenZesScene({ game, round }: { game: any; round: any }) {
  const status = game?.status || 'READY';
  const last = game?.lastDraw || null;
  const finished = status === 'FINISHED';
  // The last card being a six is the celebration trigger — but only while the game runs,
  // so the final summary is not permanently flashing.
  const celebrating = Boolean(last?.isSix) && !finished;

  return <div className={`pez-screen ${celebrating ? 'is-celebrating' : ''}`}>
    <div className="pez-header">
      <div className="pez-title">
        <div className="label muted">{round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div>
        <h1 className="display">{round?.title || 'PAK EEN ZES'}</h1>
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
 * A deadline, counted down.
 *
 * The seconds tick from the browser's own clock for smoothness, but what they tick towards
 * is the server's timestamp — so this cannot drift away from what the phones are showing,
 * and a projector reload does not restart it.
 */
function ScreenCountdown({ closesAt }: { closesAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [closesAt]);
  const seconds = Math.max(0, Math.ceil((new Date(closesAt).getTime() - now) / 1000));
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>;
}

/**
 * Fotoronde, on the projector.
 *
 * Two faces. While submissions are open it shows progress per subject, which is the one
 * thing the room wants to know — who still owes a photo. While judging, the Admin puts a
 * single photo up and it fills the screen with its team's name, because that is what
 * everyone is looking at and arguing about.
 */
function PhotoRoundScene({ photo, round }: { photo: any; round: any }) {
  const shown = photo?.shown || null;
  const status = photo?.status || 'DRAFT';

  return <div className="photo-screen">
    <div className="photo-screen-header">
      <div className="photo-screen-title">
        <div className="label muted">{round ? `ROUND ${String(round.sortOrder).padStart(2, '0')} · ${round.title}` : 'MARKET MAYHEM'}</div>
        <h1 className="display">{round?.title || 'FOTORONDE'}</h1>
      </div>
      <div className="photo-screen-status">
        <span>{PHOTO_STATUS_LABELS[status] || status}</span>
        {/* The same deadline the phones count down to, so the room and the teams watch one
            clock. */}
        {photo?.submissionOpen && photo?.submissionClosesAt
          ? <b className="photo-screen-clock"><ScreenCountdown closesAt={photo.submissionClosesAt} /></b>
          : null}
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
