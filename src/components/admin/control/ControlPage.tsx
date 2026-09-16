import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunMutation } from '../types';
import { Accordion, Card, Countdown, ProgressBar, Status } from '../ui';
import { ScreenRender } from '../../broadcast/BigScreen';
import { CoinIcon } from '../../shared/CoinIcon';
import { QUIZ_OPTION_EMOJIS, roundContentCount, roundItems, roundMeta } from '../roundMeta';

export function ControlPage({ state: s, gameId, run }: { state: any; gameId: number; run: RunMutation }) {
  const nav = useNavigate();
  const [playerId, setPlayerId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [roundId, setRoundId] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustmentKey, setAdjustmentKey] = useState(() => crypto.randomUUID());
  const [denying, setDenying] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [open, setOpen] = useState({ predictions: true, ledger: false, adjust: false });
  const toggle = (key: keyof typeof open) => () => setOpen(current => ({ ...current, [key]: !current[key] }));

  const activePlayers = s.players.filter((p: any) => p.active);
  const activeRound = s.activeRound || null;
  const activeMeta = activeRound ? roundMeta(activeRound.type) : null;
  const runtime = s.roundRuntime || null;
  const activeRoulette = s.activeRoulette;
  const isFresh = activePlayers.length === 0 && s.rounds.length === 0 && s.predictions.length === 0;

  const live = s.screen || {};
  const pendingRequests = (s.predictionRequests || []).filter((r: any) => r.status === 'PENDING');


  /**
   * The question or slide the round's cursor is on.
   *
   * Progression, not presentation: this is where the game is, which is not necessarily
   * what the projector is showing. The live panel drives the cursor; the preview pair
   * above it shows the screen.
   */
  const currentQuestion = activeRound?.type === 'LIVE_QUIZ'
    ? (activeRound.questions || []).find((q: any) => q.id === runtime?.currentQuizQuestionId) || null
    : null;
  const currentSlide = activeRound?.type === 'PRESENTATIE'
    ? (activeRound.slides || []).find((x: any) => x.id === runtime?.currentSlideId) || null
    : null;
  const currentPubquiz = activeRound?.type === 'PUBQUIZ'
    ? (activeRound.pubquizQuestions || []).find((q: any) => q.id === runtime?.currentPubquizQuestionId) || null
    : null;

  const livePrediction = s.predictions.find((p: any) => p.id === live.predictionId) || null;

  const showNow = (target: Record<string, unknown>) => run('/api/show-on-screen', target);
  // One endpoint for both directions, and the same one the VOLGENDE preview asked. The
  // cursor revision travels with it, so a step from a tab that has fallen behind is
  // refused instead of pulling the projector backwards.
  const step = (direction: 'NEXT' | 'PREVIOUS') => run('/api/advance-screen', { direction, revision: runtime?.revision });
  // Which directions this round type supports at all. Mirrors navigationCapabilities in
  // netlify/lib/screen-flow.ts, which is what the server actually enforces.
  const navigable = activeRound && ['PRESENTATIE', 'LIVE_QUIZ', 'PUBQUIZ'].includes(activeRound.type)
    ? { next: true, previous: true }
    : { next: false, previous: false };

  const rouletteAction = (action: string) => activeRoulette && run('/api/roulette-action', { rouletteGameId: activeRoulette.id, action }, true);
  const quizAction = (action: string) => currentQuestion && run('/api/quiz-question-action', { questionId: currentQuestion.id, action, revision: currentQuestion.revision });
  const pubquizAction = (action: string) => currentPubquiz && run('/api/pubquiz-question-action', { questionId: currentPubquiz.id, action, revision: currentPubquiz.revision });
  const revealSlide = (revealed: boolean) => currentSlide && run('/api/reveal-slide', { slideId: currentSlide.id, revealed, revision: currentSlide.revision });
  const questionPhoto = (show: boolean) => currentQuestion && run('/api/show-question-photo', { questionId: currentQuestion.id, show });
  const pezAction = (action: string) => activeRound && run('/api/pak-een-zes-action', { roundId: activeRound.id, action });
  const photoAction = (action: string) => activeRound && run('/api/photo-round-action', { roundId: activeRound.id, action });

  const adjust = async () => {
    if (adjusting) return;
    setAdjusting(true);
    try {
      if (await run('/api/adjust-coins', { playerId: Number(playerId), amount: Number(amount), reason, roundId: roundId ? Number(roundId) : null }, true, adjustmentKey)) {
        setAmount('');
        setReason('');
        setAdjustmentKey(crypto.randomUUID());
      }
    } finally { setAdjusting(false); }
  };

  const confirmDeny = async (id: number) => {
    if (!denyReason.trim()) return;
    if (await run('/api/review-prediction-request', { requestId: id, decision: 'DENIED', reason: denyReason.trim() })) {
      setDenying(null);
      setDenyReason('');
    }
  };

  /**
   * Contextual controls for the round being played.
   *
   * Dispatches on the round's type, not on what is on the projector — the host drives the
   * game from here whether or not the audience is looking at it. Each branch is the
   * lifecycle of one game form, which is why there is no shared "next step" button: a
   * quiz advances between questions, a roulette opens and spins, and a Fotoronde opens
   * and closes submissions. Those were never the same action.
   */
  const liveActions = () => {
    if (!activeRound) {
      return livePrediction ? predictionActions() : <span className="muted live-meta">No round is being played. Start one from the list on the right.</span>;
    }

    if (activeRound.type === 'LIVE_QUIZ') {
      const questions = activeRound.questions || [];
      if (!questions.length) return <span className="muted live-meta">This quiz round has no questions yet.</span>;
      if (!currentQuestion) return <span className="muted live-meta">No question selected.</span>;
      const index = questions.findIndex((q: any) => q.id === currentQuestion.id);
      const status = currentQuestion.status;
      const part = currentQuestion.participation || { answered: 0, eligible: activePlayers.length, remaining: 0, percentage: 0 };
      const revealed = status === 'REVEALED' || status === 'SETTLED';
      const correct = currentQuestion.options.filter((o: any) => o.isCorrect).map((o: any) => o.text);

      return <>
        {/* The host's one question is "can I close yet?", so the count, the percentage
            and the bar come before the buttons rather than trailing them as meta text. */}
        {['OPEN', 'CLOSED'].includes(status) && <div className="question-participation">
          <div className="question-participation-head">
            <div>
              <div className="label muted">ANTWOORDEN</div>
              <div className="question-participation-count">{part.answered} / {part.eligible} GEANTWOORD</div>
            </div>
            <div className="question-participation-pct">{part.percentage}%</div>
          </div>
          <ProgressBar percentage={part.percentage} tone={part.remaining === 0 ? 'success' : 'blue'} label="Answers received" />
          <div className="muted question-participation-sub">
            {part.eligible === 0
              ? 'No active players can answer this question.'
              : part.remaining === 0
                ? status === 'OPEN' ? 'Everyone has answered — safe to close.' : `All ${part.eligible} answers received.`
                : `Still waiting on ${part.remaining} player${part.remaining === 1 ? '' : 's'}.`}
          </div>
        </div>}

        {status === 'READY' && <button className="btn btn-blue" onClick={() => quizAction('OPEN')}>OPEN ANSWERS</button>}
        {status === 'OPEN' && <button className="btn btn-secondary" onClick={() => quizAction('CLOSE')}>SLUIT VRAAG</button>}
        {status === 'CLOSED' && <>
          <button className="btn btn-success" onClick={() => quizAction('REVEAL')}>TOON JUISTE ANTWOORD + BETAAL</button>
          <button className="btn btn-secondary" onClick={() => quizAction('REOPEN')}>HEROPEN</button>
        </>}

        {/* The photo is the beat after the reveal, so its button only exists from there
            on — and only when a photo was actually uploaded, which keeps the step
            skippable rather than a dead control. */}
        {revealed && currentQuestion.contextMediaKey && (currentQuestion.contextPhotoShown
          ? <button className="btn btn-secondary" onClick={() => questionPhoto(false)}>TERUG NAAR DE VRAAG</button>
          : <button className="btn btn-blue" onClick={() => questionPhoto(true)}>TOON CONTEXTFOTO</button>)}

        {status === 'REVEALED' && <button className="btn btn-secondary" onClick={() => quizAction('SETTLE')}>MARK SETTLED</button>}

        {/* Question navigation, which replaced the old generic previous/next block
            stepping. It refuses to leave a question that still owes somebody a reward. */}
        <span className="live-nav">
          <button className="btn btn-secondary btn-compact" disabled={index <= 0} onClick={() => step('PREVIOUS')}>← VORIGE</button>
          <span className="muted mono">{index + 1} / {questions.length}</span>
          <button className="btn btn-secondary btn-compact" disabled={index >= questions.length - 1} onClick={() => step('NEXT')}>VOLGENDE →</button>
          <button className="btn btn-blue btn-compact" onClick={() => showNow({ kind: 'quizQuestion', roundId: activeRound.id, questionId: currentQuestion.id })}>TOON OP SCHERM</button>
        </span>

        <span className="muted live-meta">
          {revealed && correct.length
            ? `Juiste antwoord: ${correct.join(' / ')}`
            : `${part.answered} of ${part.eligible} answered`}
          {` · ${currentQuestion.points} point${currentQuestion.points === 1 ? '' : 's'}`}
          {revealed && !currentQuestion.contextMediaKey ? ' · no context photo on this question' : ''}
        </span>
      </>;
    }

    if (activeRound.type === 'PRESENTATIE') {
      const slides = activeRound.slides || [];
      if (!slides.length) return <span className="muted live-meta">This presentation round has no pages yet.</span>;
      if (!currentSlide) return <span className="muted live-meta">No page selected.</span>;
      // Counted over the run rather than over everything authored, because that is what
      // previous and next actually walk. A cursor left standing on a page the host has
      // just held back is not in the run at all, and says so.
      //
      // Button affordance only. The rule lives in netlify/lib/presentation.ts and is
      // enforced by slide-navigate — src and netlify are separate TypeScript projects, so
      // this reads the same list rather than importing the same function.
      const at = slides.findIndex((x: any) => x.id === currentSlide.id);
      const visible = slides.filter((x: any) => !x.hidden);
      const around = {
        at,
        previous: slides.slice(0, Math.max(at, 0)).filter((x: any) => !x.hidden).slice(-1)[0] || null,
        next: at < 0 ? null : slides.slice(at + 1).find((x: any) => !x.hidden) || null,
        visibleCount: visible.length,
        visibleIndex: currentSlide.hidden ? -1 : visible.findIndex((x: any) => x.id === currentSlide.id),
      };
      const hasSecret = Boolean(currentSlide.revealText || currentSlide.hideTitleUntilReveal);
      const liveHere = live.mode === 'SLIDE' && live.slideId === currentSlide.id;
      return <>
        {hasSecret && (currentSlide.revealedAt
          ? <button className="btn btn-secondary" onClick={() => revealSlide(false)}>VERBERG ANTWOORD</button>
          : <button className="btn btn-success" onClick={() => revealSlide(true)}>TOON ANTWOORD</button>)}
        <span className="live-nav">
          <button className="btn btn-secondary btn-compact" disabled={!around.previous} onClick={() => step('PREVIOUS')}>← VORIGE</button>
          <span className="muted mono">{around.visibleIndex >= 0 ? `${around.visibleIndex + 1} / ${around.visibleCount}` : `— / ${around.visibleCount}`}</span>
          <button className="btn btn-secondary btn-compact" disabled={!around.next && around.at >= 0} onClick={() => step('NEXT')}>VOLGENDE →</button>
          <button
            className="btn btn-blue btn-compact"
            disabled={currentSlide.hidden || liveHere}
            onClick={() => showNow({ kind: 'slide', roundId: activeRound.id, slideId: currentSlide.id })}
          >{liveHere ? 'OP HET SCHERM' : 'TOON OP SCHERM'}</button>
        </span>
        {currentSlide.hidden
          ? <span className="muted live-meta">
            This page is held back, so it is skipped by previous/next and cannot go on the big screen.
            {' '}<button className="text-button" onClick={() => run('/api/set-slide-visibility', { slideId: currentSlide.id, hidden: false })}>MAAK ZICHTBAAR</button>
          </span>
          : !hasSecret && <span className="muted live-meta">This page has no secret — nothing to reveal.</span>}
      </>;
    }

    if (activeRound.type === 'PUBQUIZ') {
      const questions = activeRound.pubquizQuestions || [];
      if (!questions.length) return <span className="muted live-meta">This pubquiz round has no questions yet.</span>;
      if (!currentPubquiz) return <span className="muted live-meta">No question selected.</span>;
      const status = currentPubquiz.status;
      const part = currentPubquiz.results?.participation;
      const correctOption = (currentPubquiz.options || []).find((o: any) => o.isCorrect);
      return <>
        {status === 'READY' && <button className="btn btn-success" onClick={() => pubquizAction('OPEN')}>OPEN ANTWOORDEN</button>}
        {status === 'OPEN' && <button className="btn btn-secondary" onClick={() => pubquizAction('CLOSE')}>SLUIT ANTWOORDEN</button>}
        {status === 'CLOSED' && <>
          <button className="btn btn-success" onClick={() => pubquizAction('REVEAL')}>TOON ANTWOORD + PUNTEN</button>
          <button className="btn btn-secondary" onClick={() => pubquizAction('REOPEN')}>HEROPEN</button>
        </>}

        {/* People, not answers: the number the host reads to decide when to close. */}
        <span className="muted live-meta">
          <b>{part?.answered ?? 0} / {part?.eligible ?? 0} spelers geantwoord</b>
          {` · ${part?.percentage ?? 0}%`}
          {` · ${currentPubquiz.points} punt${currentPubquiz.points === 1 ? '' : 'en'}`}
        </span>

        {/* The distribution is the host's alone before the reveal — the projector and the
            phones receive no counts at all until then. */}
        <span className="muted live-meta">
          {(currentPubquiz.options || []).map((option: any, index: number) => {
            const count = currentPubquiz.results?.tally.find((t: any) => t.optionId === option.id)?.count ?? 0;
            return <span key={option.id} className={`pubquiz-admin-tally ${option.isCorrect ? 'is-correct' : ''}`}>
              {QUIZ_OPTION_EMOJIS[index]} {count}
            </span>;
          })}
          {status === 'REVEALED' && correctOption && ` · juist: ${correctOption.text}`}
        </span>
      </>;
    }

    if (activeRound.type === 'ROULETTE') {
      if (!activeRoulette) return <span className="muted live-meta">No table yet — starting the round creates one.</span>;
      return <>
        {activeRoulette.status === 'DRAFT' && <button className="btn btn-success" onClick={() => rouletteAction('OPEN')}>OPEN BETTING</button>}
        {activeRoulette.status === 'OPEN' && <button className="btn btn-secondary" onClick={() => rouletteAction('CLOSE')}>CLOSE BETTING</button>}
        {activeRoulette.status === 'LOCKED' && <button className="btn btn-blue" onClick={() => rouletteAction('SPIN')}>SPIN</button>}
        {activeRoulette.status === 'SPINNING' && <button className="btn btn-secondary" disabled>DRAAIT… WORDT AUTOMATISCH UITBETAALD</button>}
        {/* No settle button. The spin pays out the moment its result is final, so what the
            host does next is decide whether to run the wheel again. */}
        {['SETTLED', 'CANCELLED'].includes(activeRoulette.status) && <button className="btn btn-success" onClick={() => rouletteAction('OPEN_AGAIN')}>OPEN BETTING OPNIEUW</button>}
        {['DRAFT', 'OPEN', 'LOCKED'].includes(activeRoulette.status) && <button className="btn btn-danger-ghost" onClick={() => rouletteAction('CANCEL')}>CANCEL + REFUND</button>}
        {/* People, not chips. A player with five chips on the table is one participant,
            and how many of the room is in is what decides whether to close betting. */}
        <span className="muted live-meta">
          <b>{activeRoulette.participantCount} / {activeRoulette.eligiblePlayers} spelers</b>
          {` · ${activeRoulette.participationPercentage}% deelname`}
          {` · totale inzet ${activeRoulette.total_stake}`}
          {` · spin ${activeRoulette.runNumber}`}
        </span>
        {activeRoulette.totals && <span className="muted live-meta">
          Uitslag {activeRoulette.result_number} · inzet {activeRoulette.totals.staked} · uitbetaald {activeRoulette.totals.payout}
          {' · netto '}<b className={activeRoulette.totals.net >= 0 ? 'pos' : 'neg'}>{activeRoulette.totals.net > 0 ? '+' : ''}{activeRoulette.totals.net}</b>
        </span>}
      </>;
    }

    if (activeRound.type === 'SLOTMACHINE') {
      const slot = s.activeSlot;
      const config = s.slotConfig?.status;
      // There is no spin button here on purpose: players start their own spins from
      // their phones. What the host needs is whether the machine is usable and who is
      // mid-series, so this panel is status rather than controls.
      if (!config?.valid) return <span className="neg live-meta"><b>Slotmachine unusable — {config?.reason || 'not configured'}</b></span>;
      if (!slot) return <span className="muted live-meta">Slotmachine ready — players lock a series on their phones.</span>;
      const turn = slot.turn;
      return <span className="muted live-meta">
        {turn?.current
          ? `${turn.current.playerName} is aan de beurt · ${turn.current.spinsRemaining}/${turn.current.totalSpins} spins over${turn.spinning ? ' · draait…' : ''}`
          : turn?.allDone && slot.series.length > 0
            ? 'Alle spelers zijn klaar'
            : 'Nobody has locked a series yet'}
        {' · '}max {slot.maxSpins} spins
        {slot.lockedCoins > 0 ? ` · ${slot.lockedCoins} coins locked in unspun spins` : ''}
      </span>;
    }

    if (activeRound.type === 'FOTORONDE') {
      const photo = s.photoRound;
      const status = photo?.status || 'DRAFT';
      return <>
        {status === 'DRAFT' && <button className="btn btn-blue" onClick={() => photoAction('OPEN')}>OPEN INZENDEN</button>}
        {status === 'OPEN' && <button className="btn btn-secondary" onClick={() => photoAction('CLOSE')}>SLUIT INZENDEN</button>}
        {status === 'CLOSED' && <button className="btn btn-success" onClick={() => photoAction('COMPLETE')}>MARKEER AFGEROND</button>}
        <span className="muted live-meta">
          {photo?.submissionCount ?? 0} foto&apos;s · {photo?.judgedCount ?? 0} beoordeeld · {photo?.totalCredits ?? 0} credits toegekend
        </span>
      </>;
    }

    if (activeRound.type === 'PAK_EEN_ZES') {
      const pez = s.pakEenZes;
      const status = pez?.status || 'READY';
      const awaiting = pez?.awaitingPrediction || [];
      return <>
        {status === 'READY' && <button className="btn btn-blue" onClick={() => pezAction('OPEN_PREDICTIONS')}>OPEN VOORSPELLINGEN</button>}
        {status === 'PREDICTING' && <button className="btn btn-secondary" onClick={() => pezAction('CLOSE_PREDICTIONS')}>SLUIT VOORSPELLINGEN</button>}
        {status === 'LOCKED' && <button className="btn btn-success" onClick={() => pezAction('START')}>START HET SPEL</button>}
        {status === 'DRAWING' && <span className="muted live-meta">
          {pez?.currentPlayer ? `${pez.currentPlayer.name} is aan de beurt` : 'Waiting for a turn'} · {pez?.drawnCount ?? 0}/52 kaarten · {pez?.sixesFound ?? 0}/4 zessen
        </span>}
        {status === 'FINISHED' && <span className="muted live-meta">Alle vier de zessen gevonden · {pez?.drawnCount ?? 0} kaarten getrokken</span>}
        {status === 'PREDICTING' && <span className="muted live-meta">
          {pez?.predictionCount ?? 0} of {pez?.activePlayerCount ?? 0} predicted
          {awaiting.length > 0 ? ` · still missing: ${awaiting.map((a: any) => a.name).join(', ')}` : ' · everyone is in'}
        </span>}
      </>;
    }

    return null;
  };

  function predictionActions() {
    if (!livePrediction) return null;
    return <>
      {livePrediction.status === 'OPEN' && <button className="btn btn-secondary" onClick={() => run('/api/lock-prediction', { predictionId: livePrediction.id })}>LOCK NOW</button>}
      {livePrediction.status === 'LOCKED' && <><button className="btn btn-success" onClick={() => run('/api/set-prediction-result', { predictionId: livePrediction.id, result: 'YES' })}>RESULT YES</button><button className="btn btn-danger" onClick={() => run('/api/set-prediction-result', { predictionId: livePrediction.id, result: 'NO' })}>RESULT NO</button></>}
      {livePrediction.status === 'RESULT' && <button className="btn btn-lime" onClick={() => run('/api/settle-prediction', { predictionId: livePrediction.id }, true)}>SETTLE PAYOUTS</button>}
      {['OPEN', 'LOCKED'].includes(livePrediction.status) && <button className="btn btn-danger-ghost" onClick={() => run('/api/cancel-prediction', { predictionId: livePrediction.id }, true)}>CANCEL + REFUND</button>}
      {livePrediction.status === 'OPEN' && <span className="muted live-meta mono"><Countdown closesAt={livePrediction.closes_at} /> left</span>}
    </>;
  }

  const openMarkets = s.predictions.filter((p: any) => !['SETTLED', 'CANCELLED'].includes(p.status));
  // The active round's own content, then its unresolved markets. Type-specific by
  // construction: a game round contributes one step because it is one thing.
  const roundSteps = activeRound ? roundItems(activeRound) : [];
  const roundPredictions = activeRound
    ? s.predictions.filter((p: any) => p.round_id === activeRound.id && !['SETTLED', 'CANCELLED'].includes(p.status))
    : [];

  return <div className="page-stack">
    {isFresh && <Card><div className="label muted">FIRST SETUP</div><h2 className="display card-heading">Build your game before going live</h2><div className="setup-flow"><b>Settings</b><span>→</span><b>Players</b><span>→</span><b>Rounds</b><span>→</span><b>Round Content</b><span>→</span><b>Predictions</b><span>→</span><b>Control</b></div></Card>}

    {/* Player-proposed markets, pinned above everything — they are the one thing here
        that someone else is waiting on. */}
    {pendingRequests.length > 0 && <div className="request-panel">
      <div className="label">PLAYER PREDICTION REQUESTS — NEEDS REVIEW</div>
      {pendingRequests.map((request: any) => <div className="request-row" key={request.id}>
        <div>
          <b className="request-player">{request.playerName}</b>
          <div className="request-question">{request.question}</div>
        </div>
        {denying === request.id ? <div className="request-deny">
          <input className="field" autoFocus placeholder="Reason for denying (required)" value={denyReason} onChange={e => setDenyReason(e.target.value)} />
          <div className="presenter-actions">
            <button className="btn btn-primary" disabled={!denyReason.trim()} onClick={() => confirmDeny(request.id)}>CONFIRM DENY</button>
            <button className="btn btn-secondary on-colour" onClick={() => { setDenying(null); setDenyReason(''); }}>CANCEL</button>
          </div>
        </div> : <div className="presenter-actions">
          <button className="btn btn-success" onClick={() => run('/api/review-prediction-request', { requestId: request.id, decision: 'APPROVED' })}>APPROVE</button>
          <button className="btn btn-secondary on-colour" onClick={() => { setDenying(request.id); setDenyReason(''); }}>DENY</button>
        </div>}
      </div>)}
    </div>}

    {/* LIVE and VOLGENDE. Both are the projector's own rendering of a projector DTO —
        the first of what is on screen, the second of what pressing VOLGENDE will put
        there. There is no staged slot between them any more: the host presses VOLGENDE
        and the room sees it, which is the only way a preview can be trusted. */}
    <div className="presenter-grid">
      <div className="presenter-col">
        <div className="presenter-label">
          <div className="label muted">LIVE — OP DE PROJECTOR</div>
          <a className="btn btn-secondary btn-compact" href={`/screen/${gameId}`} target="_blank" rel="noreferrer">OPEN FULL SCREEN ↗</a>
        </div>
        <LiveScreenPreview gameId={gameId} />
        <div className="presenter-actions">{liveActions()}</div>
      </div>

      <div className="presenter-col">
        <div className="label muted">VOLGENDE — WAT VOLGENDE OP HET SCHERM ZET</div>
        <NextScreenPreview gameId={gameId} version={s.version} />
        <div className="presenter-step-actions">
          <button
            className="btn btn-secondary"
            disabled={!navigable.previous}
            title={navigable.previous ? undefined : 'Deze ronde stapt niet terug'}
            onClick={() => step('PREVIOUS')}
          >← VORIGE</button>
          <button
            className="btn btn-lime go-live-btn"
            disabled={!navigable.next}
            title={navigable.next ? undefined : 'Deze ronde is één scene en wordt met haar eigen knoppen bediend'}
            onClick={() => step('NEXT')}
          >VOLGENDE →</button>
        </div>
        <button className="btn btn-secondary btn-full" onClick={() => showNow({ kind: 'dashboard', remember: true })}>TOON MARKET DASHBOARD</button>
      </div>
    </div>

    {activeRound?.type === 'SLOTMACHINE' && <SlotLivePanel slot={s.activeSlot} config={s.slotConfig?.status} activePlayers={activePlayers} />}

    {activeRound?.type === 'PAK_EEN_ZES' && <PakEenZesLivePanel game={s.pakEenZes} />}

    {activeRound?.type === 'FOTORONDE' && <PhotoRoundPanel round={s.photoRound} run={run} gameId={gameId} activeRound={activeRound} players={s.players} nav={nav} />}

    {/* What this round holds, in order, plus the markets attached to it. A quiz shows its
        questions and a presentation its slides; a game round has nothing to step through,
        so it offers itself as the single thing to show. */}
    {activeRound && <Card>
      <div className="label muted">
        ROUND {String(activeRound.sortOrder).padStart(2, '0')} · {activeMeta?.label.toUpperCase()} · {activeRound.title}
      </div>
      <div className="run-of-show">
        <div className="run-of-show-track">
          {roundSteps.map((step: any, index: number) => {
            const isQuiz = activeRound.type === 'LIVE_QUIZ';
            const isPub = activeRound.type === 'PUBQUIZ';
            const isCurrent = isQuiz ? step.id === runtime?.currentQuizQuestionId
              : isPub ? step.id === runtime?.currentPubquizQuestionId
                : step.id === runtime?.currentSlideId;
            const isLive = isQuiz ? live.questionId === step.id
              : isPub ? live.pubquizQuestionId === step.id
                : live.slideId === step.id;
            return <button
              key={step.id}
              className={`run-step accent-${activeMeta?.accent} ${isLive ? 'is-live' : ''} ${isCurrent ? 'is-current' : ''}`}
              onClick={() => showNow(isQuiz
                ? { kind: 'quizQuestion', roundId: activeRound.id, questionId: step.id }
                : isPub
                  ? { kind: 'pubquizQuestion', roundId: activeRound.id, questionId: step.id }
                  : { kind: 'slide', roundId: activeRound.id, slideId: step.id })}
            >
              <span className="accent-dot" />
              <span className="run-step-copy">
                <span className="run-step-kicker">{isQuiz || isPub ? `Q${index + 1} · ${step.points}p` : `Slide ${index + 1}`}</span>
                <span className="run-step-label">{isQuiz ? step.prompt : isPub ? step.question : (step.title || step.body || '(no title)')}</span>
              </span>
            </button>;
          })}

          {!activeMeta?.stepped && <button
            className={`run-step accent-${activeMeta?.accent} ${live.roundId === activeRound.id && !live.questionId && !live.slideId ? 'is-live' : ''}`}
            onClick={() => showNow({ kind: 'round', roundId: activeRound.id })}
          >
            <span className="accent-dot" />
            <span className="run-step-copy">
              <span className="run-step-kicker">{activeMeta?.label}</span>
              <span className="run-step-label">{activeRound.title}</span>
            </span>
          </button>}

          {roundPredictions.map((prediction: any) => <button
            key={`prediction-${prediction.id}`}
            className={`run-step accent-blue ${live.predictionId === prediction.id ? 'is-live' : ''}`}
            onClick={() => showNow({ kind: 'prediction', predictionId: prediction.id })}
          >
            <span className="accent-dot" />
            <span className="run-step-copy">
              <span className="run-step-kicker">Prediction #{prediction.display_number}</span>
              <span className="run-step-label">{prediction.question}</span>
            </span>
          </button>)}
        </div>
      </div>
    </Card>}

    <div className="control-grid">
      <div className="page-stack control-main-column">
        <Accordion title={`ALL PREDICTIONS (${openMarkets.length} ACTIVE)`} open={open.predictions} onToggle={toggle('predictions')}>
          {openMarkets.length === 0 ? <p className="muted">No active predictions.</p> : <div className="active-market-stack">{openMarkets.map((p: any) => <div className="market-line" key={p.id}>
            <div className="market-line-copy">
              <b>#{p.display_number} · {p.question}{p.round_number ? ` · R${String(p.round_number).padStart(2, '0')}` : ' · No round'}</b>
              <div className="muted">{p.participation_count} / {activePlayers.length} participated · <span className="yes-text">YES {p.yes_odds.toFixed(2)}x</span> · <span className="no-text">NO {p.no_odds.toFixed(2)}x</span></div>
            </div>
            <div className="market-line-actions">
              <Status tone={p.status === 'OPEN' ? 'open' : 'neutral'}>{p.status}</Status>
              {p.status === 'OPEN' && <div className="mono countdown-inline"><Countdown closesAt={p.closes_at} /></div>}
              {['DRAFT', 'SCHEDULED'].includes(p.status)
                ? <button className="btn btn-primary btn-compact" onClick={() => run('/api/open-prediction', { predictionId: p.id })}>OPEN NOW</button>
                : <button className="btn btn-secondary btn-compact" onClick={() => showNow({ kind: 'prediction', predictionId: p.id })}>STAGE</button>}
              {p.status === 'OPEN' && <button className="btn btn-secondary btn-compact" onClick={() => run('/api/lock-prediction', { predictionId: p.id })}>LOCK NOW</button>}
              {p.status === 'LOCKED' && <><button className="btn btn-success btn-compact" onClick={() => run('/api/set-prediction-result', { predictionId: p.id, result: 'YES' })}>RESULT YES</button><button className="btn btn-danger btn-compact" onClick={() => run('/api/set-prediction-result', { predictionId: p.id, result: 'NO' })}>RESULT NO</button></>}
              {p.status === 'RESULT' && <button className="btn btn-primary btn-compact" onClick={() => run('/api/settle-prediction', { predictionId: p.id }, true)}>SETTLE PAYOUTS</button>}
              {['DRAFT', 'SCHEDULED', 'OPEN', 'LOCKED'].includes(p.status) && <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/cancel-prediction', { predictionId: p.id }, true)}>CANCEL + REFUND</button>}
            </div>
          </div>)}</div>}
        </Accordion>

        <Accordion title="RECENT LEDGER" open={open.ledger} onToggle={toggle('ledger')}>
          {s.recentTransactions.length === 0 ? <p className="muted">No transactions yet</p> : s.recentTransactions.slice(0, 10).map((x: any) => <div className="ledger-line" key={x.id}><span><b>{x.display_name}</b> · {x.description}</span><b className={x.amount >= 0 ? 'pos' : 'neg'}>{x.amount > 0 ? '+' : ''}{x.amount}</b></div>)}
        </Accordion>
      </div>

      <div className="page-stack control-side-column">
        <RoundsInGame state={s} gameId={gameId} run={run} nav={nav} />

        {activeRound?.groups?.length > 0 && <Card>
          <div className="label muted">GROUPS THIS ROUND</div>
          <div className="round-content-summary">
            {activeRound.groups.map((group: any) => <div key={group.id} className="round-content-line">
              <span>{group.name} <span className="muted">· {group.members.map((m: any) => m.display_name).join(', ') || 'no members'}</span></span>
            </div>)}
          </div>
          <button className="btn btn-secondary btn-full round-content-edit" onClick={() => nav(`/admin/${gameId}/rounds/${activeRound.id}`)}>EDIT GROUPS + SCORING</button>
        </Card>}

        <Accordion className="on-ink quick-adjust-card" title="QUICK COIN ADJUSTMENT" open={open.adjust} onToggle={toggle('adjust')}>
          <div className="quick-adjust-grid">
            <select className="field" value={playerId} onChange={e => setPlayerId(e.target.value)}><option value="">Player</option>{activePlayers.map((p: any) => <option key={p.id} value={p.id}>{p.display_name} · {p.current_balance}</option>)}</select>
            <input className="field" type="number" placeholder="25 or -10" value={amount} onChange={e => setAmount(e.target.value)} />
            <select className="field" value={roundId} onChange={e => setRoundId(e.target.value)}><option value="">General / no round</option>{s.rounds.map((r: any) => <option key={r.id} value={r.id}>R{String(r.sortOrder).padStart(2, '0')} · {r.title}</option>)}</select>
            <input className="field quick-reason" placeholder="Mandatory reason" value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-full quick-save" disabled={adjusting || !playerId || !reason.trim() || !amount || Number(amount) === 0} onClick={adjust}>{adjusting ? 'SAVING…' : <><CoinIcon size={16} /> SAVE ADJUSTMENT</>}</button>
        </Accordion>
      </div>
    </div>
  </div>;
}

/**
 * What the slotmachine is doing right now.
 *
 * The host does not drive this game — players lock their own series and press their own
 * SPIN — so the panel answers the questions they cannot see from the projector: is the
 * machine even usable, who is mid-series, and what did the last spin pay.
 */
function SlotLivePanel({ slot, config, activePlayers }: { slot: any; config: any; activePlayers: any[] }) {
  const series: any[] = slot?.activeSeries || [];
  const last = slot?.lastSpin || null;
  const turn = slot?.turn || null;

  return <Card className="slot-live-panel">
    <div className="row-between">
      <div>
        <div className="label muted">SLOTMACHINE · LIVE</div>
        <h2 className="display card-heading">Players spin from their phones</h2>
      </div>
      <Status tone={config?.valid ? 'open' : 'danger'}>{config?.valid ? 'CONFIGURED' : 'NOT CONFIGURED'}</Status>
    </div>

    {!config?.valid && <p className="neg"><b>{config?.reason || 'Finish the slotmachine setup in Settings before running this block.'}</b></p>}

    {/* One player at a time, so the turn is the headline: who is up, how much of their
        run is left, and who follows. */}
    <div className="slot-turn-strip">
      <div>
        <span className="label muted">AAN DE BEURT</span>
        <b>{turn?.current ? turn.current.playerName : turn?.allDone && series.length > 0 ? 'Alle spelers klaar' : '—'}</b>
      </div>
      <div>
        <span className="label muted">SPINS OVER</span>
        <b>{turn?.current ? `${turn.current.spinsRemaining} / ${turn.current.totalSpins}` : '—'}</b>
      </div>
      <div>
        <span className="label muted">INZET PER SPIN</span>
        <b>{turn?.current ? turn.current.stakePerSpin : '—'}</b>
      </div>
      <div>
        <span className="label muted">HIERNA</span>
        <b>{turn?.next ? turn.next.playerName : turn?.current ? 'niemand meer' : '—'}</b>
      </div>
    </div>

    {turn?.spinning && <p className="muted microcopy">A spin is resolving — no new spin can start until it lands.</p>}

    <div className="slot-live-stats">
      <div><span className="label muted">ACTIVE SERIES</span><b>{series.length} of {activePlayers.length}</b></div>
      <div><span className="label muted">LOCKED IN UNSPUN SPINS</span><b><CoinIcon size={16} /> {slot?.lockedCoins ?? 0}</b></div>
      <div><span className="label muted">LAST OUTCOME</span><b>{last ? last.status === 'RESULT' ? last.outcome : 'spinning…' : '—'}</b></div>
      <div><span className="label muted">LAST PAYOUT</span><b>{last && last.status === 'RESULT' ? `${last.payout} at ${Number(last.payoutMultiplier).toFixed(2).replace(/\.?0+$/, '')}x` : '—'}</b></div>
    </div>

    {series.length === 0
      ? <div className="sub-empty">No player has locked a series yet.</div>
      : <div className="round-content-summary">
        {series.map(item => <div className="round-content-line" key={item.id}>
          <span>
            <span className="player-dot" style={{ background: item.playerColor }} />
            <b>{item.playerName}</b> · {item.stakePerSpin} per spin · {item.spinsRemaining} of {item.totalSpins} spins left
          </span>
          <Status tone="open">ACTIVE</Status>
        </div>)}
      </div>}

    {slot?.spins?.length > 0 && <div className="slot-live-history">
      <div className="label muted">RECENT SPINS</div>
      {slot.spins.map((spin: any) => <div className="ledger-line" key={spin.id}>
        <span><b>{spin.playerName}</b> · spin {spin.spinNumber} · {spin.status === 'RESULT' ? spin.outcome : 'spinning…'}</span>
        <b className={spin.status === 'RESULT' && spin.payout > 0 ? 'pos' : 'muted'}>
          {spin.status === 'RESULT' ? spin.payout > 0 ? `+${spin.payout}` : '0' : '—'}
        </b>
      </div>)}
    </div>}

    <p className="muted microcopy">
      One player at a time: each one plays their whole bought run before the next starts, and no extra spins can be
      bought afterwards. The server decides whose turn it is and refuses a spin while the previous one is still
      resolving. Moving to the next content block ends every series and refunds spins nobody used.
    </p>
  </Card>;
}

/**
 * The Fotoronde: every team's photos, by subject, with the credits the host awards.
 *
 * Judging happens per photo. The split across the team's members is shown next to the
 * amount before it is confirmed, so the host can see that 25 credits across 4 players
 * pays 7 + 6 + 6 + 6 rather than wondering where the odd credit went.
 *
 * An already-judged photo shows what it earned instead of an input: the server refuses a
 * second award, so offering one would be a lie.
 */
function PhotoRoundPanel({ round, run, gameId, activeRound, players, nav }: {
  round: any;
  run: RunMutation;
  gameId: number;
  activeRound: any;
  players: any[];
  nav: (path: string) => void;
}) {
  const [credits, setCredits] = useState<Record<number, string>>({});
  const [awarding, setAwarding] = useState<number | null>(null);
  const status = round?.status || 'DRAFT';
  const teams: any[] = round?.teams || [];

  const award = async (submissionId: number, amount: number) => {
    if (awarding !== null) return;
    setAwarding(submissionId);
    try {
      if (await run('/api/award-photo-credits', { submissionId, credits: amount })) {
        setCredits(current => { const next = { ...current }; delete next[submissionId]; return next; });
      }
    } finally { setAwarding(null); }
  };

  const show = (submissionId: number | null) => run('/api/show-photo-submission', { roundId: round.roundId, submissionId });

  return <Card className="photo-live-panel">
    <div className="row-between">
      <div>
        <div className="label muted">FOTORONDE · LIVE</div>
        <h2 className="display card-heading">Teams upload from their phones</h2>
      </div>
      <Status tone={status === 'OPEN' ? 'open' : status === 'COMPLETED' ? 'success' : status === 'CLOSED' ? 'warning' : 'neutral'}>{status}</Status>
    </div>

    <div className="photo-live-stats">
      <div><span className="label muted">TEAMS</span><b>{teams.length}</b></div>
      <div><span className="label muted">FOTO'S</span><b>{round?.submissionCount ?? 0}</b></div>
      <div><span className="label muted">BEOORDEELD</span><b>{round?.judgedCount ?? 0} / {round?.submissionCount ?? 0}</b></div>
      <div><span className="label muted">CREDITS</span><b><CoinIcon size={16} /> {round?.totalCredits ?? 0}</b></div>
    </div>

    {/* Teams are the unit everything else is grouped by, and the host builds them here
        rather than having to leave for the round page. Round groups and the existing
        group endpoints do the work — this is only where they are reached from. */}
    <PhotoTeamEditor
      activeRound={activeRound}
      players={players}
      teamTotals={round?.teamTotals || []}
      run={run}
      nav={nav}
      gameId={gameId}
    />

    {(round?.bySubject || []).map((entry: any) => <div className="photo-subject-group" key={entry.subject.key}>
      <div className="photo-subject-title">
        <div className="label muted">{String(entry.subject.label).toUpperCase()}</div>
        <span className="muted">{entry.submittedCount} / {teams.length} teams</span>
      </div>

      {/* Named, because "which teams are still missing" is the actionable half. */}
      {entry.missingTeams.length > 0 && <div className="photo-missing">
        <span className="label muted">NOG GEEN FOTO</span>
        {entry.missingTeams.map((name: string) => <span key={name}>{name}</span>)}
      </div>}

      {entry.submissions.length === 0
        ? <div className="sub-empty">Nog geen foto's voor dit onderwerp.</div>
        : <div className="photo-grid">
          {entry.submissions.map((submission: any) => {
            const team = teams.find(t => t.groupId === submission.groupId);
            const memberCount = team?.memberIds.length ?? 0;
            const typed = credits[submission.id];
            const amount = Number(typed);
            const validAmount = typed !== undefined && typed !== '' && Number.isInteger(amount) && amount >= 0;
            const judged = submission.creditsAwarded != null;
            return <div className={`photo-card ${judged ? 'is-judged' : ''}`} key={submission.id}>
              <img className="photo-card-image" src={`/api/block-media?key=${encodeURIComponent(submission.mediaKey)}`} alt="" />
              <div className="photo-card-body">
                <b>{submission.teamName}</b>
                <span className="muted">Ingezonden door: {submission.uploaderName || 'onbekend'}</span>

                {judged
                  ? <div className="photo-awarded">
                    <b><CoinIcon size={16} /> {submission.creditsAwarded} credits</b>
                    <span className="muted">{submission.distribution}</span>
                  </div>
                  : round?.acceptsAwards
                    ? <div className="photo-award-form">
                      <input
                        className="field photo-credit-input"
                        type="number"
                        min="0"
                        placeholder="Credits"
                        value={typed ?? ''}
                        onChange={e => setCredits({ ...credits, [submission.id]: e.target.value })}
                      />
                      {/* The split, shown before confirming rather than after. */}
                      <span className="muted photo-split-hint">
                        {validAmount && memberCount > 0
                          ? `${memberCount} spelers · ${describeSplit(amount, memberCount)}`
                          : memberCount === 0 ? 'geen actieve spelers' : `${memberCount} spelers`}
                      </span>
                      <button
                        className="btn btn-primary btn-compact"
                        disabled={!validAmount || memberCount === 0 || awarding !== null}
                        onClick={() => award(submission.id, amount)}
                      >{awarding === submission.id ? 'TOEKENNEN…' : 'TOEKENNEN'}</button>
                    </div>
                    : <span className="muted">Sluit het inzenden om te beoordelen.</span>}

                <button
                  className={`btn btn-secondary btn-compact ${round?.shownSubmissionId === submission.id ? 'is-shown' : ''}`}
                  onClick={() => show(round?.shownSubmissionId === submission.id ? null : submission.id)}
                >{round?.shownSubmissionId === submission.id ? 'VAN SCHERM HALEN' : 'OP BIG SCREEN'}</button>
              </div>
            </div>;
          })}
        </div>}
    </div>)}

    <p className="muted microcopy">
      Credits go to the team and are split across its active players — every credit is handed out, and the same photo
      can never be rewarded twice. Moving to the next content block closes submissions but keeps the photos, so
      anything unjudged stays judgeable.
    </p>
  </Card>;
}

/**
 * Create and populate the Fotoronde's teams, in place.
 *
 * Teams are round groups, created by the Admin for this round — the same objects the
 * round page edits and the same three endpoints. Surfaced here because this is where the
 * host needs them: they are running the Fotoronde, and a block that cannot open without
 * teams should not send them somewhere else to make one.
 *
 * Membership is a checkbox grid rather than a picker, because a player belongs to at
 * most one group per round and the server enforces that — so the grid shows the whole
 * roster and the server refuses a double assignment.
 */
function PhotoTeamEditor({ activeRound, players, teamTotals, run, nav, gameId }: {
  activeRound: any;
  players: any[];
  teamTotals: any[];
  run: RunMutation;
  nav: (path: string) => void;
  gameId: number;
}) {
  const [name, setName] = useState('');
  const [editingMembers, setEditingMembers] = useState<Record<number, number[]>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const groups: any[] = activeRound?.groups || [];
  // Structure is frozen once the round is completed; the existing endpoints refuse it
  // too, so this only avoids offering an action that would fail.
  const locked = activeRound?.status === 'COMPLETED';
  const roster = players.filter(p => p.active);

  const membersFor = (group: any) => editingMembers[group.id] ?? group.members.map((m: any) => m.id);
  const toggle = (group: any, playerId: number) => {
    const current = membersFor(group);
    setEditingMembers({
      ...editingMembers,
      [group.id]: current.includes(playerId) ? current.filter((id: number) => id !== playerId) : [...current, playerId],
    });
  };

  const saveMembers = async (group: any) => {
    if (saving !== null) return;
    setSaving(group.id);
    try {
      if (await run('/api/set-round-group-members', { groupId: group.id, playerIds: membersFor(group) })) {
        setEditingMembers(current => { const next = { ...current }; delete next[group.id]; return next; });
      }
    } finally { setSaving(null); }
  };

  return <div className="photo-teams">
    <div className="row-between">
      <div className="label muted">TEAMS · {groups.length}</div>
      {groups.length > 0 && <button className="text-button" onClick={() => setOpen(x => !x)}>
        {open ? 'Klaar met teams' : 'Teams aanpassen'}
      </button>}
    </div>

    {groups.length === 0 && <p className="neg photo-teams-empty">
      <b>Nog geen teams in deze ronde.</b> Maak hieronder minstens één team — de Fotoronde kan niet open zonder.
    </p>}

    {/* Collapsed by default once teams exist: judging is the main job here, not admin. */}
    {(open || groups.length === 0) && !locked && <div className="photo-team-create">
      <input className="field" placeholder="Teamnaam" value={name} onChange={e => setName(e.target.value)} />
      <button
        className="btn btn-primary btn-compact"
        disabled={!name.trim() || !activeRound}
        onClick={async () => { if (await run('/api/upsert-round-group', { roundId: activeRound.id, name })) setName(''); }}
      >+ TEAM</button>
    </div>}

    <div className="photo-team-list">
      {groups.map(group => {
        const totals = teamTotals.find((t: any) => t.groupId === group.id);
        const selected = membersFor(group);
        const activeNames = group.members.filter((m: any) => m.active).map((m: any) => m.display_name);
        return <div className="photo-team-entry" key={group.id}>
          <div className="photo-team-row">
            <div>
              <b>{group.name}</b>
              <span className="muted"> · {activeNames.length ? activeNames.join(', ') : 'geen actieve spelers'}</span>
            </div>
            <span className="photo-team-credits">{totals?.submitted ?? 0} foto&apos;s · {totals?.credits ?? 0} credits</span>
          </div>

          {open && !locked && <div className="photo-team-members">
            <div className="group-members">
              {roster.map(player => <label key={player.id} className={`group-member ${selected.includes(player.id) ? 'selected' : ''}`}>
                <input type="checkbox" checked={selected.includes(player.id)} onChange={() => toggle(group, player.id)} />
                <span className="player-dot" style={{ background: player.public_color }} />
                <span>{player.display_name}</span>
              </label>)}
            </div>
            <div className="actions actions-compact">
              <button className="btn btn-secondary btn-compact" disabled={saving === group.id} onClick={() => saveMembers(group)}>
                {saving === group.id ? 'OPSLAAN…' : 'SAVE MEMBERS'}
              </button>
              {/* Refused server-side once the team has ledger history, photo credits
                  included — so a team that earned something is kept for the ledger. */}
              <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-round-group', { groupId: group.id })}>DELETE</button>
            </div>
          </div>}
        </div>;
      })}
    </div>

    {open && activeRound && <button className="text-button photo-teams-link" onClick={() => nav(`/admin/${gameId}/rounds/${activeRound.id}`)}>
      Open de rondepagina voor groepsscoring en hernoemen
    </button>}
  </div>;
}

/**
 * How an award divides, in words. Mirrors describeDistribution in
 * netlify/lib/photo-round.ts — src and netlify are separate TypeScript projects, so this
 * is a local copy rather than pulling backend code into the client bundle.
 */
function describeSplit(credits: number, memberCount: number) {
  if (memberCount <= 0) return 'no players';
  if (credits <= 0) return 'no credits';
  const base = Math.floor(credits / memberCount);
  const remainder = credits % memberCount;
  if (remainder === 0) return `${memberCount} × ${base}`;
  return `${remainder} × ${base + 1} + ${memberCount - remainder} × ${base}`;
}

/**
 * What Pak een Zes is doing right now.
 *
 * The host drives the phases but not the cards, so this answers what they cannot see
 * from the projector: who has not predicted yet (they are allowed to close without
 * those people, so the names matter), whose turn it is, and which sixes are out.
 */
function PakEenZesLivePanel({ game }: { game: any }) {
  const status = game?.status || 'READY';
  const awaiting: any[] = game?.awaitingPrediction || [];
  const sixes: any[] = game?.sixes || [];
  const tone = status === 'DRAWING' ? 'open' : status === 'FINISHED' ? 'success' : status === 'PREDICTING' ? 'warning' : 'neutral';

  return <Card className="pez-live-panel">
    <div className="row-between">
      <div>
        <div className="label muted">PAK EEN ZES · LIVE</div>
        <h2 className="display card-heading">Players draw their own cards</h2>
      </div>
      <Status tone={tone as any}>{status}</Status>
    </div>

    <div className="pez-live-stats">
      <div><span className="label muted">AAN DE BEURT</span><b>{status === 'DRAWING' ? (game?.currentPlayer?.name || '—') : '—'}</b></div>
      <div><span className="label muted">KAARTEN GETROKKEN</span><b>{game?.drawnCount ?? 0} / 52</b></div>
      <div><span className="label muted">ZESSEN GEVONDEN</span><b>{game?.sixesFound ?? 0} / 4</b></div>
      <div><span className="label muted">VOORSPELLINGEN</span><b>{game?.predictionCount ?? 0} / {game?.activePlayerCount ?? 0}</b></div>
    </div>

    {/* Closing predictions without everyone is allowed, so name who would be left out
        rather than only counting them. */}
    {['PREDICTING', 'LOCKED'].includes(status) && <div className="pez-awaiting">
      <div className="label muted">{awaiting.length === 0 ? 'EVERYONE HAS PREDICTED' : 'STILL TO PREDICT'}</div>
      {awaiting.length > 0 && <div className="pez-awaiting-names">
        {awaiting.map(player => <span key={player.playerId}>{player.name}</span>)}
      </div>}
    </div>}

    {/* The scoring outcome, so the host can read it out without leaving the panel. */}
    {(game?.results?.length ?? 0) > 0 && <div className="pez-live-sixes">
      <div className="label muted">VOORSPELLINGEN · {game.pointsPerCorrect} PUNTEN PER STUK</div>
      {game.results.filter((r: any) => r.correct > 0).map((result: any) => <div className="ledger-line" key={result.playerId}>
        <span><b>{result.playerName}</b> · {result.correct} goed</span>
        <b className="pos">+{result.points}</b>
      </div>)}
    </div>}

    {sixes.length > 0 && <div className="pez-live-sixes">
      <div className="label muted">ZESSEN</div>
      {sixes.map(six => <div className="ledger-line" key={six.id}>
        <span><b>{six.label}</b> · {six.playerName}</span>
        <b className="muted">trek {six.drawNumber}</b>
      </div>)}
    </div>}

    {game?.recentDraws?.length > 0 && <div className="pez-live-sixes">
      <div className="label muted">LAATSTE KAARTEN</div>
      {game.recentDraws.map((draw: any) => <div className="ledger-line" key={draw.id}>
        <span>{draw.playerName} · {draw.label}</span>
        <b className={draw.isSix ? 'pos' : 'muted'}>{draw.isSix ? 'ZES' : ''}</b>
      </div>)}
    </div>}

    <p className="muted microcopy">
      The server decides both the card and whose turn it is — a phone can only ask. Moving to the next content block
      stops the game, and its predictions and draws are kept for scoring later.
    </p>
  </Card>;
}

/**
 * Every round in the game night, in order, with the one action each needs.
 *
 * This replaces the old current-round and this-round's-content cards. The run of
 * show already answers "what is inside the live round"; the question it cannot
 * answer is "where are we in the evening, and what still needs building". EDIT
 * hands off to the round's own page rather than duplicating the editor here.
 */
function RoundsInGame({ state: s, gameId, run, nav }: { state: any; gameId: number; run: RunMutation; nav: (path: string) => void }) {
  const activeRoundId = s.game.current_round_id;
  const label = (status: string) => status === 'COMPLETED' ? 'FINISHED' : status;
  const tone = (status: string) => status === 'ACTIVE' ? 'open' : status === 'COMPLETED' ? 'success' : 'neutral';

  return <Card>
    <div className="row-between">
      <div className="label muted">ROUNDS IN THIS GAME</div>
      <Status>{s.rounds.length} ROUND{s.rounds.length === 1 ? '' : 'S'}</Status>
    </div>
    {s.rounds.length === 0
      ? <div className="sub-empty">No rounds yet — create the first one on the Rounds page.</div>
      : <div className="round-line-list">
        {s.rounds.map((round: any) => {
          const isActive = round.id === activeRoundId;
          const meta = roundMeta(round.type);
          const parts = roundContentCount(round);
          const groups = round.groups?.length ?? 0;
          // The server refuses a second active round with a 409, so the button says
          // so up front rather than offering an action that is going to fail.
          const blockedBy = round.status === 'UPCOMING' && activeRoundId ? s.rounds.find((r: any) => r.id === activeRoundId) : null;
          return <div key={round.id} className={`round-line ${isActive ? 'is-active' : ''}`}>
            <div className="round-line-copy">
              <div className="round-line-title">R{String(round.sortOrder).padStart(2, '0')} · {round.title}</div>
              <div className="muted round-line-meta">{meta.label}{meta.itemNoun ? ` · ${parts} ${meta.itemNoun}${parts === 1 ? '' : 's'}` : ''}{groups > 0 ? ` · ${groups} group${groups === 1 ? '' : 's'}` : ''}</div>
            </div>
            <Status tone={tone(round.status) as any}>{label(round.status)}</Status>
            <div className="round-line-actions">
              {round.status === 'UPCOMING' && <button
                className="btn btn-primary btn-compact"
                disabled={Boolean(blockedBy)}
                title={blockedBy ? `Complete R${String(blockedBy.sortOrder).padStart(2, '0')} first` : undefined}
                onClick={() => run('/api/start-round', { roundId: round.id })}
              >START</button>}
              {isActive && <button className="btn btn-primary btn-compact" onClick={() => run('/api/complete-round', { roundId: round.id })}>COMPLETE ROUND</button>}
              <button className="btn btn-secondary btn-compact" onClick={() => nav(`/admin/${gameId}/rounds/${round.id}`)}>EDIT</button>
            </div>
          </div>;
        })}
      </div>}
  </Card>;
}

const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;

/**
 * A projector snapshot, drawn at projector size and scaled into the Admin column.
 *
 * Same component the big screen uses, same DTO — so LIVE and NEXT are not the Admin's
 * interpretation of the state, they are the state.
 */
function ScaledScreen({ children }: { children: any }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setScale(node.clientWidth / SCREEN_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <div className="screen-preview" ref={ref}>
    <div className="screen-preview-stage" style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, transform: `scale(${scale})` }}>
      {children}
    </div>
  </div>;
}

/**
 * What the projector will show if the host presses VOLGENDE.
 *
 * The snapshot comes from `/api/next-screen-state`, which asks the same `planStep` the
 * button itself calls and renders the answer through the projector's own snapshot builder.
 * So this is not a description of the next step — it is the next step, drawn early.
 */
function NextScreenPreview({ gameId, version }: { gameId: number; version: number }) {
  const [state, setState] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/next-screen-state?gameId=${gameId}&direction=NEXT`, { credentials: 'include' });
        const data = await response.json();
        if (!cancelled) setState(response.ok ? data : null);
      } catch { if (!cancelled) setState(null); }
    })();
    return () => { cancelled = true; };
    // Re-asked whenever the game moves, which is what keeps it in step with LIVE.
  }, [gameId, version]);

  if (!state) return <div className="screen-preview next-preview-empty"><span className="muted">Loading…</span></div>;
  if (state.step === 'completeRound') {
    return <div className="screen-preview next-preview-empty">
      <b className="display">EINDE VAN DE RONDE</b>
      <span className="muted">{state.label} — VOLGENDE sluit deze ronde af.</span>
    </div>;
  }
  if (state.step !== 'target' || !state.preview) {
    return <div className="screen-preview next-preview-empty"><span className="muted">{state.reason || 'Niets om naartoe te stappen.'}</span></div>;
  }
  return <ScaledScreen><ScreenRender s={state.preview} /></ScaledScreen>;
}

function LiveScreenPreview({ gameId }: { gameId: number }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const updateScale = () => setScale(preview.clientWidth / SCREEN_WIDTH);
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  return <div className="screen-preview" ref={previewRef}>
    <iframe
      title="Live Big Screen"
      src={`/screen/${gameId}`}
      width={SCREEN_WIDTH}
      height={SCREEN_HEIGHT}
      style={{ transform: `scale(${scale})` }}
    />
  </div>;
}
