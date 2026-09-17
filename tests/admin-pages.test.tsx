import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ControlPage } from '../src/components/admin/control/ControlPage';
import { RoundsPage } from '../src/components/admin/rounds/RoundsPage';
import { PredictionsPage } from '../src/components/admin/predictions/PredictionsPage';
import { PlayersPage } from '../src/components/admin/players/PlayersPage';
import { SettingsPage } from '../src/components/admin/settings/SettingsPage';
import { MarketPage } from '../src/components/admin/market/MarketPage';
import { LedgerPage } from '../src/components/admin/ledger/LedgerPage';
import { ROUND_TYPES, describeContent, roundMeta } from '../src/components/admin/roundMeta';

const run = async () => true;

/** Presentation slot in the shape getAdminState returns. */
const slot = (
  mode: string | null,
  extra: { roundId?: number | null; questionId?: number | null; slideId?: number | null; predictionId?: number | null } = {},
) => ({
  mode,
  roundId: extra.roundId ?? null,
  questionId: extra.questionId ?? null,
  slideId: extra.slideId ?? null,
  predictionId: extra.predictionId ?? null,
});

const option = (id: number, text: string, isCorrect = false) => ({ id, sortOrder: id - 1, text, isCorrect });

/** A quiz round with three questions, each worth its own points. */
const QUIZ_ROUND = {
  id: 3, sortOrder: 3, title: 'Kennisquiz', type: 'LIVE_QUIZ', status: 'ACTIVE',
  description: '', instructions: '', defaultPoints: 10,
  questions: [
    {
      id: 31, roundId: 3, sortOrder: 0, prompt: 'Hoofdstad van Frankrijk?', body: '',
      points: 10, timeLimitSeconds: null, contextMediaKey: null, status: 'OPEN',
      contextPhotoShown: false, revision: 0, answerCount: 2,
      participation: { answered: 2, eligible: 2, remaining: 0, percentage: 100 },
      options: [option(1, 'Parijs', true), option(2, 'Lyon'), option(3, 'Marseille')],
    },
    {
      id: 32, roundId: 3, sortOrder: 1, prompt: 'Grootste oceaan?', body: '',
      points: 40, timeLimitSeconds: 30, contextMediaKey: 'ctx-1', status: 'READY',
      contextPhotoShown: false, revision: 0, answerCount: 0,
      participation: { answered: 0, eligible: 2, remaining: 2, percentage: 0 },
      options: [option(4, 'Stille', true), option(5, 'Atlantische')],
    },
    {
      id: 33, roundId: 3, sortOrder: 2, prompt: 'Hoeveel hoofdsteden ken jij?', body: '',
      points: 5, timeLimitSeconds: null, contextMediaKey: null, status: 'READY',
      contextPhotoShown: false, revision: 0, answerCount: 0,
      participation: { answered: 0, eligible: 2, remaining: 2, percentage: 0 },
      options: [option(6, 'Veel', true), option(7, 'Weinig')],
    },
  ],
  groups: [{ id: 1, round_id: 3, name: 'Team Rood', members: [{ id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true }] }],
};

const FINALE_ROUND = {
  id: 4, sortOrder: 4, title: 'Finale', type: 'ROULETTE', status: 'UPCOMING',
  description: '', instructions: '', defaultPoints: 10, groups: [],
};

function adminState(overrides: Record<string, unknown> = {}) {
  const predictions = [
    { id: 1, display_number: 1, question: 'Wint Team Blauw de bonusronde?', round_id: 3, round_number: 3, status: 'OPEN', probability_yes: 0.55, yes_odds: 1.8, no_odds: 2.2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: new Date(Date.now() + 60_000).toISOString(), result: null },
    { id: 2, display_number: 2, question: 'Perfecte score in de Film Kwis?', round_id: null, round_number: null, status: 'LOCKED', probability_yes: 0.3, yes_odds: 3, no_odds: 1.4, participation_count: 4, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: null },
    { id: 3, display_number: 3, question: 'Awaiting payout', round_id: null, round_number: null, status: 'RESULT', probability_yes: 0.5, yes_odds: 2, no_odds: 2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: 'YES' },
    { id: 4, display_number: 4, question: 'Settled market', round_id: null, round_number: null, status: 'SETTLED', probability_yes: 0.5, yes_odds: 2, no_odds: 2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: 'NO' },
  ];
  return {
    version: 1,
    game: { id: 1, name: 'Game Night #12', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: 3, current_screen_mode: 'QUIZ_QUESTION', game_state_version: 1 },
    screen: {
      ...slot('QUIZ_QUESTION', { roundId: 3, questionId: 31 }),
      staged: slot('QUIZ_QUESTION', { roundId: 3, questionId: 32 }),
      previous: slot(null),
    },
    // The round's own cursor. Separate from the screen above, deliberately: one is where
    // the game is, the other is what the audience is looking at.
    roundRuntime: { currentQuizQuestionId: 31, currentSlideId: null, revision: 0 },
    predictionRequests: [] as unknown[],
    rounds: [QUIZ_ROUND, FINALE_ROUND],
    activeRound: QUIZ_ROUND,
    players: [
      { id: 1, display_name: 'Jordi', public_color: '#9B2FF2', active: true, current_balance: 340, locked_prediction: 40, rank: 1, joined: true, is_default: true },
      { id: 2, display_name: 'Jorrit', public_color: '#E8352F', active: true, current_balance: 260, locked_prediction: 0, rank: 2, joined: false, is_default: false },
    ],
    predictions,
    activePredictions: [] as unknown[],
    recentTransactions: [{ id: 1, amount: -20, description: 'Prediction deposit #1', transaction_type: 'BET', created_at: new Date().toISOString(), display_name: 'Daan', round_number: 3, prediction_number: 1, roulette_game_id: null, group_name: null }],
    activeRoulette: null,
    // A fully configured machine: 100 chances allocated across the five outcomes, all
    // twelve symbols uploaded, which is what makes a slotmachine round usable.
    slotConfig: {
      totalWeight: 100,
      symbols: Array.from({ length: 12 }, (_, i) => ({ position: i + 1, letter: String.fromCharCode(65 + i), mediaKey: `1/image/pos${i + 1}.png` })),
      symbolByPosition: {},
      outcomeTypes: [
        { type: 'NO_WIN', weight: 60, payoutMultiplier: 0, label: 'Geen winst', percentage: 60 },
        { type: 'TWO_SPLIT', weight: 20, payoutMultiplier: 1.4, label: '2 dezelfde gesplitst', percentage: 20 },
        { type: 'TWO_ADJACENT', weight: 10, payoutMultiplier: 1.8, label: '2 dezelfde naast elkaar', percentage: 10 },
        { type: 'THREE_LINE', weight: 7, payoutMultiplier: 3, label: '3 dezelfde op lijn', percentage: 7 },
        { type: 'THREE_ANYWHERE', weight: 3, payoutMultiplier: 5, label: '3 dezelfde ergens zichtbaar', percentage: 3 },
      ],
      status: { valid: true, totalWeight: 100, allocatedWeight: 100, remainingWeight: 0, symbolCount: 12, reason: 'Configuration is valid.' },
    },
    activeSlot: null,
    photoRound: null,
    pakEenZes: null,
    ...overrides,
  };
}

const render = (node: any) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

describe('admin round vocabulary', () => {
  // Mirrors rounds_type_check. If this list and that constraint diverge, the picker
  // offers a type the insert rejects.
  it('only offers round types the database accepts', () => {
    expect(ROUND_TYPES).toEqual(['LIVE_QUIZ', 'PRESENTATIE', 'PUBQUIZ', 'ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE']);
  });

  it('marks only the types with a phone-side flow as interactive', () => {
    expect(ROUND_TYPES.filter(type => roundMeta(type).interactive))
      .toEqual(['LIVE_QUIZ', 'PUBQUIZ', 'ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE']);
  });

  it('gives every type a distinct accent so rounds stay tellable apart', () => {
    const accents = ROUND_TYPES.map(type => roundMeta(type).accent);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it('counts a round\u2019s content in the noun that round actually uses', () => {
    expect(describeContent(QUIZ_ROUND)).toBe('3 questions');
    expect(describeContent({ type: 'PRESENTATIE', slides: [{ id: 1 }] })).toBe('1 slide');
    expect(describeContent({ type: 'FOTORONDE', subjects: [] })).toBe('0 subjects');
    // A game round is one thing, so it is named rather than counted.
    expect(describeContent({ type: 'ROULETTE' })).toBe('Roulette');
  });

  it('does not throw on a round type it has never seen', () => {
    expect(roundMeta('SOMETHING_NEW').label).toBe('Round');
  });
});

describe('admin pages render', () => {
  it('renders the Control Center with the active round\u2019s own content and its markets', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('ROUND 03 · LIVE QUIZ · Kennisquiz');
    // three questions plus the one unsettled market attached to the active round
    expect(html.match(/class="run-step accent-/g)?.length).toBe(4);
    expect(html).toContain('QUICK COIN ADJUSTMENT');
  });

  // Each question carries its own points, so the strip shows them rather than one
  // round-level number the host would have to remember is only a default.
  it('shows each question\u2019s own points in the strip', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('Q1 · 10p');
    expect(html).toContain('Q2 · 40p');
    expect(html).toContain('Q3 · 5p');
  });

  // Navigation is the quiz's own, not a generic block stepper.
  it('offers question navigation and the reveal flow for a live quiz', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('VORIGE');
    expect(html).toContain('VOLGENDE');
    expect(html).toContain('SLUIT VRAAG'); // question 31 is OPEN
    expect(html).toContain('1 / 3');
  });

  // The run of show is the only step navigator now. The current-round card and the
  // this-round's-content list were removed because both restated what it already shows.
  it('does not restate the run of show as a current-round card or a content list', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).not.toContain('CURRENT ROUND');
    expect(html).not.toContain('PREVIOUS');
    expect(html).not.toContain('NEXT →');
    expect(html).not.toContain('CONTENT</div>'); // "THIS ROUND'S CONTENT" eyebrow
    expect(html).not.toContain('round-content-copy');
  });

  /**
   * The presenter pair, after Preview → Go Live was removed.
   *
   * LIVE is the real projector, in an iframe. VOLGENDE is the projector's own renderer fed
   * the next state from the server. Neither is an Admin-authored description of the state,
   * which is what the staged card used to be and why it could be wrong.
   */
  describe('the presenter pair', () => {
    it('shows the live projector beside a preview of what VOLGENDE will show', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html).toContain('LIVE — OP DE PROJECTOR');
      expect(html).toContain('VOLGENDE — WAT VOLGENDE OP HET SCHERM ZET');
      // Both panes are the projector's own renderer at projector size — not an iframe, and
      // not a second interpretation of the state.
      expect(html.match(/screen-preview/g)!.length).toBeGreaterThanOrEqual(2);
      expect(html).not.toContain('<iframe');
      // and the host can still open the real thing full screen
      expect(html).toContain(`href="/screen/1"`);
    });

    // 21 · the dashboard is reached only when the projector is actually on the dashboard.
    // It used to be the fallback for every unmatched mode, which made a scene that failed
    // to load look like a perfectly healthy standings screen.
    it('never falls back to the dashboard for a mode it cannot draw', () => {
      const withBroken = adminState();
      (withBroken as any).screen = { ...slot('SLIDE', { roundId: 3, slideId: 999 }), revision: 4 };
      const html = render(createElement(ControlPage, { state: withBroken, gameId: 1, run }));
      // Nothing has been fetched yet under a static render, so LIVE is honest about that
      // rather than drawing something.
      expect(html).toContain('screen-loading');
      expect(html).not.toContain('value-chip');
    });

    // The whole point of the change: there is no intermediate state the host has chosen
    // but the room cannot see.
    it('has no staging step left anywhere', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html).not.toContain('GO LIVE');
      expect(html).not.toContain('staged-card');
      expect(html).not.toContain('is-staged');
      expect(html).not.toContain('NOT LIVE YET');
    });

    // 16-18 · one pair of buttons, directly under the two previews
    it('has exactly one VORIGE and one VOLGENDE, in one bar below the previews', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html.match(/← VORIGE/g)).toHaveLength(1);
      expect(html.match(/VOLGENDE →/g)).toHaveLength(1);
      expect(html).toContain('presenter-step-bar');
      expect(html.indexOf('VOLGENDE — WAT VOLGENDE')).toBeLessThan(html.indexOf('presenter-step-bar'));
    });

    // 19 · the small per-type navigation is gone. Round-type actions that are not
    // navigation stay, in their own place.
    it('keeps no navigation anywhere but that bar', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html).not.toContain('live-nav');
      expect(html).not.toContain('TOON OP SCHERM');
      expect(html).not.toContain('GO LIVE');
      // the quiz's own phase action is not navigation and is still offered
      expect(html).toContain('SLUIT VRAAG');
      expect(html).toContain('ACTIES');
    });

    // 3 · the recovery control is always there, not only once something has broken. By
    // the time the host notices the screen is wrong they should not also have to find it.
    it('always offers RESET SCHERM', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html).toContain('RESET SCHERM');
    });

    // The server decides whether a step is possible, so before it has answered the
    // buttons are off rather than optimistically enabled.
    it('waits for the server before enabling either button', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html).toMatch(/<button [^>]*disabled[^>]*>VOLGENDE →<\/button>/);
      expect(html).toMatch(/<button [^>]*disabled[^>]*>← VORIGE<\/button>/);
    });

    it('marks the on-air step live in the run of show', () => {
      const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
      expect(html).toContain('is-live');
    });

    it('marks nothing live once the dashboard is showing', () => {
      const html = render(createElement(ControlPage, {
        state: adminState({ screen: { ...slot('DASHBOARD'), previous: slot('QUIZ_QUESTION', { roundId: 3, questionId: 31 }) } }),
        gameId: 1, run,
      }));
      expect(html).not.toContain('is-live');
    });
  });

  it('surfaces pending player requests above everything, with a mandatory deny reason', () => {
    const none = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(none).not.toContain('request-panel');

    const html = render(createElement(ControlPage, {
      state: adminState({ predictionRequests: [
        { id: 7, playerId: 2, playerName: 'Bas', question: 'Scoort iemand een perfecte score?', status: 'PENDING', reason: '' },
        { id: 8, playerId: 1, playerName: 'Daan', question: 'Already handled', status: 'APPROVED', reason: '' },
      ] }),
      gameId: 1, run,
    }));
    expect(html).toContain('PLAYER PREDICTION REQUESTS — NEEDS REVIEW');
    expect(html).toContain('Scoort iemand een perfecte score?');
    expect(html).toContain('APPROVE');
    expect(html).toContain('DENY');
    // reviewed requests are not pending work
    expect(html).not.toContain('Already handled');
  });

  it('exposes the live prediction lifecycle on the Control Center', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('LOCK NOW');
    expect(html).toContain('RESULT YES');
    expect(html).toContain('SETTLE PAYOUTS');
    // settled markets are history, not live controls
    expect(html).not.toContain('Settled market');
  });

  // Where are we in the evening, and what still needs building — the question the run
  // of show cannot answer, because it only ever shows the live round.
  it('lists every round in the game with the one action each needs', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('ROUNDS IN THIS GAME');
    expect(html).toContain('2 ROUNDS');
    expect(html).toContain('R03 · Kennisquiz');
    expect(html).toContain('R04 · Finale');
    // one EDIT per round, handing off to that round's own page
    expect(html.match(/>EDIT</g)?.length).toBe(2);
    // the live round can be completed; nothing else can
    expect(html.match(/>COMPLETE ROUND</g)?.length).toBe(1);
    expect(html).toContain('round-line is-active');
  });

  it('calls a completed round finished, and does not offer to start it', () => {
    const state = adminState();
    state.rounds[1] = { ...state.rounds[1], status: 'COMPLETED' };
    const html = render(createElement(ControlPage, { state, gameId: 1, run }));
    expect(html).toContain('FINISHED');
    expect(html).not.toContain('>START<');
    expect(html).toContain('>EDIT<'); // still inspectable
  });

  // start-round answers a second active round with a 409, so the button says so up
  // front rather than offering an action that is going to fail.
  it('blocks START while another round is live, and frees it once none is', () => {
    const live = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(live).toMatch(/<button [^>]*disabled[^>]*title="Complete R03 first"[^>]*>START<\/button>/);

    const idle = render(createElement(ControlPage, {
      state: adminState({ game: { ...adminState().game, current_round_id: null }, activeRound: null }),
      gameId: 1, run,
    }));
    expect(idle).toContain('>START<');
    expect(idle).not.toContain('COMPLETE ROUND');
    expect(idle).toContain('No round is being played');
  });

  it('says so plainly when the game has no rounds at all', () => {
    const state = adminState({
      game: { ...adminState().game, current_round_id: null },
      rounds: [], activeRound: null,
    });
    const html = render(createElement(ControlPage, { state, gameId: 1, run }));
    expect(html).toContain('No rounds yet');
  });

  it('renders the Rounds index with the create form collapsed', () => {
    const html = render(createElement(RoundsPage, { state: adminState(), gameId: 1, roundId: null, run }));
    expect(html).toContain('+ NEW ROUND');
    expect(html).not.toContain('WHAT KIND OF ROUND IS THIS?');
    expect(html).toContain('A round is one segment of the night');
    // The list names each round's type, because that is what decides everything else
    // about it.
    expect(html).toContain('LIVE QUIZ');
    expect(html).toContain('3 questions');
  });

  // The type is chosen once, at creation, and never offered again — content authored
  // under one type has nowhere to go under another.
  it('offers the type picker when creating a round, and not inside one', () => {
    const detail = render(createElement(RoundsPage, { state: adminState(), gameId: 1, roundId: 3, run }));
    expect(detail).not.toContain('round-type-tile');
    expect(detail).not.toContain('WHAT KIND OF ROUND IS THIS?');
  });

  // The editor is the one that belongs to the round's type, not a shared block form.
  it('renders the quiz editor for a LIVE_QUIZ round', () => {
    const html = render(createElement(RoundsPage, { state: adminState(), gameId: 1, roundId: 3, run }));
    expect(html).toContain('ADD A QUESTION');
    expect(html).toContain('ANSWER OPTIONS · TICK EVERY CORRECT ONE');
    expect(html).toContain('Points for this question');
    expect(html).toContain('Hoofdstad van Frankrijk?');
    expect(html).toContain('ROUND GROUPS');
    // No slide or subject editor in sight — this round is not those types.
    expect(html).not.toContain('ADD A PAGE');
    expect(html).not.toContain('ADD A SUBJECT');
  });

  it('renders the presentation editor for a PRESENTATIE round', () => {
    const state = adminState({
      rounds: [{ ...QUIZ_ROUND, id: 9, type: 'PRESENTATIE', title: 'Intro', questions: undefined, slides: [] }],
    });
    const html = render(createElement(RoundsPage, { state, gameId: 1, roundId: 9, run }));
    expect(html).toContain('ADD A PAGE');
    expect(html).toContain('THE SECRET — WHAT STAYS OFF THE PROJECTOR UNTIL YOU REVEAL');
    expect(html).not.toContain('ADD A QUESTION');
  });

  /**
   * The presentation editor has to answer four questions at a glance: what the pages are,
   * what order they are in, which are part of the run, and which one the room is looking
   * at. A held-back page is the one that is easy to get wrong — it has to stay fully
   * visible here while being absent from the projector.
   */
  describe('the presentation editor', () => {
    const page = (id: number, sortOrder: number, title: string, extra: Record<string, unknown> = {}) => ({
      id, roundId: 9, sortOrder, title, body: '', mediaKey: null, mediaKind: null, mediaName: null,
      revealText: null, hideTitleUntilReveal: false, hidden: false, revealedAt: null, revision: 0, ...extra,
    });

    const presentation = (overrides: Record<string, unknown> = {}) => adminState({
      rounds: [{
        ...QUIZ_ROUND, id: 9, type: 'PRESENTATIE', title: 'Intro', status: 'ACTIVE', questions: undefined,
        slides: [page(1, 0, 'Welkom'), page(2, 1, 'Reserve', { hidden: true }), page(3, 2, 'Slot')],
      }],
      ...overrides,
    });

    const editor = (state: any) => render(createElement(RoundsPage, { state, gameId: 1, roundId: 9, run }));

    it('lists every page, held back or not, in its authored order', () => {
      const html = editor(presentation());
      expect(html).toContain('Welkom');
      expect(html).toContain('Reserve');
      expect(html).toContain('Slot');
      expect(html.indexOf('Welkom')).toBeLessThan(html.indexOf('Reserve'));
      expect(html.indexOf('Reserve')).toBeLessThan(html.indexOf('Slot'));
      expect(html).toContain('01 · PAGE');
      expect(html).toContain('02 · PAGE · NOT IN THE RUN');
    });

    it('says which pages are in the run and which are held back', () => {
      const html = editor(presentation());
      expect(html.match(/>VISIBLE</g)).toHaveLength(2);
      expect(html.match(/>HIDDEN</g)).toHaveLength(1);
      expect(html).toContain('2 pages in the run, 1 held back');
    });

    it('offers MAKE VISIBLE on a held-back page and HIDE on the others', () => {
      const html = editor(presentation());
      expect(html.match(/>MAKE VISIBLE</g)).toHaveLength(1);
      expect(html.match(/>HIDE</g)).toHaveLength(2);
    });

    // A held-back page gets no SHOW ON SCREEN, because the server would refuse it. The
    // one step needed first is the button right beside it.
    it('offers SHOW ON SCREEN only for pages that can actually be shown', () => {
      const html = editor(presentation());
      expect(html.match(/>SHOW ON SCREEN</g)).toHaveLength(2);
    });

    it('marks the page the projector is pointed at', () => {
      const html = editor(presentation({ screen: slot('SLIDE', { roundId: 9, slideId: 3 }) }));
      expect(html).toContain('ON SCREEN');
      expect(html).toContain('is-live-card');
      // and that page does not offer to be shown again
      expect(html.match(/>SHOW ON SCREEN</g)).toHaveLength(1);
    });

    it('cannot send anything to the screen before the round is started', () => {
      const state = presentation();
      state.rounds[0].status = 'UPCOMING';
      const html = editor(state);
      expect(html).toContain('Start the round to put a page on the big screen');
      expect(html).toMatch(/<button [^>]*disabled[^>]*>SHOW ON SCREEN<\/button>/);
    });
  });

  /**
   * The Pubquiz editor. A presentation-style list of pages that happen to be questions,
   * so it has to show both halves: the run and its order, and the answer key with points.
   */
  describe('the pubquiz editor', () => {
    const pubQuestion = (id: number, sortOrder: number, text: string, extra: Record<string, unknown> = {}) => ({
      id, roundId: 9, sortOrder, question: text, body: '', points: 25,
      mediaKey: null, mediaName: null, timeLimitSeconds: null, hidden: false,
      status: 'READY', openedAt: null, closedAt: null, revealedAt: null, revision: 0,
      results: { tally: [], answered: 0, correct: 0, participation: { answered: 0, eligible: 2, remaining: 2, percentage: 0 } },
      options: [
        { id: id * 10 + 1, sortOrder: 0, text: 'Lima', isCorrect: true },
        { id: id * 10 + 2, sortOrder: 1, text: 'La Paz', isCorrect: false },
      ],
      ...extra,
    });

    const pubquizState = (overrides: Record<string, unknown> = {}) => adminState({
      rounds: [{
        ...QUIZ_ROUND, id: 9, type: 'PUBQUIZ', title: 'Pubquiz', status: 'ACTIVE', questions: undefined,
        pubquizQuestions: [
          pubQuestion(1, 0, 'Hoofdstad van Peru?'),
          pubQuestion(2, 1, 'Reserve', { hidden: true }),
        ],
      }],
      ...overrides,
    });

    const editor = (state: any) => render(createElement(RoundsPage, { state, gameId: 1, roundId: 9, run }));

    it('opens its own editor, not the quiz or slide one', () => {
      const html = editor(pubquizState());
      expect(html).toContain('ADD A QUESTION');
      expect(html).toContain('ANSWERS — PICK THE CORRECT ONE');
      expect(html).not.toContain('THE SECRET — WHAT STAYS OFF THE PROJECTOR UNTIL YOU REVEAL');
    });

    it('lists the questions in order, with their points and answers', () => {
      const html = editor(pubquizState());
      expect(html).toContain('Hoofdstad van Peru?');
      expect(html).toContain('01 · QUESTION · 25P');
      expect(html).toContain('Lima');
      expect(html).toContain('La Paz');
    });

    it('says which questions are in the run and which are held back', () => {
      const html = editor(pubquizState());
      expect(html.match(/>VISIBLE</g)).toHaveLength(1);
      expect(html.match(/>HIDDEN</g)).toHaveLength(1);
      expect(html).toContain('1 question in the run, 1 held back');
      expect(html.match(/>MAKE VISIBLE</g)).toHaveLength(1);
    });

    // A held-back question gets no SHOW ON SCREEN, because the server would refuse it.
    it('offers SHOW ON SCREEN only for questions that can be shown', () => {
      const html = editor(pubquizState());
      expect(html.match(/>SHOW ON SCREEN</g)).toHaveLength(1);
    });

    it('marks the question the projector is pointed at', () => {
      const html = editor(pubquizState({ screen: slot('PUBQUIZ_QUESTION', { roundId: 9 }) as any }));
      // the fixture's slot helper carries no pubquiz pointer, so add it directly
      const withPointer = pubquizState();
      (withPointer as any).screen = { ...slot('PUBQUIZ_QUESTION', { roundId: 9 }), pubquizQuestionId: 1 };
      const marked = editor(withPointer);
      expect(marked).toContain('ON SCREEN');
      expect(marked).toContain('is-live-card');
      expect(html).toBeTruthy();
    });

    // The answer key belongs to the host and to nobody else, but it must be right here.
    it('marks the correct answer for the host', () => {
      const html = editor(pubquizState());
      expect(html).toContain('quiz-answer is-correct');
    });
  });

  it('renders the Fotoronde editor with per-subject credits', () => {
    const state = adminState({
      rounds: [{ ...QUIZ_ROUND, id: 9, type: 'FOTORONDE', title: 'Fotoronde', questions: undefined, subjects: [{ id: 1, sortOrder: 0, key: 'moois', label: 'Iets moois', points: 15, referenceMediaKey: null }] }],
    });
    const html = render(createElement(RoundsPage, { state, gameId: 1, roundId: 9, run }));
    expect(html).toContain('ADD A SUBJECT');
    expect(html).toContain('Iets moois');
    expect(html).toContain('15 CREDITS');
  });

  // A game round has nothing to author beyond its own settings, and says so rather than
  // showing an empty content list.
  it('says there is nothing to author for a Pak een Zes round', () => {
    const state = adminState({
      rounds: [{ ...QUIZ_ROUND, id: 9, type: 'PAK_EEN_ZES', title: 'Pak een Zes', questions: undefined, defaultPoints: 25 }],
    });
    const html = render(createElement(RoundsPage, { state, gameId: 1, roundId: 9, run }));
    expect(html).toContain('Nothing to author');
    expect(html).toContain('25');
  });

  it('renders a read-only round detail for a completed round', () => {
    const state = adminState({ rounds: [{ ...QUIZ_ROUND, status: 'COMPLETED' }, FINALE_ROUND] });
    const html = render(createElement(RoundsPage, { state, gameId: 1, roundId: 3, run }));
    expect(html).not.toContain('ADD A QUESTION');
    expect(html).toContain('Membership is frozen');
  });

  it('renders Predictions with three primary metrics and no duplicated lifecycle', () => {
    const html = render(createElement(PredictionsPage, { state: adminState(), run }));
    expect(html).toContain('PARTICIPATION');
    expect(html).toContain('Live controls are on the Control Center');
    expect(html).not.toContain('SETTLE PAYOUTS');
    expect(html).not.toContain('RESULT YES');
    expect(html).toContain('CREATE MARKET');
    // the design's three-column deposit row
    expect(html).toContain('form-grid triple');
    expect(html).toContain('Min deposit (coins)');
    expect(html).toContain('Max deposit (coins)');
  });

  // The design draws fewer controls than this app has. Each of these is a relocation,
  // so one assertion per action: a later restyle cannot quietly drop an endpoint's only
  // entry point.
  it('keeps every prediction action reachable from the market cards', () => {
    const state = adminState();
    state.predictions[0] = { ...state.predictions[0], status: 'DRAFT' };
    const html = render(createElement(PredictionsPage, { state, run }));
    expect(html).toContain('EDIT');
    expect(html).toContain('OPEN NOW');
    expect(html).toContain('DELETE');
    expect(html).toContain('CANCEL + REFUND');
    // relocated out of the design's form, not dropped
    expect(html).toContain('Duration (seconds)');
    expect(html).toContain('Scheduled — automatically open on the linked round');
  });

  it('keeps every player action reachable from the player cards', () => {
    const html = render(createElement(PlayersPage, { state: adminState(), gameId: 1, run, setMsg: () => {} }));
    expect(html).toContain('ADD PLAYER');
    // the design pairs status with the join link beside the name
    expect(html).toContain('player-row-actions');
    expect(html).toContain('REGENERATE JOIN LINK'); // player 1 has joined
    expect(html).toContain('GENERATE JOIN LINK');   // player 2 has not
    expect(html).toContain('NEW LINK + REVOKE SESSION');
    expect(html).toContain('EDIT');
    expect(html).toContain('ADJUST COINS');
    expect(html).toContain('DEACTIVATE');
  });

  // A reset restores the standard ten and removes everyone else, so which of the two a
  // player is has to be visible on the card rather than only described in Settings.
  it('says which players are the standard ten and which were added by hand', () => {
    const html = render(createElement(PlayersPage, { state: adminState(), gameId: 1, run, setMsg: () => {} }));
    expect(html).toContain('Standard player');
    // one marker, for Jordi — Jorrit was added by hand and carries none
    expect(html.match(/Standard player/g)).toHaveLength(1);
    expect(html).toContain('a reset removes them and restores the standard ten');
  });

  it('gates the game reset on the typed phrase and keeps the wallet cap setting', () => {
    const html = render(createElement(SettingsPage, { state: adminState(), gameId: 1, run, onReset: () => {} }));
    expect(html).toContain('DANGER ZONE');
    expect(html).not.toContain('modal-backdrop');
    expect(html).toContain('DELETE GAME SAVE');
    // the button is dead until "yes delete" is typed
    expect(html).toMatch(/<button [^>]*disabled[^>]*>DELETE GAME SAVE<\/button>/);
    expect(html).toContain('Max wallet % per prediction');
  });

  it('offers Full Reset separately from Delete Game Save, gated on its own phrase', () => {
    const html = render(createElement(SettingsPage, { state: adminState(), gameId: 1, run, onReset: () => {} }));
    expect(html).toContain('RESET AVOND');
    expect(html).toContain('Full Reset');
    // Dead until the exact phrase is typed, and it is not the delete phrase.
    expect(html).toMatch(/<button [^>]*disabled[^>]*>RESET AVOND<\/button>/);
    expect(html).toContain('placeholder="RESET AVOND"');
    // Both destructive actions stay available and stay distinguishable.
    expect(html).toContain('DELETE GAME SAVE');
    // The gentler action reads first, so a host does not scroll past it to the harsher one.
    expect(html.indexOf('Full Reset')).toBeLessThan(html.indexOf('Delete Game Save'));
  });

  it('renders the Ledger with the readable list first and the full table behind it', () => {
    const html = render(createElement(LedgerPage, { state: adminState(), gameId: 1 }));
    expect(html).toContain('LEDGER FILTER');
    // the entries themselves arrive from a one-shot fetch, which effects do not run here
    expect(html).toContain('Loading ledger');
    expect(html).not.toContain('table-wrap');
  });

  it('renders the Market page before its screen snapshot arrives', () => {
    const html = render(createElement(MarketPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('SHOW ON BIG SCREEN');
    expect(html).toContain('Loading exchange data');
  });

  it('renders an empty game without throwing', () => {
    const empty = { ...adminState(), rounds: [], players: [], predictions: [], recentTransactions: [], activeRound: null, game: { ...adminState().game, current_round_id: null } };
    expect(() => render(createElement(ControlPage, { state: empty, gameId: 1, run }))).not.toThrow();
    expect(() => render(createElement(RoundsPage, { state: empty, gameId: 1, roundId: null, run }))).not.toThrow();
    expect(() => render(createElement(PredictionsPage, { state: empty, run }))).not.toThrow();
    expect(render(createElement(ControlPage, { state: empty, gameId: 1, run }))).toContain('FIRST SETUP');
  });
});
