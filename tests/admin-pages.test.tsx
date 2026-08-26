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
import { AUTHORABLE_BLOCK_TYPES, blockLabel, blockMeta } from '../src/components/admin/blockMeta';

const run = async () => true;

function adminState(overrides: Record<string, unknown> = {}) {
  const blocks = [
    { id: 31, round_id: 3, type: 'TEXT', title: 'Ronde uitleg', payload: {}, answer_count: 0 },
    { id: 32, round_id: 3, type: 'QUESTION', title: 'Hoeveel hoofdsteden ken jij?', payload: {}, answer_count: 0 },
    { id: 33, round_id: 3, type: 'DUOLINGO_QUESTION', title: 'Hoofdstad van Frankrijk?', interactive_status: 'OPEN', payload: { rewardCoins: 10, answers: ['a', 'b', 'c', 'd'], correctAnswerIndex: 0 }, answer_count: 2 },
    { id: 34, round_id: 3, type: 'ROULETTE', title: 'Bonusronde Roulette', interactive_status: 'DRAFT', payload: {}, answer_count: 0 },
  ];
  return {
    version: 1,
    game: { id: 1, name: 'Game Night #12', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: 3, current_round_block_id: 33, current_screen_mode: 'ROUND_BLOCK', game_state_version: 1 },
    screen: { mode: 'ROUND_BLOCK', predictionId: null, blockId: 33 },
    rounds: [
      { id: 3, round_number: 3, title: 'Kennisquiz', status: 'ACTIVE', description: '', blocks, groups: [{ id: 1, round_id: 3, name: 'Team Rood', members: [{ id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true }] }] },
      { id: 4, round_number: 4, title: 'Finale', status: 'UPCOMING', description: '', blocks: [], groups: [] },
    ],
    currentBlock: blocks[2],
    players: [
      { id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true, current_balance: 340, locked_prediction: 40, rank: 1, joined: true },
      { id: 2, display_name: 'Jorrit', public_color: '#E8352F', active: true, current_balance: 260, locked_prediction: 0, rank: 2, joined: false },
    ],
    predictions: [
      { id: 1, display_number: 1, question: 'Wint Team Blauw de bonusronde?', round_id: 3, round_number: 3, status: 'OPEN', probability_yes: 0.55, yes_odds: 1.8, no_odds: 2.2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: new Date(Date.now() + 60_000).toISOString(), result: null },
      { id: 2, display_number: 2, question: 'Perfecte score in de Film Kwis?', round_id: null, round_number: null, status: 'LOCKED', probability_yes: 0.3, yes_odds: 3, no_odds: 1.4, participation_count: 4, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: null },
      { id: 3, display_number: 3, question: 'Awaiting payout', round_id: null, round_number: null, status: 'RESULT', probability_yes: 0.5, yes_odds: 2, no_odds: 2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: 'YES' },
      { id: 4, display_number: 4, question: 'Settled market', round_id: null, round_number: null, status: 'SETTLED', probability_yes: 0.5, yes_odds: 2, no_odds: 2, participation_count: 2, minimum_stake: 5, maximum_stake: 100, prediction_time_seconds: 90, closes_at: null, result: 'NO' },
    ],
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
    expect(html).toContain('PART 3 OF 4');
    expect(html).toContain('round-content-summary');
    expect(html).toContain('QUICK COIN ADJUSTMENT');
  });

  it('marks the on-air block live, and nothing live while the dashboard is up', () => {
    const onAir = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(onAir).toContain('is-live');

    const onDashboard = render(createElement(ControlPage, {
      state: adminState({ screen: { mode: 'DASHBOARD', predictionId: null, blockId: null } }),
      gameId: 1, run,
    }));
    expect(onDashboard).not.toContain('is-live');
    expect(onDashboard).toContain('DASHBOARD IS LIVE');
  });

  it('exposes the live prediction lifecycle on the Control Center', () => {
    const html = render(createElement(ControlPage, { state: adminState(), gameId: 1, run }));
    expect(html).toContain('LOCK NOW');
    expect(html).toContain('RESULT YES');
    expect(html).toContain('SETTLE PAYOUTS');
    // settled markets are history, not live controls
    expect(html).not.toContain('Settled market');
  });

  it('renders the Control Center with no active round', () => {
    const state = adminState({ game: { ...adminState().game, current_round_id: null, current_round_block_id: null }, currentBlock: null });
    const html = render(createElement(ControlPage, { state, gameId: 1, run }));
    expect(html).toContain('No round active');
    expect(html).not.toContain('RUN OF SHOW');
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
  });

  it('renders Players and Settings', () => {
    const players = render(createElement(PlayersPage, { state: adminState(), gameId: 1, run, setMsg: () => {} }));
    expect(players).toContain('ADD PLAYER');
    expect(players).toContain('GENERATE JOIN LINK');

    const settings = render(createElement(SettingsPage, { state: adminState(), run, onReset: () => {} }));
    expect(settings).toContain('DANGER ZONE');
    // the confirmation is inline now, revealed only after the first click
    expect(settings).not.toContain('modal-backdrop');
    expect(settings).toContain('DELETE GAME SAVE');
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
