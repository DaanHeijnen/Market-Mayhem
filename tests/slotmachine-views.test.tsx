import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { MobileViews } from '../src/components/mobile/MobileViews';
import { SlotMachineSettings } from '../src/components/admin/settings/SlotMachineSettings';
import { SlotReels } from '../src/components/shared/SlotReels';
import { ControlPage } from '../src/components/admin/control/ControlPage';

const noop = () => {};
const run = async () => true;
const render = (node: any) => renderToStaticMarkup(node);
const renderRouted = (node: any) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

/** The `slotmachine` block of a player-state payload. */
function slotmachine(overrides: Record<string, unknown> = {}) {
  return {
    blockId: 35,
    roundId: 3,
    title: 'Gokkast',
    instructions: 'Kies je inzet en het aantal spins.',
    maxSpins: 20,
    allowed: true,
    configValid: true,
    configReason: 'Configuration is valid.',
    series: null,
    lastSeries: null,
    turn: null,
    ...overrides,
  };
}

/** A turn payload as the player snapshot builds it. `mine` means this player is up. */
function turn(overrides: Record<string, unknown> = {}) {
  return {
    current: { playerId: 1, name: 'Daan', spinsRemaining: 10, totalSpins: 10, stakePerSpin: 5 },
    next: null,
    spinning: false,
    isMyTurn: true,
    maySpin: true,
    waitingFor: null,
    allDone: false,
    ...overrides,
  };
}

const activeSeries = (spinsRemaining = 10) =>
  ({ id: 9, stakePerSpin: 5, totalSpins: 10, spinsRemaining, totalStake: 50, status: 'ACTIVE', lastSpin: null });

function playerState(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    player: { id: 1, name: 'Daan', color: '#9B2FF2', rank: 1, balance: 340, startingBalance: 100, lockedPrediction: 0, lockedRoulette: 0, lockedSlot: 0, totalValue: 340 },
    settings: { maximumWalletPercentage: null },
    predictions: [],
    predictionAvailable: false,
    actionable: true,
    roulette: null,
    interactiveBlock: null,
    slotmachine: null,
    recentLedger: [],
    predictionRequests: { mine: [], remaining: 2, cooldownMinutesLeft: 0 },
    ...overrides,
  };
}

describe('slotmachine on the phone', () => {
  // Backend-driven, like the live question: the block being live is what puts the
  // controller on the phone, not a route the player can navigate to.
  it('takes over any view while the slotmachine block is live', () => {
    const state = playerState({ slotmachine: slotmachine() });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('SLOTMACHINE');
    expect(html).toContain('Gokkast');
    expect(html).not.toContain('AVAILABLE WALLET');
  });

  it('disappears again when no slotmachine block is live', () => {
    const html = render(createElement(MobileViews, { state: playerState(), gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('AVAILABLE WALLET');
    expect(html).not.toContain('INZET VASTZETTEN');
  });

  // The single most important property of this screen: the machine lives on the
  // projector, and the phone is only a controller.
  it('never renders reels on the phone', () => {
    const state = playerState({
      slotmachine: slotmachine({ series: { id: 9, stakePerSpin: 5, totalSpins: 10, spinsRemaining: 7, totalStake: 50, status: 'ACTIVE', lastSpin: { spinNumber: 3, outcome: '2 dezelfde naast elkaar', payoutMultiplier: 1.8, payout: 9, status: 'RESULT' } } }),
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).not.toContain('slot-reels');
    expect(html).not.toContain('slot-reel-strip');
    expect(html).not.toContain('slot-win-overlay');
    expect(html).toContain('Watch the reels on the big screen');
  });

  it('offers stake and spin pickers with the total before a series is locked', () => {
    const state = playerState({ slotmachine: slotmachine() });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('INZET PER SPIN');
    expect(html).toContain('AANTAL SPINS · MAX 20');
    expect(html).toContain('TOTALE INZET');
    expect(html).toContain('INZET VASTZETTEN');
    expect(html).not.toContain('SPIN ·');
  });

  it('replaces the pickers with SPIN once the series is locked', () => {
    const state = playerState({
      slotmachine: slotmachine({ series: activeSeries(10), turn: turn() }),
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('INZET VASTGEZET');
    expect(html).toContain('SPIN · 10 LEFT');
    // Stake and spin count are frozen — the pickers are gone entirely, not merely disabled.
    expect(html).not.toContain('INZET PER SPIN');
    expect(html).not.toContain('INZET VASTZETTEN');
  });

  // The anti-spam rule, from the phone's side: the button is dead while the spin is
  // still resolving. The backend refuses it too; this only spares the round trip.
  it('disables SPIN while the reels are still turning, so a second tap cannot land', () => {
    const state = playerState({
      slotmachine: slotmachine({
        series: { ...activeSeries(9), lastSpin: { spinNumber: 1, outcome: null, payoutMultiplier: null, payout: null, status: 'SPINNING' } },
        turn: turn({ spinning: true, maySpin: false, current: { playerId: 1, name: 'Daan', spinsRemaining: 9, totalSpins: 10, stakePerSpin: 5 } }),
      }),
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toMatch(/<button [^>]*disabled[^>]*>DRAAIT…<\/button>/);
  });

  it('withholds the outcome the server has not revealed yet', () => {
    const state = playerState({
      slotmachine: slotmachine({ series: { id: 9, stakePerSpin: 5, totalSpins: 10, spinsRemaining: 9, totalStake: 50, status: 'ACTIVE', lastSpin: { spinNumber: 1, outcome: null, payoutMultiplier: null, payout: null, status: 'SPINNING' } } }),
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('Look at the big screen');
  });

  // The phone names the category, never the symbols — the payout belongs to the pattern.
  it('names the outcome category and payout once revealed', () => {
    const state = playerState({
      slotmachine: slotmachine({ series: { id: 9, stakePerSpin: 5, totalSpins: 10, spinsRemaining: 7, totalStake: 50, status: 'ACTIVE', lastSpin: { spinNumber: 3, outcome: '2 dezelfde naast elkaar', payoutMultiplier: 1.8, payout: 9, status: 'RESULT' } } }),
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('2 dezelfde naast elkaar');
    expect(html).toContain('+9 coins at 1.8x');
  });

  it('explains an unusable machine instead of offering a control that would fail', () => {
    const state = playerState({ slotmachine: slotmachine({ configValid: false, configReason: 'Configuration is not complete — 3 of 100 chances are unassigned.' }) });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('not ready yet');
    expect(html).toContain('3 of 100 chances are unassigned');
    expect(html).not.toContain('INZET VASTZETTEN');
  });

  it('tells an excluded player they are not in this one', () => {
    const state = playerState({ slotmachine: slotmachine({ allowed: false }) });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('not taking part');
    expect(html).not.toContain('INZET VASTZETTEN');
  });

  it('refuses to lock when the wallet cannot cover a single spin', () => {
    const state = playerState({
      player: { id: 1, name: 'Daan', color: '#9B2FF2', rank: 4, balance: 0, startingBalance: 100, lockedPrediction: 0, lockedRoulette: 0, lockedSlot: 0, totalValue: 0 },
      slotmachine: slotmachine(),
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toMatch(/<button [^>]*disabled[^>]*>\s*INZET VASTZETTEN\s*<\/button>/);
    expect(html).toContain('does not cover a spin');
  });

  it('shows the slotmachine share of locked value on the wallet home', () => {
    const state = playerState({
      player: { id: 1, name: 'Daan', color: '#9B2FF2', rank: 1, balance: 290, startingBalance: 100, lockedPrediction: 0, lockedRoulette: 0, lockedSlot: 50, totalValue: 340 },
    });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('Slotmachine locked');
    expect(html).toContain('Total player value');
  });
});

describe('slotmachine settings', () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    totalWeight: 100,
    symbols: Array.from({ length: 12 }, (_, i) => ({ position: i + 1, letter: String.fromCharCode(65 + i), mediaKey: `1/image/pos${i + 1}.png` })),
    symbolByPosition: {},
    availableSymbols: Array.from({ length: 12 }, (_, i) => i + 1),
    outcomeTypes: [
      { type: 'NO_WIN', weight: 60, payoutMultiplier: 0, label: 'Geen winst', percentage: 60 },
      { type: 'TWO_SPLIT', weight: 20, payoutMultiplier: 1.4, label: '2 dezelfde gesplitst', percentage: 20 },
      { type: 'TWO_ADJACENT', weight: 10, payoutMultiplier: 1.8, label: '2 dezelfde naast elkaar', percentage: 10 },
      { type: 'THREE_LINE', weight: 7, payoutMultiplier: 3, label: '3 dezelfde op lijn', percentage: 7 },
      { type: 'THREE_ANYWHERE', weight: 3, payoutMultiplier: 5, label: '3 dezelfde ergens zichtbaar', percentage: 3 },
    ],
    status: { valid: true, totalWeight: 100, allocatedWeight: 100, remainingWeight: 0, symbolCount: 12, reason: 'Configuration is valid.' },
    ...overrides,
  });

  const state = (slotConfig: unknown) => ({ slotConfig });

  it('offers exactly twelve upload slots, shared by all reels', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(config()), gameId: 1, run }));
    expect(html.match(/class="slot-symbol-slot"/g)?.length).toBe(12);
    expect(html).toContain('12 of 12 uploaded');
  });

  // The whole point of the rewrite: five categories, not a combination table.
  it('lists the five fixed categories and nothing per-combination', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(config()), gameId: 1, run }));
    expect(html).toContain('Geen winst');
    expect(html).toContain('2 dezelfde gesplitst');
    expect(html).toContain('2 dezelfde naast elkaar');
    expect(html).toContain('3 dezelfde op lijn');
    expect(html).toContain('3 dezelfde ergens zichtbaar');
    // No adder for specific symbol combinations any more.
    expect(html).not.toContain('ADD A COMBINATION');
    expect(html).not.toContain('slot-outcome-adder');
  });

  it('shows the percentage each category derives from the total', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(config()), gameId: 1, run }));
    expect(html).toContain('60.00%');
    expect(html).toContain('20.00%');
    expect(html).toContain('10.00%');
    expect(html).toContain('7.00%');
    expect(html).toContain('3.00%');
  });

  it('lets two-adjacent and two-split carry independent payouts', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(config()), gameId: 1, run }));
    // Both payouts are editable numbers, and they differ.
    expect(html).toContain('value="1.4"');
    expect(html).toContain('value="1.8"');
  });

  // No win pays nothing by definition, so it is stated rather than offered as an input
  // whose value would be ignored.
  it('fixes the no-win payout at zero instead of offering a field', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(config()), gameId: 1, run }));
    expect(html).toContain('slot-fixed-payout');
    expect(html).toContain('>0x<');
  });

  it('reports a valid distribution as ready with its running total', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(config()), gameId: 1, run }));
    expect(html).toContain('READY');
    expect(html).toContain('Chances add up exactly · 100 / 100');
  });

  it('names the shortfall when the chances do not reach the total', () => {
    const short = config({
      outcomeTypes: [
        { type: 'NO_WIN', weight: 60, payoutMultiplier: 0, label: 'Geen winst', percentage: 60 },
        { type: 'TWO_SPLIT', weight: 20, payoutMultiplier: 1.4, label: '2 dezelfde gesplitst', percentage: 20 },
        { type: 'TWO_ADJACENT', weight: 10, payoutMultiplier: 1.8, label: '2 dezelfde naast elkaar', percentage: 10 },
        { type: 'THREE_LINE', weight: 7, payoutMultiplier: 3, label: '3 dezelfde op lijn', percentage: 7 },
        { type: 'THREE_ANYWHERE', weight: 0, payoutMultiplier: 5, label: '3 dezelfde ergens zichtbaar', percentage: 0 },
      ],
      status: { valid: false, totalWeight: 100, allocatedWeight: 97, remainingWeight: 3, symbolCount: 12, reason: 'Configuration is not complete — 3 of 100 chances are unassigned.' },
    });
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(short), gameId: 1, run }));
    expect(html).toContain('INCOMPLETE');
    expect(html).toContain('3 chances still unassigned');
  });

  it('names the overshoot when the chances exceed the total', () => {
    const over = config({
      outcomeTypes: [
        { type: 'NO_WIN', weight: 63, payoutMultiplier: 0, label: 'Geen winst', percentage: 63 },
        { type: 'TWO_SPLIT', weight: 20, payoutMultiplier: 1.4, label: '2 dezelfde gesplitst', percentage: 20 },
        { type: 'TWO_ADJACENT', weight: 10, payoutMultiplier: 1.8, label: '2 dezelfde naast elkaar', percentage: 10 },
        { type: 'THREE_LINE', weight: 7, payoutMultiplier: 3, label: '3 dezelfde op lijn', percentage: 7 },
        { type: 'THREE_ANYWHERE', weight: 3, payoutMultiplier: 5, label: '3 dezelfde ergens zichtbaar', percentage: 3 },
      ],
      status: { valid: false, totalWeight: 100, allocatedWeight: 103, remainingWeight: -3, symbolCount: 12, reason: 'Configuration exceeds the total by 3 chances.' },
    });
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(over), gameId: 1, run }));
    expect(html).toContain('3 chances over the total');
  });

  it('renders without throwing when a game has never been configured', () => {
    const html = renderRouted(createElement(SlotMachineSettings, { state: state(undefined), gameId: 1, run }));
    expect(html.match(/class="slot-symbol-slot"/g)?.length).toBe(12);
    expect(html).toContain('0 of 12 uploaded');
    // The five categories still render, at zero.
    expect(html).toContain('3 dezelfde op lijn');
  });
});

describe('slotmachine field on the big screen', () => {
  const symbol = (position: number) => ({
    position,
    letter: String.fromCharCode(64 + position),
    mediaKey: `1/image/pos${position}.png`,
  });
  const strip = Array.from({ length: 12 }, (_, i) => symbol(i + 1));
  /** [row][column] of the landed field. */
  const field = (rows: number[][]) => rows.map(row => row.map(symbol));

  it('renders three reels and a nine-cell highlight overlay', () => {
    const html = render(createElement(SlotReels, {
      field: field([[1, 2, 3], [4, 4, 5], [6, 7, 8]]), strip, winCells: [], spinning: false, spinMs: 3200, spinId: 1,
    }));
    expect(html.match(/class="slot-reel"/g)?.length).toBe(3);
    expect(html).toContain('slot-win-overlay');
    expect(html.match(/class="slot-win-cell/g)?.length).toBe(9);
  });

  it('lands each reel on its own column of the field', () => {
    // Column 0 must end on positions 1/4/6 — the last three cells of that reel's strip.
    const html = render(createElement(SlotReels, {
      field: field([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), strip, winCells: [], spinning: false, spinMs: 3200, spinId: 1,
    }));
    // Every landing symbol appears; the blur is the twelve symbols so all are present,
    // but the reel must be translated to its resting offset rather than to zero.
    expect(html).not.toContain('translateY(-0%)');
    expect(html).toContain('pos1.png');
    expect(html).toContain('pos9.png');
  });

  it('highlights only the winning cells once the reels have landed', () => {
    const html = render(createElement(SlotReels, {
      field: field([[1, 2, 3], [4, 4, 5], [6, 7, 8]]), strip,
      winCells: [[1, 0], [1, 1]], spinning: false, spinMs: 3200, spinId: 1,
    }));
    expect(html.match(/slot-win-cell [^"]*is-win/g)?.length).toBe(2);
  });

  // Highlighting mid-spin would give the result away before the reels stop.
  it('highlights nothing while the reels are still turning', () => {
    const html = render(createElement(SlotReels, {
      field: field([[1, 2, 3], [4, 4, 5], [6, 7, 8]]), strip,
      winCells: [[1, 0], [1, 1]], spinning: true, spinMs: 3200, spinId: 1,
    }));
    expect(html).not.toContain('is-win');
  });

  it('marks the main row so a pair win reads as belonging to it', () => {
    const html = render(createElement(SlotReels, {
      field: field([[1, 2, 3], [4, 4, 5], [6, 7, 8]]), strip, winCells: [], spinning: false, spinMs: 3200, spinId: 1,
    }));
    expect(html.match(/is-main-row/g)?.length).toBe(3);
  });

  it('renders before any player has spun, with no field at all', () => {
    const html = render(createElement(SlotReels, {
      field: null, strip, winCells: [], spinning: false, spinMs: 3200, spinId: null,
    }));
    expect(html.match(/class="slot-reel"/g)?.length).toBe(3);
    expect(html).not.toContain('is-win');
  });

  it('falls back to the position letter for a symbol with no artwork', () => {
    const bare = Array.from({ length: 12 }, (_, i) => ({ ...symbol(i + 1), mediaKey: '' }));
    const html = render(createElement(SlotReels, {
      field: null, strip: bare, winCells: [], spinning: false, spinMs: 3200, spinId: null,
    }));
    expect(html).toContain('slot-cell-letter');
  });
});

describe('slotmachine in the Control Center', () => {
  const blocks = [
    { id: 35, round_id: 3, type: 'SLOTMACHINE', title: 'Gokkast', sort_order: 1, payload: { maxSpins: 20, allowedPlayerIds: [] }, answer_count: 0 },
  ];
  const slotState = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    game: { id: 1, name: 'Game Night', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: 3, current_round_block_id: 35, current_screen_mode: 'SLOTMACHINE', game_state_version: 1 },
    screen: { mode: 'SLOTMACHINE', roundId: 3, blockId: 35, predictionId: null, staged: { mode: 'SLOTMACHINE', roundId: 3, blockId: 35, predictionId: null }, previous: { mode: null, roundId: null, blockId: null, predictionId: null } },
    runOfShow: [{ kind: 'block', id: 35, roundId: 3, type: 'SLOTMACHINE', label: 'Gokkast' }],
    predictionRequests: [],
    rounds: [{ id: 3, round_number: 3, title: 'Kennisquiz', status: 'ACTIVE', description: '', blocks, groups: [] }],
    currentBlock: blocks[0],
    players: [
      { id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true, current_balance: 290, locked_prediction: 0, rank: 1, joined: true },
      { id: 2, display_name: 'Jorrit', public_color: '#E8352F', active: true, current_balance: 260, locked_prediction: 0, rank: 2, joined: true },
    ],
    predictions: [],
    activePredictions: [],
    recentTransactions: [],
    activeRoulette: null,
    slotConfig: { status: { valid: true, reason: 'Configuration is valid.', symbolCount: 12 } },
    activeSlot: {
      blockId: 35,
      maxSpins: 20,
      participantCount: 0,
      lockedCoins: 35,
      activeSeries: [{ id: 9, playerId: 1, playerName: 'Daan', playerColor: '#9B2FF2', stakePerSpin: 5, totalSpins: 10, spinsRemaining: 7, totalStake: 50, status: 'ACTIVE' }],
      series: [],
      spins: [{ id: 3, playerId: 1, playerName: 'Daan', spinNumber: 3, outcomeType: 'TWO_ADJACENT', outcome: '2 dezelfde naast elkaar', stake: 5, payoutMultiplier: 1.8, payout: 9, status: 'RESULT', spunAt: new Date().toISOString() }],
      lastSpin: { id: 3, playerId: 1, playerName: 'Daan', spinNumber: 3, outcomeType: 'TWO_ADJACENT', outcome: '2 dezelfde naast elkaar', stake: 5, payoutMultiplier: 1.8, payout: 9, status: 'RESULT', spunAt: new Date().toISOString() },
    },
    ...overrides,
  });

  it('shows who is mid-series, what is locked and the last outcome', () => {
    const html = renderRouted(createElement(ControlPage, { state: slotState(), gameId: 1, run }));
    expect(html).toContain('SLOTMACHINE · LIVE');
    expect(html).toContain('ACTIVE SERIES');
    expect(html).toContain('1 of 2');
    expect(html).toContain('7 of 10 spins left');
    expect(html).toContain('2 dezelfde naast elkaar');
    expect(html).toContain('9 at 1.8x');
  });

  // The host does not drive this game, so offering them a SPIN would be wrong.
  it('offers the host no spin control of their own', () => {
    const html = renderRouted(createElement(ControlPage, { state: slotState(), gameId: 1, run }));
    expect(html).not.toMatch(/>SPIN</);
    expect(html).toContain('Players spin from their phones');
  });

  it('tells the host the machine is waiting when nobody has locked a series', () => {
    const html = renderRouted(createElement(ControlPage, { state: slotState({ activeSlot: null }), gameId: 1, run }));
    expect(html).toContain('players lock a series on their phones');
    expect(html).toContain('No player has locked a series yet');
  });

  it('warns the host when the machine cannot be used', () => {
    const html = renderRouted(createElement(ControlPage, {
      state: slotState({
        slotConfig: { status: { valid: false, reason: 'Configuration is not complete — 3 of 100 chances are unassigned.', symbolCount: 12 } },
        activeSlot: null,
      }),
      gameId: 1,
      run,
    }));
    expect(html).toContain('NOT CONFIGURED');
    expect(html).toContain('3 of 100 chances are unassigned');
  });

  it('says that moving on refunds unused spins, so the host knows nothing is left running', () => {
    const html = renderRouted(createElement(ControlPage, { state: slotState(), gameId: 1, run }));
    expect(html).toContain('refunds spins nobody used');
  });
});

describe('slotmachine turns on the phone', () => {
  const activeSeriesFor = (spinsRemaining: number) =>
    ({ id: 9, stakePerSpin: 5, totalSpins: 10, spinsRemaining, totalStake: 50, status: 'ACTIVE', lastSpin: null });

  const state = (slotOverrides: Record<string, unknown>) => playerState({ slotmachine: slotmachine(slotOverrides) });
  const html = (slotOverrides: Record<string, unknown>) =>
    render(createElement(MobileViews, { state: state(slotOverrides), gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));

  it('gives the active player the SPIN button', () => {
    const out = html({ series: activeSeriesFor(6), turn: turn({ current: { playerId: 1, name: 'Daan', spinsRemaining: 6, totalSpins: 6, stakePerSpin: 10 } }) });
    expect(out).toContain('JIJ BENT AAN DE BEURT');
    expect(out).toContain('SPIN · 6 LEFT');
  });

  // Everyone else waits, and is told on whom — not shown a dead button.
  it('tells a waiting player whose turn it is instead of offering SPIN', () => {
    const out = html({
      series: activeSeriesFor(4),
      turn: turn({
        isMyTurn: false,
        maySpin: false,
        waitingFor: 'Daan',
        current: { playerId: 2, name: 'Daan', spinsRemaining: 3, totalSpins: 6, stakePerSpin: 10 },
      }),
    });
    expect(out).toContain('AAN DE BEURT');
    expect(out).toContain('Daan');
    expect(out).toContain('Nog 3 van 6 spins');
    expect(out).not.toContain('SPIN · ');
    expect(out).toContain('WACHTEN');
  });

  it('keeps SPIN available for the whole run, not just the first spin', () => {
    for (const left of [6, 3, 1]) {
      const out = html({ series: activeSeriesFor(left), turn: turn({ current: { playerId: 1, name: 'Daan', spinsRemaining: left, totalSpins: 6, stakePerSpin: 10 } }) });
      expect(out, `${left} left`).toContain(`SPIN · ${left} LEFT`);
    }
  });

  // No topping up: once the run is used, the pickers must not come back.
  it('offers no way to buy more spins after a run is finished', () => {
    const out = html({
      series: null,
      lastSeries: { id: 9, stakePerSpin: 5, totalSpins: 10, spinsRemaining: 0, totalStake: 50, status: 'COMPLETED', lastSpin: null },
      turn: turn({ isMyTurn: false, maySpin: false, current: null, allDone: true }),
    });
    expect(out).toContain('JE REEKS IS KLAAR');
    expect(out).toContain('geen spins worden bijgekocht');
    expect(out).not.toContain('INZET VASTZETTEN');
    expect(out).not.toContain('AANTAL SPINS');
  });

  it('still lets a player who has not played yet lock a run while someone else is up', () => {
    const out = html({
      series: null,
      turn: turn({
        isMyTurn: false,
        maySpin: false,
        current: { playerId: 2, name: 'Bas', spinsRemaining: 2, totalSpins: 4, stakePerSpin: 5 },
      }),
    });
    expect(out).toContain('INZET VASTZETTEN');
    expect(out).toContain('Bas');
  });

  it('caps the spin picker at ten', () => {
    const out = html({ maxSpins: 10 });
    expect(out).toContain('AANTAL SPINS · MAX 10');
  });
});
