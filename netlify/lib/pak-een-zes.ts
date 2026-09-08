/**
 * Pak een Zes rules: the deck, the turn order, the prediction shape and the state
 * machine.
 *
 * Players first predict which four of them will draw a six — duplicates and self-picks
 * allowed. Then the host starts the game and players take turns drawing one card from a
 * real 52-card deck until all four sixes are out.
 *
 * Everything here is pure so the parts that decide the game can be tested without a
 * database. The endpoints own locking and persistence; this file owns the rules.
 */

export const SUITS = ['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES'] as const;
export type Suit = typeof SUITS[number];

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type Rank = typeof RANKS[number];

export const SUIT_SYMBOLS: Record<Suit, string> = {
  HEARTS: '♥',
  DIAMONDS: '♦',
  CLUBS: '♣',
  SPADES: '♠',
};

/** Hearts and diamonds are the red suits — used by the card face, not by any rule. */
export const RED_SUITS: Suit[] = ['HEARTS', 'DIAMONDS'];

export type Card = { rank: Rank; suit: Suit };

/** The rank the whole game is named after. */
export const TARGET_RANK: Rank = '6';
/** One per suit, so the game ends after exactly this many. */
export const SIXES_IN_DECK = SUITS.length;
export const DECK_SIZE = RANKS.length * SUITS.length; // 52
/** Everyone predicts exactly this many names. */
export const PREDICTION_SLOTS = 4;

/**
 * Default points for one correct prediction.
 *
 * One game-wide number, set by the Admin in Settings — not per player, per six or per
 * slot. This is only the starting value; the configured one is always read from the
 * database, never from here.
 */
export const DEFAULT_POINTS_PER_CORRECT = 25;

export const FULL_DECK: Card[] = SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })));

export const cardKey = (card: Card) => `${card.rank}-${card.suit}`;
export const cardLabel = (card: Card) => `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
export const isSix = (card: Card) => card.rank === TARGET_RANK;
export const isRedSuit = (suit: Suit) => RED_SUITS.includes(suit);

export function isSuit(value: unknown): value is Suit {
  return typeof value === 'string' && (SUITS as readonly string[]).includes(value);
}

export function isRank(value: unknown): value is Rank {
  return typeof value === 'string' && (RANKS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const PAK_EEN_ZES_STATUSES = ['READY', 'PREDICTING', 'LOCKED', 'DRAWING', 'FINISHED', 'CANCELLED'] as const;
export type PakEenZesStatus = typeof PAK_EEN_ZES_STATUSES[number];

/**
 * The host's flow is deliberately explicit: open predictions, close them, then start.
 *
 * Closing before starting is what makes "who has not predicted yet" a meaningful
 * question — once cards are being drawn, a late prediction would be a prediction about
 * something already happening.
 */
const ALLOWED_TRANSITIONS: Record<PakEenZesStatus, PakEenZesStatus[]> = {
  READY: ['PREDICTING', 'CANCELLED'],
  PREDICTING: ['LOCKED', 'CANCELLED'],
  LOCKED: ['DRAWING', 'CANCELLED'],
  DRAWING: ['FINISHED', 'CANCELLED'],
  FINISHED: [],
  CANCELLED: [],
};

export function canTransition(from: PakEenZesStatus, to: PakEenZesStatus) {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isPakEenZesStatus(value: unknown): value is PakEenZesStatus {
  return typeof value === 'string' && (PAK_EEN_ZES_STATUSES as readonly string[]).includes(value);
}

/** Statuses where the game still occupies the block and would keep running. */
export const LIVE_STATUSES: PakEenZesStatus[] = ['PREDICTING', 'LOCKED', 'DRAWING'];

export function isLive(status: PakEenZesStatus) {
  return LIVE_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export type Rng = (maxExclusive: number) => number;

/**
 * The cards still in the deck.
 *
 * Takes what has already been drawn rather than tracking a shuffled deck, because the
 * database is the source of truth: the drawn rows are the deck's history, so the
 * remainder is always derived from them and a replayed request cannot resurrect a card.
 */
export function remainingDeck(drawn: Card[]): Card[] {
  const used = new Set(drawn.map(cardKey));
  return FULL_DECK.filter(card => !used.has(cardKey(card)));
}

/**
 * Draw one card from what is left.
 *
 * `random` takes the caller's randomness — the endpoint passes cryptographic
 * randomness, tests pass a fixed sequence.
 */
export function drawCard(remaining: Card[], random: Rng): Card {
  if (!remaining.length) throw new Error('The deck is empty');
  const index = random(remaining.length);
  if (!Number.isInteger(index) || index < 0 || index >= remaining.length) {
    throw new Error('Card randomness out of range');
  }
  return remaining[index];
}

export function countSixes(drawn: Card[]) {
  return drawn.filter(isSix).length;
}

/** The game ends the moment the fourth six is out, regardless of cards left. */
export function allSixesFound(drawn: Card[]) {
  return countSixes(drawn) >= SIXES_IN_DECK;
}

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/**
 * Whose turn it is.
 *
 * The order is fixed when the game starts and the index simply walks it, wrapping at the
 * end — the game is over when the sixes run out, not when everyone has had a turn, so
 * players may well go round more than once.
 */
export function playerAtTurn<T>(order: T[], turnIndex: number): T | null {
  if (!order.length) return null;
  const index = ((turnIndex % order.length) + order.length) % order.length;
  return order[index];
}

export function nextTurnIndex(turnIndex: number, participantCount: number) {
  if (participantCount <= 0) return 0;
  return (turnIndex + 1) % participantCount;
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

/**
 * Validate a prediction: exactly four picks, each one a participant.
 *
 * Duplicates are explicitly allowed — betting on the same person twice is a legitimate
 * strategy, and so is picking yourself — so this deliberately does not de-duplicate.
 * The slots are ordered and stored per slot, which is what keeps "Daan, Twan, Daan, Bas"
 * intact rather than collapsing to three names.
 */
export function validatePrediction(picks: unknown, eligiblePlayerIds: number[]): number[] {
  if (!Array.isArray(picks)) throw new Error('A prediction must be a list of player ids');
  if (picks.length !== PREDICTION_SLOTS) throw new Error(`A prediction needs exactly ${PREDICTION_SLOTS} names`);
  const eligible = new Set(eligiblePlayerIds);
  return picks.map((pick, index) => {
    const id = typeof pick === 'number' ? pick : Number(pick);
    if (!Number.isInteger(id) || id < 1) throw new Error(`Pick ${index + 1} is not a player`);
    if (!eligible.has(id)) throw new Error(`Pick ${index + 1} is not taking part in this game`);
    return id;
  });
}

/** How many of a player's four picks named a given player. Ready for later scoring. */
export function picksForPlayer(picks: number[], playerId: number) {
  return picks.filter(id => id === playerId).length;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * How many of a prediction came true.
 *
 * A multiset intersection, not a set one: each pick is matched against one six that
 * player actually drew, and a six can only satisfy one pick. That is what makes the
 * brief's example come out at three —
 *
 *   predicted  Bas, Twan, Bas, Emma
 *   drew a six Bas, Jorrit, Bas, Emma
 *
 * Bas is named twice and drew two sixes, so both of those picks count. Naming Bas twice
 * when he drew only one six counts once, which is the same rule read from the other
 * side: you cannot earn twice for a six that only happened once.
 */
export function countCorrectPredictions(picks: number[], sixDrawerIds: number[]): number {
  const remaining = new Map<number, number>();
  for (const id of sixDrawerIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);

  let correct = 0;
  for (const pick of picks) {
    const left = remaining.get(pick) ?? 0;
    if (left <= 0) continue;
    remaining.set(pick, left - 1);
    correct += 1;
  }
  return correct;
}

/** Points earned: the same rate for every correct prediction. */
export function predictionPoints(correct: number, pointsPerCorrect: number) {
  if (correct <= 0 || pointsPerCorrect <= 0) return 0;
  return correct * pointsPerCorrect;
}
