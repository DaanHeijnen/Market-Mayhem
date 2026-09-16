import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Admin shell, rendered against a real admin-state payload.
 *
 * This file exists because of a bug it would have caught. `AdminApp` reached into
 * `activeRound.blocks.length` — a field the round model no longer has — and every page
 * test rendered the *pages* while nothing rendered the shell around them, so signing in
 * threw before any of them got a chance to run.
 *
 * The shell is the first thing an Admin sees, so it is rendered here for every round type
 * and for a game with no round at all. A field that stops existing fails here.
 */
vi.mock('../src/hooks/useGamePolling', () => ({
  useGamePolling: () => ({ data: (globalThis as any).__adminState, error: '', refresh: async () => {} }),
}));

const { AdminApp } = await import('../src/components/admin/AdminApp');

const round = (type: string, extra: Record<string, unknown> = {}) => ({
  id: 3, sortOrder: 3, title: `${type} round`, type, status: 'ACTIVE',
  description: '', instructions: '', defaultPoints: 10, groups: [], ...extra,
});

function adminState(activeRound: any) {
  return {
    version: 1,
    game: {
      id: 1, name: 'Game Night #12', starting_balance: 100, maximum_wallet_percentage: null,
      current_round_id: activeRound ? activeRound.id : null,
      current_screen_mode: 'DASHBOARD', game_state_version: 1,
    },
    screen: {
      mode: 'DASHBOARD', roundId: null, questionId: null, slideId: null, predictionId: null,
      staged: { mode: null, roundId: null, questionId: null, slideId: null, predictionId: null },
      previous: { mode: null, roundId: null, questionId: null, slideId: null, predictionId: null },
    },
    roundRuntime: activeRound ? { currentQuizQuestionId: null, currentSlideId: null, revision: 0 } : null,
    predictionRequests: [],
    rounds: activeRound ? [activeRound] : [],
    activeRound,
    players: [{ id: 1, display_name: 'Daan', public_color: '#9B2FF2', active: true, current_balance: 100, locked_prediction: 0, rank: 1, joined: true }],
    predictions: [],
    activePredictions: [],
    recentTransactions: [],
    activeRoulette: null,
    slotConfig: null,
    activeSlot: null,
    photoRound: null,
    pakEenZes: null,
  };
}

const renderShell = (state: any) => {
  (globalThis as any).__adminState = state;
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ['/admin/1/control'] }, createElement(AdminApp, { gameId: 1 })),
  );
};

describe('the Admin shell', () => {
  it('signs in and renders with no round active', () => {
    const html = renderShell(adminState(null));
    expect(html).toContain('Control Center');
    expect(html).toContain('NO ROUND ACTIVE');
    expect(html).toContain('NO ACTIVE ROUND');
  });

  // Every type, because the shell's round chip reads content that only exists on some of
  // them — which is exactly how it broke.
  it('renders for every round type without reaching for a field that does not exist', () => {
    const cases: Array<[string, any]> = [
      ['LIVE_QUIZ', round('LIVE_QUIZ', { questions: [{ id: 1, prompt: 'Q', points: 10, options: [], status: 'READY', participation: { answered: 0, eligible: 1, remaining: 1, percentage: 0 }, answerCount: 0, revision: 0, contextMediaKey: null, contextPhotoShown: false, timeLimitSeconds: null, sortOrder: 0, body: '' }] })],
      ['PRESENTATIE', round('PRESENTATIE', { slides: [{ id: 1, sortOrder: 0, title: 'Slide', body: '', mediaKey: null, mediaKind: null, revealText: null, hideTitleUntilReveal: false, revealedAt: null, revision: 0 }] })],
      ['FOTORONDE', round('FOTORONDE', { subjects: [] })],
      ['SLOTMACHINE', round('SLOTMACHINE', { slotmachine: { maxSpins: 10, allowedPlayerIds: [] } })],
      ['ROULETTE', round('ROULETTE')],
      ['PAK_EEN_ZES', round('PAK_EEN_ZES')],
    ];
    for (const [type, value] of cases) {
      expect(() => renderShell(adminState(value)), type).not.toThrow();
      const html = renderShell(adminState(value));
      expect(html, type).toContain('ROUND 03 · ACTIVE');
      // The chip names the round's type and counts its content in that type's own noun.
      expect(html, type).toContain(type.replace('_', ' ').replace('_', ' '));
      // "Rundefined" is what a stale field renders as, and it is easy to miss by eye.
      expect(html, type).not.toContain('undefined');
    }
  });

  it('shows the sign-in card until a snapshot arrives', () => {
    const html = renderShell(null);
    expect(html).toContain('SIGN IN');
    expect(html).not.toContain('Control Center');
  });

  // The toggle offers a one-way trip out to the standings and a way back, and neither
  // may call an endpoint that no longer exists.
  it('offers the dashboard detour, and the return trip only once there is one', () => {
    const away = renderShell(adminState(round('ROULETTE')));
    expect(away).toContain('MARKET DASHBOARD');

    const state = adminState(round('ROULETTE'));
    state.screen.mode = 'DASHBOARD';
    expect(renderShell(state)).not.toContain('BACK TO RUN OF SHOW');

    (state.screen.previous as any).mode = 'ROULETTE';
    expect(renderShell(state)).toContain('BACK TO RUN OF SHOW');
  });
});
