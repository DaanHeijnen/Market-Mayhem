import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { MobileViews } from '../src/components/mobile/MobileViews';
import { ControlPage } from '../src/components/admin/control/ControlPage';
import { PlayingCard, CardDeck, suitSymbol } from '../src/components/shared/PlayingCard';
import { PakEenZesSettings } from '../src/components/admin/settings/PakEenZesSettings';

const noop = () => {};
const run = async () => true;
const render = (node: any) => renderToStaticMarkup(node);
const renderRouted = (node: any) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

const ROSTER = [
  { id: 1, name: 'Daan', color: '#9B2FF2' },
  { id: 2, name: 'Twan', color: '#E8352F' },
  { id: 3, name: 'Bas', color: '#2FAF5B' },
];

/** The `pakEenZes` section of a player-state payload. */
function pez(overrides: Record<string, unknown> = {}) {
  return {
    roundId: 3,
    title: 'Pak een Zes',
    instructions: 'Kies vier namen.',
    status: 'PREDICTING',
    predicting: true,
    drawing: false,
    finished: false,
    myPicks: [],
    hasPredicted: false,
    pointsPerCorrect: 25,
    myScore: null,
    players: ROSTER,
    turnOrder: [],
    currentPlayer: null,
    isMyTurn: false,
    drawnCount: 0,
    ...overrides,
  };
}

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
    pakEenZes: null,
    recentLedger: [],
    predictionRequests: { mine: [], remaining: 2, cooldownMinutesLeft: 0 },
    ...overrides,
  };
}

const mobile = (state: any) =>
  render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));

describe('Pak een Zes on the phone', () => {
  // Backend-driven, like the live question and the slotmachine: the live block owns the
  // phone, not a route the player can navigate to.
  it('takes over any view while the block is live', () => {
    const html = mobile(playerState({ pakEenZes: pez() }));
    expect(html).toContain('PAK EEN ZES');
    expect(html).toContain('Wie trekken volgens jou een zes?');
    expect(html).not.toContain('AVAILABLE WALLET');
  });

  it('disappears again when no Pak een Zes block is live', () => {
    const html = mobile(playerState());
    expect(html).toContain('AVAILABLE WALLET');
    expect(html).not.toContain('VOORSPELLING OPSLAAN');
  });

  it('offers exactly four independent name fields', () => {
    const html = mobile(playerState({ pakEenZes: pez() }));
    expect(html.match(/class="pez-pick"/g)?.length).toBe(4);
    expect(html).toContain('VOORSPELLING OPSLAAN');
  });

  // The headline requirement: every field offers every player, so the same name can be
  // picked more than once and a player can pick themselves.
  it('offers every player in every field, so duplicates and self-picks are possible', () => {
    const html = mobile(playerState({ pakEenZes: pez() }));
    for (const player of ROSTER) {
      // Once per select, four selects.
      expect(html.match(new RegExp(`>${player.name}</option>`, 'g'))?.length).toBe(4);
    }
    expect(html).toContain('dezelfde speler meerdere keren');
  });

  it('cannot save until all four names are chosen', () => {
    const html = mobile(playerState({ pakEenZes: pez() }));
    expect(html).toMatch(/<button [^>]*disabled[^>]*>VOORSPELLING OPSLAAN<\/button>/);
  });

  it('pre-fills a saved prediction, duplicates and all, and says it is saved', () => {
    const html = mobile(playerState({ pakEenZes: pez({ myPicks: [1, 2, 1, 3], hasPredicted: true }) }));
    expect(html).toContain('VOORSPELLING OPGESLAGEN');
    // Daan (1) is selected in two of the four fields.
    expect(html.match(/<option value="1" selected="">Daan<\/option>/g)?.length).toBe(2);
    expect(html).not.toMatch(/<button [^>]*disabled[^>]*>VOORSPELLING OPSLAAN<\/button>/);
  });

  it('closes the form once predictions are locked', () => {
    const html = mobile(playerState({ pakEenZes: pez({ status: 'LOCKED', predicting: false, hasPredicted: true }) }));
    expect(html).toContain('Voorspellingen gesloten');
    expect(html).not.toContain('VOORSPELLING OPSLAAN');
  });

  it('gives the player on turn the draw button', () => {
    const html = mobile(playerState({
      pakEenZes: pez({
        status: 'DRAWING', predicting: false, drawing: true,
        currentPlayer: { id: 1, name: 'Daan' }, isMyTurn: true,
        turnOrder: [{ id: 1, name: 'Daan' }, { id: 2, name: 'Twan' }],
      }),
    }));
    expect(html).toContain('JIJ BENT AAN DE BEURT');
    expect(html).toContain('KAART PAKKEN');
  });

  // Everyone else must see that they are waiting, and on whom.
  it('tells everyone else whose turn it is and offers no button', () => {
    const html = mobile(playerState({
      pakEenZes: pez({
        status: 'DRAWING', predicting: false, drawing: true,
        currentPlayer: { id: 2, name: 'Twan' }, isMyTurn: false,
        turnOrder: [{ id: 1, name: 'Daan' }, { id: 2, name: 'Twan' }],
      }),
    }));
    expect(html).toContain('Wachten op je beurt');
    expect(html).toContain('Twan');
    expect(html).not.toContain('KAART PAKKEN');
  });

  it('never shows the deck or a card on the phone', () => {
    const html = mobile(playerState({
      pakEenZes: pez({ status: 'DRAWING', predicting: false, drawing: true, currentPlayer: { id: 1, name: 'Daan' }, isMyTurn: true }),
    }));
    expect(html).not.toContain('playing-card');
    expect(html).not.toContain('card-deck');
  });

  it('says so when the game is over', () => {
    const html = mobile(playerState({
      pakEenZes: pez({ status: 'FINISHED', predicting: false, finished: true }),
    }));
    expect(html).toContain('ALLE VIER DE ZESSEN');
  });
});

describe('playing cards', () => {
  it('renders each suit with its symbol', () => {
    expect(suitSymbol('HEARTS')).toBe('♥');
    expect(suitSymbol('DIAMONDS')).toBe('♦');
    expect(suitSymbol('CLUBS')).toBe('♣');
    expect(suitSymbol('SPADES')).toBe('♠');
  });

  it('colours hearts and diamonds red, clubs and spades black', () => {
    expect(render(createElement(PlayingCard, { rank: '6', suit: 'HEARTS' }))).toContain('is-red');
    expect(render(createElement(PlayingCard, { rank: '6', suit: 'SPADES' }))).toContain('is-black');
  });

  it('marks a six so the reveal can celebrate it', () => {
    expect(render(createElement(PlayingCard, { rank: '6', suit: 'HEARTS', six: true }))).toContain('is-six');
    expect(render(createElement(PlayingCard, { rank: '9', suit: 'HEARTS' }))).not.toContain('is-six');
  });

  // The pile shrinking is the only cue the room gets that the deck is finite.
  it('thins the deck as cards come out, and shows the count', () => {
    const full = render(createElement(CardDeck, { cardsRemaining: 52 }));
    const nearlyEmpty = render(createElement(CardDeck, { cardsRemaining: 3 }));
    const layers = (html: string) => html.match(/class="card-deck-layer"/g)?.length ?? 0;
    expect(layers(full)).toBeGreaterThan(layers(nearlyEmpty));
    expect(full).toContain('>52<');
    expect(nearlyEmpty).toContain('>3<');
  });

  it('keeps at least one layer so an empty deck still draws', () => {
    const html = render(createElement(CardDeck, { cardsRemaining: 0 }));
    expect(html.match(/class="card-deck-layer"/g)?.length).toBe(1);
  });
});

describe('Pak een Zes in the Control Center', () => {
  /** A round is the game now: one type, no blocks inside it. */
  const PAK_ROUND = {
    id: 3, sortOrder: 3, title: 'Pak een Zes', type: 'PAK_EEN_ZES', status: 'ACTIVE',
    description: '', instructions: '', defaultPoints: 25, groups: [],
  };
  const state = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    game: { id: 1, name: 'Game Night', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: 3, current_screen_mode: 'PAK_EEN_ZES', game_state_version: 1 },
    screen: { mode: 'PAK_EEN_ZES', roundId: 3, questionId: null, slideId: null, predictionId: null, staged: { mode: 'PAK_EEN_ZES', roundId: 3, questionId: null, slideId: null, predictionId: null }, previous: { mode: null, roundId: null, questionId: null, slideId: null, predictionId: null } },
    roundRuntime: { currentQuizQuestionId: null, currentSlideId: null, revision: 0 },
    predictionRequests: [],
    rounds: [PAK_ROUND],
    activeRound: PAK_ROUND,
    players: [
      { id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true, current_balance: 290, locked_prediction: 0, rank: 1, joined: true },
      { id: 2, display_name: 'Twan', public_color: '#E8352F', active: true, current_balance: 260, locked_prediction: 0, rank: 2, joined: true },
      { id: 3, display_name: 'Bas', public_color: '#2FAF5B', active: true, current_balance: 250, locked_prediction: 0, rank: 3, joined: true },
    ],
    predictions: [],
    activePredictions: [],
    recentTransactions: [],
    activeRoulette: null,
    slotConfig: null,
    activeSlot: null,
    pakEenZes: {
      roundId: 3,
      status: 'PREDICTING',
      turnIndex: 0,
      currentPlayer: null,
      drawnCount: 0,
      cardsRemaining: 52,
      sixes: [],
      sixesFound: 0,
      recentDraws: [],
      predictionCount: 2,
      activePlayerCount: 3,
      awaitingPrediction: [{ playerId: 3, name: 'Bas' }],
    },
    ...overrides,
  });

  it('offers the phase controls in order and only one at a time', () => {
    const ready = renderRouted(createElement(ControlPage, { state: state({ pakEenZes: { ...state().pakEenZes, status: 'READY' } }), gameId: 1, run }));
    expect(ready).toContain('OPEN VOORSPELLINGEN');
    expect(ready).not.toContain('SLUIT VOORSPELLINGEN');

    const predicting = renderRouted(createElement(ControlPage, { state: state(), gameId: 1, run }));
    expect(predicting).toContain('SLUIT VOORSPELLINGEN');
    expect(predicting).not.toContain('START HET SPEL');

    const locked = renderRouted(createElement(ControlPage, { state: state({ pakEenZes: { ...state().pakEenZes, status: 'LOCKED' } }), gameId: 1, run }));
    expect(locked).toContain('START HET SPEL');
  });

  // The host may close without everyone, so they need the names, not just a count.
  it('names who has not predicted yet', () => {
    const html = renderRouted(createElement(ControlPage, { state: state(), gameId: 1, run }));
    expect(html).toContain('STILL TO PREDICT');
    expect(html).toContain('Bas');
    expect(html).toContain('2 / 3');
  });

  it('says so when everyone is in', () => {
    const html = renderRouted(createElement(ControlPage, {
      state: state({ pakEenZes: { ...state().pakEenZes, predictionCount: 3, awaitingPrediction: [] } }), gameId: 1, run,
    }));
    expect(html).toContain('EVERYONE HAS PREDICTED');
  });

  it('shows the live turn, deck progress and sixes while drawing', () => {
    const html = renderRouted(createElement(ControlPage, {
      state: state({
        pakEenZes: {
          ...state().pakEenZes,
          status: 'DRAWING',
          currentPlayer: { playerId: 2, name: 'Twan', color: '#E8352F', turnOrder: 1 },
          drawnCount: 7,
          cardsRemaining: 45,
          sixesFound: 1,
          sixes: [{ id: 5, drawNumber: 4, playerId: 1, playerName: 'Daan', rank: '6', suit: 'HEARTS', label: '6♥', isSix: true }],
          recentDraws: [{ id: 7, drawNumber: 7, playerName: 'Bas', label: 'K♠', isSix: false }],
        },
      }),
      gameId: 1,
      run,
    }));
    expect(html).toContain('Twan');
    expect(html).toContain('7 / 52');
    expect(html).toContain('1 / 4');
    expect(html).toContain('6♥');
    expect(html).toContain('Daan');
  });

  // The host drives the phases, not the cards.
  it('never offers the host a draw button of their own', () => {
    const html = renderRouted(createElement(ControlPage, {
      state: state({ pakEenZes: { ...state().pakEenZes, status: 'DRAWING', currentPlayer: { playerId: 1, name: 'Daan' } } }),
      gameId: 1,
      run,
    }));
    expect(html).not.toContain('KAART PAKKEN');
    expect(html).toContain('The server decides both the card and whose turn it is');
  });

  it('renders before the host has done anything', () => {
    const html = renderRouted(createElement(ControlPage, { state: state({ pakEenZes: null }), gameId: 1, run }));
    expect(html).toContain('PAK EEN ZES · LIVE');
    expect(html).toContain('OPEN VOORSPELLINGEN');
  });
});

describe('Pak een Zes scoring', () => {
  const scored = (overrides: Record<string, unknown> = {}) =>
    render(createElement(MobileViews, {
      state: playerState({ pakEenZes: pez(overrides) }),
      gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop,
    }));

  // The value has to be readable before the picks are made, and must come from
  // Settings rather than being baked into the page.
  it('states what a correct prediction is worth, before the four fields', () => {
    const html = scored();
    expect(html).toContain('Elke juiste voorspelling is 25 punten waard');
    // Before the fields, not after.
    expect(html.indexOf('punten waard')).toBeLessThan(html.indexOf('class="pez-pick"'));
  });

  it('shows whatever the Admin configured, not a fixed number', () => {
    expect(scored({ pointsPerCorrect: 10 })).toContain('is 10 punten waard');
    expect(scored({ pointsPerCorrect: 250 })).toContain('is 250 punten waard');
  });

  it('says nothing about points when the host set the rate to zero', () => {
    const html = scored({ pointsPerCorrect: 0 });
    expect(html).not.toContain('punten waard');
    // The prediction form is still there — it is just for pride.
    expect(html).toContain('VOORSPELLING OPSLAAN');
  });

  it('explains that a doubled name can count twice', () => {
    expect(scored()).toContain('twee keer en trekt hij twee zessen');
  });

  it('shows the player their own result once the game is over', () => {
    const html = scored({
      status: 'FINISHED', predicting: false, finished: true,
      hasPredicted: true, myPicks: [1, 2, 1, 3],
      myScore: { correct: 3, points: 75 },
    });
    expect(html).toContain('3 voorspellingen goed');
    expect(html).toContain('+75 punten');
    expect(html).toContain('3 × 25 punten');
  });

  it('uses the singular for one correct prediction', () => {
    const html = scored({
      status: 'FINISHED', predicting: false, finished: true,
      hasPredicted: true, myScore: { correct: 1, points: 25 },
    });
    expect(html).toContain('1 voorspelling goed');
    expect(html).not.toContain('1 voorspellingen');
  });

  it('is explicit when a player scored nothing', () => {
    const html = scored({
      status: 'FINISHED', predicting: false, finished: true,
      hasPredicted: true, myScore: { correct: 0, points: 0 },
    });
    expect(html).toContain('0 voorspellingen goed');
    expect(html).toContain('Geen punten deze ronde');
  });

  it('shows no score card for a player who never predicted', () => {
    const html = scored({ status: 'FINISHED', predicting: false, finished: true, myScore: null });
    expect(html).not.toContain('voorspellingen goed');
  });
});

describe('Pak een Zes scoring settings', () => {
  const state = (points: number) => ({ game: { pak_een_zes_points_per_correct: points } });
  const settings = (points: number) =>
    renderToStaticMarkup(createElement(PakEenZesSettings, { state: state(points), run }));

  it('shows the stored rate and a worked total', () => {
    const html = settings(25);
    expect(html).toContain('value="25"');
    // Three correct at 25 is 75, spelled out so the effect is obvious.
    expect(html).toContain('>75<');
    expect(html).toContain('25 PUNTEN');
  });

  it('reflects a different configured rate', () => {
    const html = settings(10);
    expect(html).toContain('value="10"');
    expect(html).toContain('>30<');
  });

  it('accepts zero and says the prediction is for pride alone', () => {
    const html = settings(0);
    expect(html).toContain('GEEN PUNTEN');
    expect(html).toContain('pride alone');
  });

  // Nothing to save until the number actually changes.
  it('keeps the save button dead until the value is edited', () => {
    expect(settings(25)).toMatch(/<button [^>]*disabled[^>]*>SAVE SCORING<\/button>/);
  });

  it('promises a finished game keeps the rate it was scored at', () => {
    expect(settings(25)).toContain('never rewrites a game that already paid out');
  });
});
