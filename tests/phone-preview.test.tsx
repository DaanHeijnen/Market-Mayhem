import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileViews } from '../src/components/mobile/MobileViews';
import { PhonePreview } from '../src/components/admin/PhonePreview';

const noop = () => {};

/** The shape `player-state` (and therefore `player-state-preview`) returns. */
function playerState(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    player: { id: 1, name: 'Daan', color: '#9B2FF2', rank: 1, balance: 340, startingBalance: 100, lockedPrediction: 40, lockedRoulette: 0, totalValue: 380 },
    settings: { maximumWalletPercentage: null },
    predictions: [
      { id: 1, number: 1, question: 'Wint Team Blauw de bonusronde?', status: 'OPEN', publicStatus: 'OPEN', yesOdds: 1.8, noOdds: 2.2, minimumStake: 5, maximumStake: 100, closesAt: new Date(Date.now() + 60_000).toISOString(), result: null, roundNumber: 3, ownBet: null },
    ],
    predictionAvailable: true,
    actionable: true,
    roulette: null,
    interactiveBlock: null,
    recentLedger: [{ id: 1, amount: -20, description: 'Prediction deposit #1' }],
    predictionRequests: { mine: [], remaining: 2, cooldownMinutesLeft: 0 },
    ...overrides,
  };
}

const adminState = (overrides: Record<string, unknown> = {}) => ({
  version: 4,
  players: [
    { id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true },
    { id: 2, display_name: 'Jorrit', public_color: '#E8352F', active: true },
    { id: 3, display_name: 'Oud account', public_color: '#2FAF5B', active: false },
  ],
  ...overrides,
});

const render = (node: any) => renderToStaticMarkup(node);

describe('mobile views', () => {
  it('renders the wallet home from a player-state payload', () => {
    const html = render(createElement(MobileViews, { state: playerState(), gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('AVAILABLE WALLET');
    expect(html).toContain('Daan');
    expect(html).toContain('PREDICTIONS');
  });

  it('renders the market list and the request form', () => {
    const html = render(createElement(MobileViews, { state: playerState(), gameId: 1, view: 'predictions', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('Wint Team Blauw de bonusronde?');
    expect(html).toContain('SUBMIT YOUR OWN PREDICTION · 2 LEFT');
  });

  // A live question owns the phone regardless of which view the caller asked for.
  // That is backend-driven, and the preview must not be able to talk it out of it.
  it('lets a live question take over any view', () => {
    const state = playerState({ interactiveBlock: { id: 33, status: 'OPEN', selectedAnswer: null, isCorrect: false, rewardCoins: 10 } });
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));
    expect(html).toContain('LIVE ROUND QUESTION');
    expect(html).not.toContain('AVAILABLE WALLET');
  });

  it('disables submit controls while busy', () => {
    const state = playerState();
    const html = render(createElement(MobileViews, { state, gameId: 1, view: 'prediction', predictionId: 1, busy: true, act: noop, go: noop }));
    expect(html).toMatch(/<button [^>]*disabled[^>]*>LOCK 5 ON YES<\/button>/);
  });
});

describe('admin phone preview', () => {
  it('offers one tab per active player and nothing for deactivated ones', () => {
    const html = render(createElement(PhonePreview, { state: adminState(), gameId: 1, onClose: noop }));
    expect(html).toContain('PLAYER APP · READ-ONLY');
    expect(html).toContain('Daan');
    expect(html).toContain('Jorrit');
    expect(html).not.toContain('Oud account');
  });

  it('says so plainly when there is no player to preview', () => {
    const html = render(createElement(PhonePreview, { state: adminState({ players: [] }), gameId: 1, onClose: noop }));
    expect(html).toContain('Add a player first');
  });

  // Effects do not run under renderToStaticMarkup, so this is the pre-fetch state —
  // which is also what the host sees for the first moment the modal is open.
  it('shows a loading state until the player payload arrives', () => {
    const html = render(createElement(PhonePreview, { state: adminState(), gameId: 1, onClose: noop }));
    // React escapes the apostrophe, so assert either side of it.
    expect(html).toContain('Loading this player');
    expect(html).toContain('phone…');
  });
});
