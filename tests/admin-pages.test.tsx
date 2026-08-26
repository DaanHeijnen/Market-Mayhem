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
import { AUTHORABLE_BLOCK_TYPES, blockLabel, blockMeta } from '../src/components/admin/blockMeta';
import { orderRunOfShow } from '../netlify/lib/run-of-show';

const run = async () => true;

/** Presentation slot in the shape getAdminState returns. */
const slot = (mode: string | null, blockId: number | null = null, predictionId: number | null = null, roundId: number | null = null) =>
  ({ mode, roundId, blockId, predictionId });

function adminState(overrides: Record<string, unknown> = {}) {
  const blocks = [
    { id: 31, round_id: 3, type: 'TEXT', title: 'Ronde uitleg', sort_order: 1, payload: {}, answer_count: 0 },
    { id: 32, round_id: 3, type: 'QUESTION', title: 'Hoeveel hoofdsteden ken jij?', sort_order: 2, payload: {}, answer_count: 0 },
    { id: 33, round_id: 3, type: 'DUOLINGO_QUESTION', title: 'Hoofdstad van Frankrijk?', sort_order: 3, interactive_status: 'OPEN', payload: { rewardCoins: 10, answers: ['a', 'b', 'c', 'd'], correctAnswerIndex: 0 }, answer_count: 2 },
    { id: 34, round_id: 3, type: 'ROULETTE', title: 'Bonusronde Roulette', sort_order: 4, interactive_status: 'DRAFT', payload: {}, answer_count: 0 },
  ];
  const predictions = [
    { id: 1, display_number: 1, question: 'Wint Team Blauw de bonusronde?', round_id: 3, round_number: 3, status: 'OPEN', probability_yes: 0.55, yes_odds: 1.8, no_odds: 2.2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: new Date(Date.now() + 60_000).toISOString(), result: null },
    { id: 2, display_number: 2, question: 'Perfecte score in de Film Kwis?', round_id: null, round_number: null, status: 'LOCKED', probability_yes: 0.3, yes_odds: 3, no_odds: 1.4, participation_count: 4, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: null },
    { id: 3, display_number: 3, question: 'Awaiting payout', round_id: null, round_number: null, status: 'RESULT', probability_yes: 0.5, yes_odds: 2, no_odds: 2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: 'YES' },
    { id: 4, display_number: 4, question: 'Settled market', round_id: null, round_number: null, status: 'SETTLED', probability_yes: 0.5, yes_odds: 2, no_odds: 2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: 'NO' },
  ];
  const activeRoundId = 3;
  return {
    version: 1,
    game: { id: 1, name: 'Game Night #12', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: activeRoundId, current_round_block_id: 33, current_screen_mode: 'ROUND_BLOCK', game_state_version: 1 },
    screen: {
      ...slot('ROUND_BLOCK', 33, null, activeRoundId),
      staged: slot('ROUND_BLOCK', 34, null, activeRoundId),
      previous: slot(null),
    },
    // Built with the same function the server uses, so the fixture cannot drift from
    // the real payload's ordering.
    runOfShow: orderRunOfShow(blocks, predictions, activeRoundId),
    predictionRequests: [] as unknown[],
    rounds: [
      { id: 3, round_number: 3, title: 'Kennisquiz', status: 'ACTIVE', description: '', blocks, groups: [{ id: 1, round_id: 3, name: 'Team Rood', members: [{ id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true }] }] },
      { id: 4, round_number: 4, title: 'Finale', status: 'UPCOMING', description: '', blocks: [], groups: [] },
    ],
    currentBlock: blocks[2],
    players: [
      { id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true, current_balance: 340, locked_prediction: 40, rank: 1, joined: true },
      { id: 2, display_name: 'Jorrit', public_color: '#E8352F', active: true, current_balance: 260, locked_prediction: 0, rank: 2, joined: false },
    ],
    predictions,
    activePredictions: [] as unknown[],
    recentTransactions: [{ id: 1, amount: -20, description: 'Prediction deposit #1', transaction_type: 'BET', created_at: new Date().toISOString(), display_name: 'Daan', round_number: 3, prediction_number: 1, roulette_game_id: null, group_name: null }],
    activeRoulette: null,
    ...overrides,
  };
}

const render = (node: any) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

describe('admin block vocabulary', () => {
  // Mirrors round_blocks_type_check. Migration 0007 widened it to all eight; if this
  // list and that constraint ever diverge, the picker offers a type the insert rejects.
  it('only offers block types the database accepts', () => {
    expect(AUTHORABLE_BLOCK_TYPES).toEqual(['TEXT', 'QUESTION', 'DUOLINGO_QUESTION', 'ROULETTE', 'PICTURE', 'MUSIC', 'BUZZER', 'WAGER']);
  });

  it('marks only the types with a phone-side flow as interactive', () => {
    const interactive = AUTHORABLE_BLOCK_TYPES.filter(type => blockMeta(type).interactive);
    expect(interactive).toEqual(['DUOLINGO_QUESTION', 'ROULETTE']);
  });

  it('gives every type a distinct accent so run-of-show steps stay tellable apart', () => {
    const accents = AUTHORABLE_BLOCK_TYPES.map(type => blockMeta(type).accent);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it('falls back to the type label when a block has no title', () => {
    expect(blockLabel({ type: 'ROULETTE', title: '' })).toBe('Roulette');
    expect(blockLabel({ type: 'ROULETTE', title: 'Bonusronde' })).toBe('Bonusronde');
  });

  it('does not throw on a block type it has never seen', () => {
    expect(blockMeta('SOMETHING_NEW').label).toBe('Content block');
  });
});

describe('admin pages render', () => {
  it('renders the Control Center with a run of show covering blocks and unsettled markets', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('RUN OF SHOW');
    // four content blocks plus the one unsettled market attached to the active round
    expect(html.match(/class="run-step accent-/g)?.length).toBe(5);
    expect(html).toContain('QUICK COIN ADJUSTMENT');
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

  // The presenter pair is the point of the redesign: live is the real projector output,
  // staged is what GO LIVE will promote, and the two must be visibly distinct.
  it('shows the live projector output beside the staged step', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('LIVE — ON THE PROJECTOR NOW');
    expect(html).toContain('PREVIEW — STAGED, NOT LIVE YET');
    expect(html).toContain(`src="/screen/1"`); // live side is the real screen, not a mock
    expect(html).toContain('staged-card');
    expect(html).toContain('GO LIVE →');
  });

  it('renders the staged step in its own accent and marks it pending', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    // staged is block 34, the roulette block, so the card takes the roulette accent
    expect(html).toContain('staged-card accent-red is-pending');
    expect(html).toContain('Bonusronde Roulette');
  });

  it('disables GO LIVE and drops the pending edge once staged matches live', () => {
    const state = adminState();
    state.screen.staged = { ...state.screen, staged: undefined, previous: undefined } as any;
    state.screen.staged = slot('ROUND_BLOCK', 33, null, 3);
    const html = render(createElement(ControlPage, { state, gameId: 1, run }));
    expect(html).toContain('ALREADY LIVE');
    expect(html).toContain('PREVIEW — ALREADY LIVE');
    expect(html).not.toContain('is-pending');
  });

  it('marks the on-air step live in the run of show, and the staged one staged', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('is-live');
    expect(html).toContain('is-staged');
  });

  it('offers the dashboard as a step but marks nothing live once it is showing', () => {
    const html = render(createElement(ControlPage, {
      state: adminState({ screen: { ...slot('DASHBOARD'), staged: slot('ROUND_BLOCK', 31, null, 3), previous: slot('ROUND_BLOCK', 33, null, 3) } }),
      gameId: 1, run,
    }));
    expect(html).not.toContain('is-live');
    expect(html).toContain('is-staged');
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
      state: adminState({ game: { ...adminState().game, current_round_id: null, current_round_block_id: null }, currentBlock: null, runOfShow: [] }),
      gameId: 1, run,
    }));
    expect(idle).toContain('>START<');
    expect(idle).not.toContain('disabled');
    expect(idle).not.toContain('RUN OF SHOW');
    expect(idle).not.toContain('COMPLETE ROUND');
  });

  it('says so plainly when the game has no rounds at all', () => {
    const state = adminState({
      game: { ...adminState().game, current_round_id: null, current_round_block_id: null },
      rounds: [], currentBlock: null, runOfShow: [],
    });
    const html = render(createElement(ControlPage, { state, gameId: 1, run }));
    expect(html).toContain('No rounds yet');
  });

  it('renders the Rounds index with the create form collapsed', () => {
    const html = render(createElement(RoundsPage, { state: adminState(), gameId: 1, roundId: null, run }));
    expect(html).toContain('+ NEW ROUND');
    expect(html).not.toContain('CREATE ROUND');
    expect(html).toContain('A round is one segment of the night');
  });

  it('renders the round detail with one picker tile per authorable type', () => {
    const html = render(createElement(RoundsPage, { state: adminState(), gameId: 1, roundId: 3, run }));
    expect(html).toContain('ADD CONTENT — CHOOSE WHAT HAPPENS');
    expect(html.match(/class="block-type-tile/g)?.length).toBe(AUTHORABLE_BLOCK_TYPES.length);
    expect(html).toContain('Phones switch to 4 big answer buttons');
    expect(html).toContain('ROUND GROUPS');
  });

  it('renders a read-only round detail for a completed round', () => {
    const state = adminState();
    state.rounds[0].status = 'COMPLETED';
    const html = render(createElement(RoundsPage, { state, gameId: 1, roundId: 3, run }));
    expect(html).not.toContain('ADD CONTENT — CHOOSE WHAT HAPPENS');
    expect(html).not.toContain('block-type-tile');
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

  it('gates the game reset on the typed phrase and keeps the wallet cap setting', () => {
    const html = render(createElement(SettingsPage, { state: adminState(), run, onReset: () => {} }));
    expect(html).toContain('DANGER ZONE');
    expect(html).not.toContain('modal-backdrop');
    expect(html).toContain('DELETE GAME SAVE');
    // the button is dead until "yes delete" is typed
    expect(html).toMatch(/<button [^>]*disabled[^>]*>DELETE GAME SAVE<\/button>/);
    expect(html).toContain('Max wallet % per prediction');
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
    const empty = { ...adminState(), rounds: [], players: [], predictions: [], recentTransactions: [], currentBlock: null, game: { ...adminState().game, current_round_id: null, current_round_block_id: null } };
    expect(() => render(createElement(ControlPage, { state: empty, gameId: 1, run }))).not.toThrow();
    expect(() => render(createElement(RoundsPage, { state: empty, gameId: 1, roundId: null, run }))).not.toThrow();
    expect(() => render(createElement(PredictionsPage, { state: empty, run }))).not.toThrow();
    expect(render(createElement(ControlPage, { state: empty, gameId: 1, run }))).toContain('FIRST SETUP');
  });
});
