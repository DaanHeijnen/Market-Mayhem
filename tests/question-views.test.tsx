import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// The Big Screen gets its snapshot from the polling hook rather than props, so the hook
// is stubbed with the state under test. Nothing else about the component is replaced.
const screenState = { current: null as any };
vi.mock('../src/hooks/useGamePolling', () => ({
  useGamePolling: () => ({ data: screenState.current, error: '', refresh: async () => {} }),
}));

const { BigScreen } = await import('../src/components/broadcast/BigScreen');
const { ControlPage } = await import('../src/components/admin/control/ControlPage');
const { MobileViews } = await import('../src/components/mobile/MobileViews');
const { questionParticipation } = await import('../netlify/lib/question');

const noop = () => {};
const run = async () => true;
const routed = (node: any) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

const ANSWERS = ['Twan', 'Bas', 'Emma', 'Jorrit'];
const PHOTO_KEY = '1/image/abc123XY.jpg';

/** A live question block as the snapshots shape it. */
function questionBlock(overrides: Record<string, unknown> = {}) {
  const status = (overrides.interactive_status as string) ?? 'OPEN';
  const answered = (overrides as any).answered ?? 8;
  const eligible = (overrides as any).eligible ?? 11;
  delete (overrides as any).answered;
  delete (overrides as any).eligible;
  const revealed = status === 'REVEALED' || status === 'SETTLED';
  return {
    id: 33,
    round_id: 3,
    type: 'DUOLINGO_QUESTION',
    title: 'Wie heeft dit tijdens de vakantie gedaan?',
    sort_order: 3,
    interactive_status: status,
    answer_count: answered,
    participation: questionParticipation(answered, eligible),
    hasContextPhoto: true,
    payload: {
      body: 'Denk goed na voordat je kiest.',
      answers: ANSWERS,
      rewardCoins: 10,
      // The server only sends the key from the reveal onwards; the fixtures mirror that
      // rather than pretending the projector always has it.
      ...(revealed ? { correctAnswerIndex: 1, contextImageKey: PHOTO_KEY } : {}),
    },
    ...overrides,
  };
}

function adminState(block: any, overrides: Record<string, unknown> = {}) {
  const round = { id: 3, round_number: 3, title: 'Vakantieronde', status: 'ACTIVE', blocks: [block] };
  return {
    version: 9,
    game: { id: 1, name: 'Game Night', starting_balance: 100, maximum_wallet_percentage: null, current_round_id: 3, current_round_block_id: block.id, current_screen_mode: 'ROUND_BLOCK', game_state_version: 9 },
    screen: { mode: 'ROUND_BLOCK', roundId: 3, blockId: block.id, predictionId: null, questionContextPhotoBlockId: null, staged: { mode: 'ROUND_BLOCK', roundId: 3, blockId: block.id, predictionId: null }, previous: { mode: null, roundId: null, blockId: null, predictionId: null } },
    rounds: [round],
    currentBlock: block,
    groups: [],
    players: Array.from({ length: 11 }, (_, i) => ({ id: i + 1, display_name: `Player ${i + 1}`, public_color: '#3D5AFE', active: true, current_balance: 100, rank: 1, joined: true, locked_prediction: 0 })),
    predictions: [],
    recentTransactions: [],
    roulette: null,
    slotConfig: null,
    activeSlot: null,
    pakEenZes: null,
    photoRound: null,
    predictionRequests: [],
    ...overrides,
  };
}

const control = (block: any, overrides: Record<string, unknown> = {}) =>
  routed(createElement(ControlPage, { state: adminState(block, overrides), gameId: 1, run }));

const bigScreen = (block: any) => {
  screenState.current = {
    version: 9,
    game: { id: 1, name: 'Game Night' },
    mode: 'ROUND_BLOCK',
    round: { id: 3, number: 3, title: 'Vakantieronde', status: 'ACTIVE' },
    block,
    prediction: null,
    leaderboard: [],
    ticker: [],
    marketsOpen: 0,
    totalCoinsInPlay: 0,
    recentPredictionResults: [],
  };
  return renderToStaticMarkup(createElement(BigScreen, { gameId: 1 }));
};

function playerState(interactiveBlock: any) {
  return {
    version: 4,
    player: { id: 1, name: 'Daan', color: '#9B2FF2', rank: 1, balance: 340, startingBalance: 100, lockedPrediction: 0, lockedRoulette: 0, lockedSlot: 0, totalValue: 340 },
    settings: { maximumWalletPercentage: null },
    predictions: [],
    predictionAvailable: false,
    actionable: true,
    roulette: null,
    interactiveBlock,
    slotmachine: null,
    pakEenZes: null,
    photoRound: null,
    recentLedger: [],
    predictionRequests: { mine: [], remaining: 2, cooldownMinutesLeft: 0 },
  };
}

const mobile = (interactiveBlock: any) =>
  renderToStaticMarkup(createElement(MobileViews, { state: playerState(interactiveBlock), gameId: 1, view: 'home', predictionId: null, busy: false, act: noop, go: noop }));

describe('the Admin participation readout', () => {
  it('shows the count, the percentage and a bar while the question is open', () => {
    const html = control(questionBlock({ interactive_status: 'OPEN' }));
    expect(html).toContain('ANTWOORDEN');
    expect(html).toContain('8 / 11 GEANTWOORD');
    expect(html).toContain('73%');
    expect(html).toContain('progress-bar-fill');
    expect(html).toContain('width:73%');
    // Not just a number — the host needs to know who they are still waiting on.
    expect(html).toContain('Still waiting on 3 players');
  });

  it('offers SLUIT VRAAG while open, and never closes on its own', () => {
    const html = control(questionBlock({ interactive_status: 'OPEN' }));
    expect(html).toContain('SLUIT VRAAG');
    // Everyone answered is still the host's call, not an automatic close.
    const full = control(questionBlock({ interactive_status: 'OPEN', answered: 11, eligible: 11 }));
    expect(full).toContain('SLUIT VRAAG');
    expect(full).toContain('11 / 11 GEANTWOORD');
    expect(full).toContain('100%');
    expect(full).toContain('Everyone has answered');
  });

  it('marks the bar complete rather than merely full', () => {
    expect(control(questionBlock({ interactive_status: 'OPEN', answered: 11, eligible: 11 }))).toContain('tone-success');
    expect(control(questionBlock({ interactive_status: 'OPEN' }))).toContain('tone-blue');
  });

  it('says so rather than dividing by zero when nobody can answer', () => {
    const html = control(questionBlock({ interactive_status: 'OPEN', answered: 0, eligible: 0 }), { players: [] });
    expect(html).toContain('0 / 0 GEANTWOORD');
    expect(html).toContain('0%');
    expect(html).toContain('No active players can answer');
  });

  it('reports the answers received once closed, and offers the reveal', () => {
    const html = control(questionBlock({ interactive_status: 'CLOSED', answered: 11, eligible: 11 }));
    expect(html).toContain('11 / 11 GEANTWOORD');
    expect(html).toContain('TOON JUISTE ANTWOORD');
    expect(html).not.toContain('SLUIT VRAAG');
  });

  // Before it is open there is nothing to be waiting on, and after the reveal the
  // interesting number is the answer.
  it('does not show the bar before the question opens or after it is revealed', () => {
    expect(control(questionBlock({ interactive_status: 'READY' }))).not.toContain('ANTWOORDEN');
    expect(control(questionBlock({ interactive_status: 'REVEALED' }))).not.toContain('ANTWOORDEN');
  });

  it('never shows which answer anyone chose', () => {
    const html = control(questionBlock({ interactive_status: 'OPEN' }));
    for (const answer of ANSWERS) expect(html, answer).not.toContain(answer);
  });
});

describe('the Admin context-photo step', () => {
  it('offers the photo only after the reveal', () => {
    for (const status of ['READY', 'OPEN', 'CLOSED']) {
      expect(control(questionBlock({ interactive_status: status })), status).not.toContain('TOON CONTEXTFOTO');
    }
    expect(control(questionBlock({ interactive_status: 'REVEALED' }))).toContain('TOON CONTEXTFOTO');
    expect(control(questionBlock({ interactive_status: 'SETTLED' }))).toContain('TOON CONTEXTFOTO');
  });

  it('states the correct answer to the host once revealed', () => {
    expect(control(questionBlock({ interactive_status: 'REVEALED' }))).toContain('Juiste antwoord: Bas');
  });

  // A question without a photo must skip the step rather than offer a dead button.
  it('offers no photo step when the question has none', () => {
    const html = control(questionBlock({ interactive_status: 'REVEALED', hasContextPhoto: false }));
    expect(html).not.toContain('TOON CONTEXTFOTO');
    expect(html).toContain('no context photo on this question');
  });

  it('turns into a way back to the question while the photo is up', () => {
    const block = questionBlock({ interactive_status: 'REVEALED' });
    const html = control(block, {
      screen: { mode: 'ROUND_BLOCK', roundId: 3, blockId: block.id, predictionId: null, questionContextPhotoBlockId: block.id, staged: { mode: 'ROUND_BLOCK', roundId: 3, blockId: block.id, predictionId: null }, previous: { mode: null, roundId: null, blockId: null, predictionId: null } },
    });
    expect(html).toContain('TERUG NAAR DE VRAAG');
    expect(html).not.toContain('TOON CONTEXTFOTO');
  });
});

describe('the Big Screen question', () => {
  it('shows the question, its supporting text and the answers', () => {
    const html = bigScreen(questionBlock({ interactive_status: 'OPEN' }));
    expect(html).toContain('Wie heeft dit tijdens de vakantie gedaan?');
    expect(html).toContain('Denk goed na voordat je kiest.');
    for (const answer of ANSWERS) expect(html, answer).toContain(answer);
    expect(html).toContain('ANSWER NOW ON YOUR PHONE');
  });

  it('shows how many have answered, out of how many', () => {
    expect(bigScreen(questionBlock({ interactive_status: 'OPEN' }))).toContain('8/11 ANSWERS');
  });

  it('states the correct answer plainly once revealed', () => {
    const html = bigScreen(questionBlock({ interactive_status: 'REVEALED' }));
    expect(html).toContain('JUISTE ANTWOORD');
    expect(html).toContain('duo-reveal-banner');
    expect(html).toContain('🟢 Bas');
    expect(html).toContain('correct');
  });

  it('marks no answer correct before the reveal', () => {
    const html = bigScreen(questionBlock({ interactive_status: 'CLOSED' }));
    expect(html).toContain('ANSWERS LOCKED');
    expect(html).not.toContain('JUISTE ANTWOORD');
    expect(html).not.toContain('duo-answer-card correct');
  });

  it('makes the photo the slide once the host calls for it', () => {
    const block = { ...questionBlock({ interactive_status: 'REVEALED' }), showingContextPhoto: true };
    const html = bigScreen(block);
    expect(html).toContain('duo-photo-image');
    expect(html).toContain(encodeURIComponent(PHOTO_KEY));
    // The question and the answer stay as one line each, so the room knows what it sees.
    expect(html).toContain('Wie heeft dit tijdens de vakantie gedaan?');
    expect(html).toContain('🟢 Bas');
    // The answer grid gives way to the photo.
    expect(html).not.toContain('duo-answer-grid');
  });

  it('shows the question, not the photo, until the host calls for it', () => {
    const html = bigScreen(questionBlock({ interactive_status: 'REVEALED' }));
    expect(html).not.toContain('duo-photo-image');
    expect(html).toContain('duo-answer-grid');
  });

  // The real guarantee is that the server withholds the key before the reveal; this is
  // the second lock, so a wrong flag still cannot spoil the question.
  it('cannot show a photo it was given no key for', () => {
    const block = { ...questionBlock({ interactive_status: 'OPEN' }), showingContextPhoto: true };
    const html = bigScreen(block);
    expect(html).not.toContain('duo-photo-image');
    expect(html).toContain('duo-answer-grid');
  });
});

describe('the question on the phone', () => {
  it('makes clear the answer is saved and needs no resending', () => {
    const html = mobile({ id: 33, roundId: 3, status: 'OPEN', rewardCoins: 10, selectedAnswer: 2, isCorrect: null, correctAnswer: null, correctAnswerText: '' });
    expect(html).toContain('ANSWER LOCKED');
    expect(html).toContain('you do not need to send it again');
    expect(html).toContain('LOCKED');
  });

  it('keeps every control dead once answers are closed', () => {
    const html = mobile({ id: 33, roundId: 3, status: 'CLOSED', rewardCoins: 10, selectedAnswer: 2, isCorrect: null, correctAnswer: null, correctAnswerText: '' });
    expect(html).toContain('Answers are closed');
    expect(html.match(/<button[^>]*class="emoji-answer[^"]*"[^>]*disabled/g) || []).toHaveLength(4);
  });

  it('shows what the answer was, and whether this player had it', () => {
    const right = mobile({ id: 33, roundId: 3, status: 'REVEALED', rewardCoins: 10, selectedAnswer: 1, isCorrect: true, correctAnswer: 1, correctAnswerText: 'Bas' });
    expect(right).toContain('JUISTE ANTWOORD');
    expect(right).toContain('Bas');
    expect(right).toContain('CORRECT');
    expect(right).toContain('+10 coins credited automatically');

    const wrong = mobile({ id: 33, roundId: 3, status: 'REVEALED', rewardCoins: 10, selectedAnswer: 3, isCorrect: false, correctAnswer: 1, correctAnswerText: 'Bas' });
    expect(wrong).toContain('JUISTE ANTWOORD');
    expect(wrong).toContain('Bas');
    expect(wrong).toContain('NOT THIS TIME');
  });

  it('says nothing about the answer before the reveal', () => {
    const html = mobile({ id: 33, roundId: 3, status: 'CLOSED', rewardCoins: 10, selectedAnswer: 1, isCorrect: null, correctAnswer: null, correctAnswerText: '' });
    expect(html).not.toContain('JUISTE ANTWOORD');
    expect(html).not.toContain('Bas');
  });

  // Someone who never answered should be told that, not shown a bare "not this time".
  it('distinguishes a wrong answer from no answer at all', () => {
    const html = mobile({ id: 33, roundId: 3, status: 'REVEALED', rewardCoins: 10, selectedAnswer: null, isCorrect: null, correctAnswer: 1, correctAnswerText: 'Bas' });
    expect(html).toContain('NO ANSWER SENT');
    expect(html).toContain('You did not answer this question');
  });

  // The reels-and-answers principle: the phone is a controller, so the answer labels
  // live on the projector and never travel to the phone before the reveal.
  it('never receives the answer labels while answering', () => {
    const html = mobile({ id: 33, roundId: 3, status: 'OPEN', rewardCoins: 10, selectedAnswer: null, isCorrect: null, correctAnswer: null, correctAnswerText: '' });
    for (const answer of ANSWERS) expect(html, answer).not.toContain(answer);
  });
});
