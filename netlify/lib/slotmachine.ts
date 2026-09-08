/**
 * Slotmachine rules: outcome types, the 3x3 field, weighted selection and configuration
 * validity.
 *
 * The machine pays for *patterns*, not for particular pictures. The Admin sets a chance
 * and a payout for each of five fixed outcome types; the server first draws a type from
 * that distribution and only then invents a 3x3 field that matches it, choosing symbols
 * and positions at random. So "three alike on a line" carries the configured chance no
 * matter which of the twelve symbols happens to fill it.
 *
 * Everything here is pure so the parts that decide money can be tested without a
 * database. The endpoints own locking and persistence; this file owns the rules.
 */

export const SLOT_REELS = [1, 2, 3] as const;

/**
 * Twelve symbols, shared by all three reels.
 *
 * The reels use the same artwork — that is what the Admin uploads once. Which symbol
 * lands where is decided per spin by the generator below, never configured.
 */
export const SLOT_POSITIONS_PER_REEL = 12;
export const SLOT_SYMBOL_COUNT = SLOT_POSITIONS_PER_REEL;

/** The visible field is 3 rows x 3 reels. Row 1 is the main row. */
export const SLOT_ROWS = 3;
export const SLOT_COLUMNS = 3;
export const SLOT_MAIN_ROW = 1;

/** How long the Big Screen reel animation runs before the outcome is treated as shown. */
export const SLOT_SPIN_MS = 3200;

/**
 * Hard ceiling on a series, and the default.
 *
 * Ten is the product rule, not a safety valve: a player buys their whole run up front
 * and then plays it out while everyone else waits, so a long series is a long wait for
 * the room. There is no topping up afterwards.
 */
export const SLOT_MAX_SPINS_LIMIT = 10;
export const SLOT_DEFAULT_MAX_SPINS = 10;

/** Fewest distinct symbols the generator needs: 9 cells, no symbol used more than twice. */
export const SLOT_MINIMUM_SYMBOLS = 5;

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

export const SLOT_OUTCOME_TYPES = [
  'NO_WIN',
  'TWO_SPLIT',
  'TWO_ADJACENT',
  'THREE_LINE',
  'THREE_ANYWHERE',
] as const;

export type SlotOutcomeType = typeof SLOT_OUTCOME_TYPES[number];

/**
 * Names in the Dutch the game is hosted in — the same words Settings lists and the
 * projector announces, so the two cannot drift apart.
 */
export const SLOT_OUTCOME_LABELS: Record<SlotOutcomeType, string> = {
  NO_WIN: 'Geen winst',
  TWO_SPLIT: '2 dezelfde gesplitst',
  TWO_ADJACENT: '2 dezelfde naast elkaar',
  THREE_LINE: '3 dezelfde op lijn',
  THREE_ANYWHERE: '3 dezelfde ergens zichtbaar',
};

export const SLOT_OUTCOME_DESCRIPTIONS: Record<SlotOutcomeType, string> = {
  NO_WIN: 'No winning pattern anywhere in the field.',
  TWO_SPLIT: 'Main row reads C D C — two alike, separated by a different symbol.',
  TWO_ADJACENT: 'Main row reads C C D or D C C — two alike, side by side.',
  THREE_LINE: 'Three alike on a row or a diagonal.',
  THREE_ANYWHERE: 'Three alike somewhere in the field, but not on a line.',
};

/** A payout on NO_WIN would contradict the category, so it is fixed at zero. */
export function outcomeTypeAllowsPayout(type: SlotOutcomeType) {
  return type !== 'NO_WIN';
}

export function isSlotOutcomeType(value: unknown): value is SlotOutcomeType {
  return typeof value === 'string' && (SLOT_OUTCOME_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

/** Symbol positions (1-12) as [row][column]; row 1 is the main row. */
export type SlotGrid = number[][];
export type SlotCell = [row: number, column: number];

/**
 * The five paylines: three rows and two diagonals.
 *
 * Columns are deliberately not paylines — a column is a single reel, and three alike
 * down one reel is not something a player reads as a win.
 */
export const SLOT_LINES: SlotCell[][] = [
  [[0, 0], [0, 1], [0, 2]],
  [[1, 0], [1, 1], [1, 2]],
  [[2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 1], [2, 2]],
  [[0, 2], [1, 1], [2, 0]],
];

const ALL_CELLS: SlotCell[] = Array.from({ length: SLOT_ROWS }, (_, row) =>
  Array.from({ length: SLOT_COLUMNS }, (_, column) => [row, column] as SlotCell)).flat();

const cellKey = ([row, column]: SlotCell) => `${row},${column}`;
const LINE_KEYS = SLOT_LINES.map(line => line.map(cellKey).sort().join('|'));

/** Lines whose three cells all hold the same symbol. */
function completedLines(grid: SlotGrid): SlotCell[][] {
  return SLOT_LINES.filter(line => {
    const [a, b, c] = line.map(([row, column]) => grid[row]?.[column]);
    return a != null && a === b && b === c;
  });
}

function symbolCells(grid: SlotGrid) {
  const cells = new Map<number, SlotCell[]>();
  for (const [row, column] of ALL_CELLS) {
    const symbol = grid[row]?.[column];
    if (symbol == null) continue;
    const found = cells.get(symbol) || [];
    found.push([row, column]);
    cells.set(symbol, found);
  }
  return cells;
}

/** The main row's matching pair, if it has exactly one. */
function mainRowPair(grid: SlotGrid): { cells: SlotCell[]; adjacent: boolean } | null {
  const row = grid[SLOT_MAIN_ROW];
  if (!row) return null;
  const [left, middle, right] = row;
  if (left == null || middle == null || right == null) return null;
  if (left === middle && middle === right) return null; // three alike is a line, not a pair
  if (left === middle) return { cells: [[SLOT_MAIN_ROW, 0], [SLOT_MAIN_ROW, 1]], adjacent: true };
  if (middle === right) return { cells: [[SLOT_MAIN_ROW, 1], [SLOT_MAIN_ROW, 2]], adjacent: true };
  if (left === right) return { cells: [[SLOT_MAIN_ROW, 0], [SLOT_MAIN_ROW, 2]], adjacent: false };
  return null;
}

/**
 * What a finished field actually pays, read off the field itself.
 *
 * This is the arbiter rather than the generator: after building a field the server
 * classifies it and refuses anything the player cannot see. Precedence runs strongest
 * pattern first so the answer is one type rather than a set — three on a line outranks
 * a loose triple, and either outranks a pair on the main row.
 */
export function classifyGrid(grid: SlotGrid): SlotOutcomeType {
  if (completedLines(grid).length > 0) return 'THREE_LINE';
  for (const cells of symbolCells(grid).values()) {
    if (cells.length >= 3) return 'THREE_ANYWHERE';
  }
  const pair = mainRowPair(grid);
  if (pair) return pair.adjacent ? 'TWO_ADJACENT' : 'TWO_SPLIT';
  return 'NO_WIN';
}

/** The cells the Big Screen highlights for a field's winning pattern. */
export function winningCells(grid: SlotGrid): SlotCell[] {
  const type = classifyGrid(grid);
  if (type === 'THREE_LINE') {
    const seen = new Set<string>();
    const cells: SlotCell[] = [];
    for (const line of completedLines(grid)) {
      for (const cell of line) {
        if (seen.has(cellKey(cell))) continue;
        seen.add(cellKey(cell));
        cells.push(cell);
      }
    }
    return cells;
  }
  if (type === 'THREE_ANYWHERE') {
    for (const cells of symbolCells(grid).values()) {
      if (cells.length >= 3) return cells;
    }
    return [];
  }
  if (type === 'TWO_ADJACENT' || type === 'TWO_SPLIT') return mainRowPair(grid)?.cells ?? [];
  return [];
}

// ---------------------------------------------------------------------------
// Weighted selection of the outcome type
// ---------------------------------------------------------------------------

export type SlotOutcomeWeight = { type: SlotOutcomeType; weight: number; payoutMultiplier: number };

export type Rng = (maxExclusive: number) => number;

/**
 * Draw one of the five types from the configured distribution.
 *
 * `random` takes the caller's randomness — the endpoint passes cryptographic
 * randomness, tests pass a fixed sequence.
 */
export function pickOutcomeType(
  weights: SlotOutcomeWeight[],
  totalWeight: number,
  random: Rng,
): SlotOutcomeWeight {
  const weighted = weights.filter(w => w.weight > 0);
  if (!weighted.length) throw new Error('Slotmachine has no weighted outcome types');
  const allocated = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (allocated !== totalWeight) throw new Error('Slotmachine weights do not match the configured total');

  let ticket = random(allocated);
  if (!Number.isInteger(ticket) || ticket < 0 || ticket >= allocated) throw new Error('Slotmachine randomness out of range');
  for (const entry of weighted) {
    if (ticket < entry.weight) return entry;
    ticket -= entry.weight;
  }
  // Unreachable while the weights sum to `allocated`; kept so a future change cannot
  // silently return undefined into a money path.
  throw new Error('Slotmachine weighted selection failed');
}

// ---------------------------------------------------------------------------
// Generating a field for a chosen type
// ---------------------------------------------------------------------------

function pickFrom<T>(items: readonly T[], random: Rng): T {
  if (!items.length) throw new Error('Cannot pick from an empty set');
  return items[random(items.length)];
}

function shuffle<T>(items: readonly T[], random: Rng): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Every set of three cells that is NOT one of the paylines. */
const NON_LINE_TRIPLES: SlotCell[][] = (() => {
  const triples: SlotCell[][] = [];
  for (let a = 0; a < ALL_CELLS.length; a += 1) {
    for (let b = a + 1; b < ALL_CELLS.length; b += 1) {
      for (let c = b + 1; c < ALL_CELLS.length; c += 1) {
        const triple = [ALL_CELLS[a], ALL_CELLS[b], ALL_CELLS[c]];
        if (!LINE_KEYS.includes(triple.map(cellKey).sort().join('|'))) triples.push(triple);
      }
    }
  }
  return triples;
})();

const emptyGrid = (): (number | null)[][] =>
  Array.from({ length: SLOT_ROWS }, () => Array.from({ length: SLOT_COLUMNS }, () => null));

/**
 * Fill the blank cells without creating a pattern the caller did not ask for.
 *
 * Two rules do the work. A per-symbol cap stops any symbol reaching three occurrences,
 * which is what would turn a pair into a loose triple. And a candidate is rejected if it
 * would complete a payline, which is what would turn anything into three on a line.
 * Returns null when it paints itself into a corner, so the caller can retry.
 */
function fillBlanks(
  grid: (number | null)[][],
  symbols: readonly number[],
  caps: Map<number, number>,
  random: Rng,
): SlotGrid | null {
  const blanks = ALL_CELLS.filter(([row, column]) => grid[row][column] == null);
  for (const [row, column] of shuffle(blanks, random)) {
    let placed = false;
    for (const symbol of shuffle(symbols, random)) {
      if ((caps.get(symbol) ?? 0) <= 0) continue;
      grid[row][column] = symbol;
      // Only lines running through the cell just filled. Checking every line instead
      // would also see the line a THREE_LINE field deliberately completed before
      // filling started, and reject every possible filler.
      const completesLine = SLOT_LINES.some(line => {
        if (!line.some(([r, c]) => r === row && c === column)) return false;
        const values = line.map(([r, c]) => grid[r][c]);
        return values.every(value => value != null) && values[0] === values[1] && values[1] === values[2];
      });
      if (completesLine) {
        grid[row][column] = null;
        continue;
      }
      caps.set(symbol, (caps.get(symbol) ?? 0) - 1);
      placed = true;
      break;
    }
    if (!placed) return null;
  }
  return grid as SlotGrid;
}

/** Cap table: every symbol may appear at most twice unless the caller overrides it. */
function baseCaps(symbols: readonly number[], used: Map<number, number>) {
  const caps = new Map<number, number>();
  for (const symbol of symbols) caps.set(symbol, 2 - (used.get(symbol) ?? 0));
  return caps;
}

function attemptGrid(type: SlotOutcomeType, symbols: readonly number[], random: Rng): SlotGrid | null {
  const grid = emptyGrid();
  const used = new Map<number, number>();
  const use = ([row, column]: SlotCell, symbol: number) => {
    grid[row][column] = symbol;
    used.set(symbol, (used.get(symbol) ?? 0) + 1);
  };

  if (type === 'NO_WIN') {
    // A pair on the main row is itself a win, so the main row must be three distinct
    // symbols; the cap then stops any symbol reaching three.
    const [a, b, c] = shuffle(symbols, random).slice(0, 3);
    use([SLOT_MAIN_ROW, 0], a);
    use([SLOT_MAIN_ROW, 1], b);
    use([SLOT_MAIN_ROW, 2], c);
    return fillBlanks(grid, symbols, baseCaps(symbols, used), random);
  }

  if (type === 'TWO_SPLIT' || type === 'TWO_ADJACENT') {
    const [pairSymbol, otherSymbol] = shuffle(symbols, random).slice(0, 2);
    if (type === 'TWO_SPLIT') {
      use([SLOT_MAIN_ROW, 0], pairSymbol);
      use([SLOT_MAIN_ROW, 1], otherSymbol);
      use([SLOT_MAIN_ROW, 2], pairSymbol);
    } else {
      // Left or right pair, chosen at random so the win does not always sit on one side.
      const pairOnLeft = random(2) === 0;
      use([SLOT_MAIN_ROW, pairOnLeft ? 0 : 1], pairSymbol);
      use([SLOT_MAIN_ROW, pairOnLeft ? 1 : 2], pairSymbol);
      use([SLOT_MAIN_ROW, pairOnLeft ? 2 : 0], otherSymbol);
    }
    const caps = baseCaps(symbols, used);
    // The pair symbol already sits at two; a third occurrence anywhere would upgrade the
    // spin to a loose triple — a different category and a different payout.
    caps.set(pairSymbol, 0);
    return fillBlanks(grid, symbols, caps, random);
  }

  if (type === 'THREE_LINE') {
    const symbol = pickFrom(symbols, random);
    for (const cell of pickFrom(SLOT_LINES, random)) use(cell, symbol);
    const caps = baseCaps(symbols, used);
    caps.set(symbol, 0);
    return fillBlanks(grid, symbols, caps, random);
  }

  // THREE_ANYWHERE: exactly three alike, on three cells that are not a payline.
  const symbol = pickFrom(symbols, random);
  for (const cell of pickFrom(NON_LINE_TRIPLES, random)) use(cell, symbol);
  const caps = baseCaps(symbols, used);
  caps.set(symbol, 0);
  return fillBlanks(grid, symbols, caps, random);
}

/**
 * Build a 3x3 field that matches the chosen outcome type.
 *
 * The field is classified after it is built and rejected unless it matches exactly, so
 * the configured chances are the chances players actually see: a spin drawn as "two
 * alike side by side" can never turn out to also show three alike. Construction already
 * respects those constraints — the check and the retry are what make it a guarantee
 * rather than an intention.
 */
export function generateGrid(
  type: SlotOutcomeType,
  symbols: readonly number[],
  random: Rng,
  attempts = 60,
): SlotGrid {
  const distinct = [...new Set(symbols)];
  if (distinct.length < SLOT_MINIMUM_SYMBOLS) {
    throw new Error(`Slotmachine needs at least ${SLOT_MINIMUM_SYMBOLS} symbols to build a field`);
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const grid = attemptGrid(type, distinct, random);
    if (grid && classifyGrid(grid) === type) return grid;
  }
  throw new Error(`Slotmachine could not build a ${type} field`);
}

// ---------------------------------------------------------------------------
// Symbols, money and configuration
// ---------------------------------------------------------------------------

/**
 * Positions are 1-12; the shorthand A-L is what makes a field readable in a log or a
 * test. Purely a display convention — the database stores positions.
 */
export function symbolLetter(position: number) {
  if (!Number.isInteger(position) || position < 1 || position > SLOT_POSITIONS_PER_REEL) return '?';
  return String.fromCharCode(64 + position);
}

/** A field as three rows of letters, e.g. "ABC/DDE/FGH". For logs and tests. */
export function gridLabel(grid: SlotGrid) {
  return grid.map(row => row.map(symbolLetter).join('')).join('/');
}

export function isValidPosition(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SLOT_POSITIONS_PER_REEL;
}

/**
 * `percentage = kans / totaal x 100`, the formula the Settings table shows.
 *
 * Multiplies before dividing: `7 / 100 * 100` lands on 7.000000000000001 in binary
 * floating point, which then renders as a wrong-looking percentage.
 */
export function outcomePercentage(weight: number, totalWeight: number) {
  if (!totalWeight || totalWeight <= 0) return 0;
  return (weight * 100) / totalWeight;
}

/** Payout is always computed over the stake for one spin, never over the series total. */
export function slotPayout(stakePerSpin: number, payoutMultiplier: number) {
  return Math.round(stakePerSpin * payoutMultiplier);
}

export function seriesTotalStake(stakePerSpin: number, spins: number) {
  return stakePerSpin * spins;
}

export type SlotConfigStatus = {
  valid: boolean;
  totalWeight: number;
  allocatedWeight: number;
  /** Positive when the chances are short of the total, negative when they exceed it. */
  remainingWeight: number;
  symbolCount: number;
  reason: string;
};

export type SlotConfigSummary = {
  totalWeight: number;
  allocatedWeight: number;
  symbolCount: number;
};

/**
 * The single definition of "this machine may be used".
 *
 * Two callers reach the same facts by different routes — the Admin read loads the whole
 * configuration, the player snapshot derives the numbers from SQL aggregates on its
 * hottest query — so the verdict lives here and both call it.
 *
 * The full set of twelve symbols is required because the generator draws freely from it:
 * a spin is no longer tied to particular pictures, so every picture has to exist.
 */
export function describeSlotConfig(summary: SlotConfigSummary): SlotConfigStatus {
  const { totalWeight, allocatedWeight, symbolCount } = summary;
  const remainingWeight = totalWeight - allocatedWeight;
  const base = { totalWeight, allocatedWeight, remainingWeight, symbolCount };

  if (totalWeight <= 0) return { ...base, valid: false, reason: 'Set a total number of chances above zero.' };
  if (remainingWeight > 0) return { ...base, valid: false, reason: `Configuration is not complete — ${remainingWeight} of ${totalWeight} chances are unassigned.` };
  if (remainingWeight < 0) return { ...base, valid: false, reason: `Configuration exceeds the total by ${Math.abs(remainingWeight)} chances.` };
  if (symbolCount < SLOT_SYMBOL_COUNT) {
    const missing = SLOT_SYMBOL_COUNT - symbolCount;
    return { ...base, valid: false, reason: `Upload the remaining ${missing} symbol${missing === 1 ? '' : 's'} — the machine draws from all ${SLOT_SYMBOL_COUNT}.` };
  }
  return { ...base, valid: true, reason: 'Configuration is valid.' };
}

export function evaluateSlotConfig(
  totalWeight: number,
  weights: SlotOutcomeWeight[],
  symbolPositions: Set<number>,
): SlotConfigStatus {
  return describeSlotConfig({
    totalWeight,
    allocatedWeight: weights.reduce((sum, w) => sum + w.weight, 0),
    symbolCount: symbolPositions.size,
  });
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export type SlotSeriesTurn = {
  seriesId: number;
  playerId: number;
  playerName?: string;
  stakePerSpin: number;
  totalSpins: number;
  spinsRemaining: number;
  status: string;
};

export type SlotTurn = {
  /** Whose turn it is, or null when nobody has spins left. */
  current: SlotSeriesTurn | null;
  /** True while a spin is still resolving; no new spin may start. */
  spinning: boolean;
  /** Who plays after the current player finishes their whole run. */
  next: SlotSeriesTurn | null;
  /** Series with spins left, in turn order. */
  queue: SlotSeriesTurn[];
  /** Series that used every spin they bought. */
  finished: SlotSeriesTurn[];
};

/**
 * Whose turn it is, derived from the series rows rather than stored anywhere.
 *
 * One player at a time, and that player uses their entire bought run before the next
 * one starts. Turn order is the order the series were locked in, which is why `series`
 * must arrive in that order — the queue is simply "who still has spins", and the head
 * of it is up.
 *
 * Deriving instead of storing a pointer is deliberate: a stored turn index can drift
 * out of step with the spins that actually happened, and there is no reconciliation
 * step that could fix it. Here the spins *are* the turn state.
 *
 * `spinningPlayerId` keeps the current player in place while their spin is still
 * resolving, even once it took their last spin. Without that the projector would cut to
 * the next player while the previous one's final result was still on screen.
 */
export function resolveSlotTurn(series: SlotSeriesTurn[], spinningPlayerId: number | null = null): SlotTurn {
  const queue = series.filter(s => s.status === 'ACTIVE' && s.spinsRemaining > 0);
  const finished = series.filter(s => s.status !== 'CANCELLED' && s.spinsRemaining === 0);

  const mid = spinningPlayerId == null
    ? null
    : series.find(s => s.playerId === spinningPlayerId && s.status !== 'CANCELLED') ?? null;

  const current = mid ?? queue[0] ?? null;
  const next = queue.find(s => s.seriesId !== current?.seriesId) ?? null;

  return { current, spinning: Boolean(mid), next, queue, finished };
}

/** Whether this player may start a spin right now. The server's answer, not the phone's. */
export function maySpin(turn: SlotTurn, playerId: number) {
  if (turn.spinning) return false;
  return Boolean(turn.current && turn.current.playerId === playerId && turn.current.spinsRemaining > 0);
}

/** Spins a player may still lock, bounded by the block's maximum and their wallet. */
export function maxLockableSpins(stakePerSpin: number, balance: number, blockMaxSpins: number) {
  if (stakePerSpin <= 0) return 0;
  return Math.max(0, Math.min(blockMaxSpins, Math.floor(balance / stakePerSpin)));
}
