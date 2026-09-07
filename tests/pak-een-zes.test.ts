import { describe, expect, it } from 'vitest';
import {
  allSixesFound,
  canTransition,
  cardKey,
  cardLabel,
  countSixes,
  drawCard,
  isLive,
  isRedSuit,
  isSix,
  nextTurnIndex,
  picksForPlayer,
  playerAtTurn,
  remainingDeck,
  validatePrediction,
  DECK_SIZE,
  FULL_DECK,
  PREDICTION_SLOTS,
  RANKS,
  SIXES_IN_DECK,
  SUITS,
  type Card,
  type PakEenZesStatus,
} from '../netlify/lib/pak-een-zes';
import { pakEenZesBlockSettings } from '../netlify/lib/pak-een-zes-state';

const card = (rank: string, suit: string) => ({ rank, suit } as Card);

/** Deterministic stand-in for crypto randomness, so a case can be reproduced. */
function seededRng(seed: number) {
  let state = seed >>> 0;
  return (maxExclusive: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maxExclusive;
  };
}

describe('the deck', () => {
  it('is a normal 52-card deck with no duplicates', () => {
    expect(FULL_DECK).toHaveLength(DECK_SIZE);
    expect(DECK_SIZE).toBe(52);
    expect(new Set(FULL_DECK.map(cardKey)).size).toBe(52);
  });

  it('has thirteen ranks in four suits', () => {
    expect(RANKS).toHaveLength(13);
    expect(SUITS).toHaveLength(4);
  });

  it('contains exactly four sixes, one per suit', () => {
    const sixes = FULL_DECK.filter(isSix);
    expect(sixes).toHaveLength(SIXES_IN_DECK);
    expect(SIXES_IN_DECK).toBe(4);
    expect(new Set(sixes.map(c => c.suit)).size).toBe(4);
  });

  it('labels a card the way the projector shows it', () => {
    expect(cardLabel(card('6', 'HEARTS'))).toBe('6♥');
    expect(cardLabel(card('6', 'DIAMONDS'))).toBe('6♦');
    expect(cardLabel(card('6', 'CLUBS'))).toBe('6♣');
    expect(cardLabel(card('6', 'SPADES'))).toBe('6♠');
    expect(cardLabel(card('K', 'SPADES'))).toBe('K♠');
    expect(cardLabel(card('10', 'HEARTS'))).toBe('10♥');
  });

  it('knows which suits are red, for the card face only', () => {
    expect(isRedSuit('HEARTS')).toBe(true);
    expect(isRedSuit('DIAMONDS')).toBe(true);
    expect(isRedSuit('CLUBS')).toBe(false);
    expect(isRedSuit('SPADES')).toBe(false);
  });

  it('treats only sixes as the target rank', () => {
    expect(isSix(card('6', 'HEARTS'))).toBe(true);
    expect(isSix(card('9', 'HEARTS'))).toBe(false);
    expect(isSix(card('K', 'HEARTS'))).toBe(false);
  });
});

describe('drawing cards', () => {
  it('never offers a card that has already been drawn', () => {
    const drawn = [card('6', 'HEARTS'), card('K', 'SPADES'), card('2', 'CLUBS')];
    const remaining = remainingDeck(drawn);
    expect(remaining).toHaveLength(52 - 3);
    for (const used of drawn) {
      expect(remaining.some(c => cardKey(c) === cardKey(used))).toBe(false);
    }
  });

  // The whole deck, drawn one card at a time, must come out exactly once each.
  it('empties the deck with no repeats and no omissions', () => {
    const random = seededRng(7);
    const drawn: Card[] = [];
    for (let i = 0; i < DECK_SIZE; i += 1) {
      const remaining = remainingDeck(drawn);
      expect(remaining).toHaveLength(DECK_SIZE - i);
      drawn.push(drawCard(remaining, random));
    }
    expect(new Set(drawn.map(cardKey)).size).toBe(DECK_SIZE);
    expect(remainingDeck(drawn)).toHaveLength(0);
  });

  it('refuses to draw from an empty deck rather than returning nothing', () => {
    expect(() => drawCard([], seededRng(1))).toThrow(/empty/);
  });

  it('refuses randomness outside the deck rather than picking a wrong card', () => {
    const remaining = remainingDeck([]);
    expect(() => drawCard(remaining, () => remaining.length)).toThrow(/out of range/);
    expect(() => drawCard(remaining, () => -1)).toThrow(/out of range/);
  });

  it('can reach every card in the deck across many draws', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed += 1) {
      seen.add(cardKey(drawCard(remainingDeck([]), seededRng(seed))));
    }
    // Not asserting all 52 — that would be a flaky coupon-collector bet. Enough spread
    // to show the pick is not fixed to one corner of the deck.
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('finding the sixes', () => {
  it('counts sixes among the drawn cards', () => {
    expect(countSixes([])).toBe(0);
    expect(countSixes([card('6', 'HEARTS'), card('K', 'SPADES')])).toBe(1);
    expect(countSixes([card('6', 'HEARTS'), card('6', 'CLUBS')])).toBe(2);
  });

  // The game ends on the fourth six, whatever is left in the deck.
  it('ends only once all four sixes are out', () => {
    const sixes = SUITS.map(suit => card('6', suit));
    expect(allSixesFound([])).toBe(false);
    expect(allSixesFound(sixes.slice(0, 3))).toBe(false);
    expect(allSixesFound(sixes)).toBe(true);
    // Plenty of cards left, but the game is over.
    expect(allSixesFound([...sixes, card('2', 'HEARTS')])).toBe(true);
  });

  it('does not end early on a pile of non-sixes', () => {
    const many = FULL_DECK.filter(c => !isSix(c));
    expect(many).toHaveLength(48);
    expect(allSixesFound(many)).toBe(false);
  });
});

describe('turn order', () => {
  const order = [11, 22, 33];

  it('walks the fixed order and wraps around', () => {
    expect(playerAtTurn(order, 0)).toBe(11);
    expect(playerAtTurn(order, 1)).toBe(22);
    expect(playerAtTurn(order, 2)).toBe(33);
    // Players go round more than once: the game ends on the sixes, not on one lap.
    expect(playerAtTurn(order, 3)).toBe(11);
    expect(playerAtTurn(order, 7)).toBe(22);
  });

  it('advances one seat at a time and wraps at the end', () => {
    expect(nextTurnIndex(0, 3)).toBe(1);
    expect(nextTurnIndex(1, 3)).toBe(2);
    expect(nextTurnIndex(2, 3)).toBe(0);
  });

  it('survives an empty order rather than dividing by zero', () => {
    expect(playerAtTurn([], 0)).toBeNull();
    expect(nextTurnIndex(3, 0)).toBe(0);
  });

  it('handles a single player without getting stuck', () => {
    expect(playerAtTurn([11], 5)).toBe(11);
    expect(nextTurnIndex(0, 1)).toBe(0);
  });
});

describe('the phase machine', () => {
  it('runs the host flow forwards only', () => {
    expect(canTransition('READY', 'PREDICTING')).toBe(true);
    expect(canTransition('PREDICTING', 'LOCKED')).toBe(true);
    expect(canTransition('LOCKED', 'DRAWING')).toBe(true);
    expect(canTransition('DRAWING', 'FINISHED')).toBe(true);
  });

  // Closing before starting is what makes "who has not predicted" meaningful.
  it('refuses to start before predictions are closed', () => {
    expect(canTransition('PREDICTING', 'DRAWING')).toBe(false);
    expect(canTransition('READY', 'DRAWING')).toBe(false);
  });

  it('refuses to reopen predictions once closed or running', () => {
    expect(canTransition('LOCKED', 'PREDICTING')).toBe(false);
    expect(canTransition('DRAWING', 'PREDICTING')).toBe(false);
    expect(canTransition('FINISHED', 'PREDICTING')).toBe(false);
  });

  it('treats a finished or cancelled game as terminal', () => {
    for (const to of ['READY', 'PREDICTING', 'LOCKED', 'DRAWING'] as PakEenZesStatus[]) {
      expect(canTransition('FINISHED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
  });

  it('can always be cancelled while it is still running', () => {
    for (const from of ['READY', 'PREDICTING', 'LOCKED', 'DRAWING'] as PakEenZesStatus[]) {
      expect(canTransition(from, 'CANCELLED')).toBe(true);
    }
  });

  it('marks the statuses that still occupy the block', () => {
    expect(isLive('PREDICTING')).toBe(true);
    expect(isLive('LOCKED')).toBe(true);
    expect(isLive('DRAWING')).toBe(true);
    expect(isLive('FINISHED')).toBe(false);
    expect(isLive('CANCELLED')).toBe(false);
  });
});

describe('predictions', () => {
  const eligible = [1, 2, 3, 4];

  it('needs exactly four names', () => {
    expect(PREDICTION_SLOTS).toBe(4);
    expect(validatePrediction([1, 2, 3, 4], eligible)).toEqual([1, 2, 3, 4]);
    expect(() => validatePrediction([1, 2, 3], eligible)).toThrow(/exactly 4/);
    expect(() => validatePrediction([1, 2, 3, 4, 1], eligible)).toThrow(/exactly 4/);
  });

  // The headline requirement: the same name more than once is valid, and must survive
  // as four ordered picks rather than collapsing to a set.
  it('keeps a duplicated name as separate picks, in order', () => {
    expect(validatePrediction([1, 2, 1, 3], eligible)).toEqual([1, 2, 1, 3]);
    expect(validatePrediction([1, 1, 1, 1], eligible)).toEqual([1, 1, 1, 1]);
  });

  it('lets a player pick themselves', () => {
    expect(validatePrediction([2, 2, 3, 4], eligible)).toEqual([2, 2, 3, 4]);
  });

  it('rejects a name that is not taking part', () => {
    expect(() => validatePrediction([1, 2, 3, 99], eligible)).toThrow(/not taking part/);
  });

  it('rejects anything that is not a list of players', () => {
    expect(() => validatePrediction('Daan', eligible)).toThrow(/list of player ids/);
    expect(() => validatePrediction([1, 2, 3, null], eligible)).toThrow(/not a player/);
    expect(() => validatePrediction([1, 2, 3, 0], eligible)).toThrow(/not a player/);
  });

  it('accepts numeric strings, because a select sends strings', () => {
    expect(validatePrediction(['1', '2', '2', '4'], eligible)).toEqual([1, 2, 2, 4]);
  });

  // Ready for the scoring step that is deliberately not built yet.
  it('counts how many of a prediction backed one player', () => {
    expect(picksForPlayer([1, 2, 1, 3], 1)).toBe(2);
    expect(picksForPlayer([1, 2, 1, 3], 4)).toBe(0);
    expect(picksForPlayer([1, 1, 1, 1], 1)).toBe(4);
  });
});

describe('block settings', () => {
  it('reads the instruction text and needs nothing else', () => {
    expect(pakEenZesBlockSettings({ body: 'Pak een kaart' }).instructions).toBe('Pak een kaart');
    expect(pakEenZesBlockSettings({}).instructions).toBe('');
    expect(pakEenZesBlockSettings(null).instructions).toBe('');
  });
});
