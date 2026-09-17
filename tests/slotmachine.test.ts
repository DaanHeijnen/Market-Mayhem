import { describe, expect, it } from 'vitest';
import {
  classifyGrid,
  describeSlotConfig,
  evaluateSlotConfig,
  generateGrid,
  gridLabel,
  maxLockableSpins,
  maySpin,
  outcomePercentage,
  outcomeTypeAllowsPayout,
  pickOutcomeType,
  resolveSlotTurn,
  seriesTotalStake,
  slotPayout,
  symbolLetter,
  winningCells,
  SLOT_LINES,
  SLOT_MAIN_ROW,
  SLOT_MAX_SPINS_LIMIT,
  SLOT_OUTCOME_LABELS,
  SLOT_OUTCOME_TYPES,
  SLOT_SYMBOL_COUNT,
  type SlotGrid,
  type SlotOutcomeType,
  type SlotOutcomeWeight,
  type SlotSeriesTurn,
} from '../netlify/lib/slotmachine';
import { playerMayPlaySlot } from '../netlify/lib/slot-state';

/** All twelve symbol positions have artwork. */
const allSymbols = () => new Set(Array.from({ length: 12 }, (_, i) => i + 1));
const SYMBOLS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * A deterministic stand-in for crypto randomness. Cycles a seed through a simple LCG so
 * a failing case can be reproduced from its seed.
 */
function seededRng(seed: number) {
  let state = seed >>> 0;
  return (maxExclusive: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maxExclusive;
  };
}

const weight = (type: SlotOutcomeType, w: number, payoutMultiplier = 0): SlotOutcomeWeight =>
  ({ type, weight: w, payoutMultiplier });

describe('slotmachine outcome types', () => {
  it('has exactly the five fixed categories', () => {
    expect(SLOT_OUTCOME_TYPES).toEqual(['NO_WIN', 'TWO_SPLIT', 'TWO_ADJACENT', 'THREE_LINE', 'THREE_ANYWHERE']);
  });

  it('names each category the way Settings and the projector both say it', () => {
    expect(SLOT_OUTCOME_LABELS.NO_WIN).toBe('Geen winst');
    expect(SLOT_OUTCOME_LABELS.TWO_SPLIT).toBe('2 dezelfde gesplitst');
    expect(SLOT_OUTCOME_LABELS.TWO_ADJACENT).toBe('2 dezelfde naast elkaar');
    expect(SLOT_OUTCOME_LABELS.THREE_LINE).toBe('3 dezelfde op lijn');
    expect(SLOT_OUTCOME_LABELS.THREE_ANYWHERE).toBe('3 dezelfde ergens zichtbaar');
  });

  it('allows a payout on every category except no-win', () => {
    expect(outcomeTypeAllowsPayout('NO_WIN')).toBe(false);
    for (const type of SLOT_OUTCOME_TYPES.filter(t => t !== 'NO_WIN')) {
      expect(outcomeTypeAllowsPayout(type)).toBe(true);
    }
  });

  it('offers five paylines: three rows and two diagonals, and no columns', () => {
    expect(SLOT_LINES).toHaveLength(5);
    // A column would be [[0,c],[1,c],[2,c]] — none of the lines is one.
    const columns = [0, 1, 2].map(c => [[0, c], [1, c], [2, c]]);
    for (const column of columns) {
      expect(SLOT_LINES.some(line => JSON.stringify(line) === JSON.stringify(column))).toBe(false);
    }
  });
});

describe('classifying a field', () => {
  // Letters name symbols only for readability here; the machine has no notion of
  // "symbol A is special".
  const grid = (rows: string[]): SlotGrid =>
    rows.map(row => [...row].map(letter => letter.charCodeAt(0) - 64));

  it('reads three alike on the main row as three on a line', () => {
    expect(classifyGrid(grid(['BCD', 'AAA', 'EFG']))).toBe('THREE_LINE');
  });

  it('reads three alike on the top or bottom row as three on a line', () => {
    expect(classifyGrid(grid(['AAA', 'BCD', 'EFG']))).toBe('THREE_LINE');
    expect(classifyGrid(grid(['BCD', 'EFG', 'AAA']))).toBe('THREE_LINE');
  });

  it('reads both diagonals as lines', () => {
    expect(classifyGrid(grid(['ABC', 'DAE', 'FGA']))).toBe('THREE_LINE');
    expect(classifyGrid(grid(['CBA', 'DAE', 'AFG']))).toBe('THREE_LINE');
  });

  it('does not treat a column as a win', () => {
    // A down the first column, nothing else alike — three alike are visible, so this is
    // a loose triple rather than a line, and never THREE_LINE.
    expect(classifyGrid(grid(['ABC', 'ADE', 'AFG']))).toBe('THREE_ANYWHERE');
  });

  it('reads C C D and D C C on the main row as two alike side by side', () => {
    expect(classifyGrid(grid(['BCD', 'AAE', 'FGH']))).toBe('TWO_ADJACENT');
    expect(classifyGrid(grid(['BCD', 'EAA', 'FGH']))).toBe('TWO_ADJACENT');
  });

  it('reads C D C on the main row as two alike split', () => {
    expect(classifyGrid(grid(['BCD', 'AEA', 'FGH']))).toBe('TWO_SPLIT');
  });

  it('ignores a pair that is not on the main row', () => {
    // Two alike on the top row only — not a win, because only the main row pays pairs.
    expect(classifyGrid(grid(['AAB', 'CDE', 'FGH']))).toBe('NO_WIN');
  });

  it('reads three alike off the paylines as a loose triple', () => {
    // A at top-left, middle-right and bottom-left: three visible, no straight line.
    expect(classifyGrid(grid(['ABC', 'DEA', 'AFG']))).toBe('THREE_ANYWHERE');
  });

  it('reads a field with nothing alike as no win', () => {
    expect(classifyGrid(grid(['ABC', 'DEF', 'GHI']))).toBe('NO_WIN');
  });

  // Precedence matters for money: a field that shows both must pay one thing, and it
  // must be the thing the player's eye goes to.
  it('lets three on a line outrank a loose triple in the same field', () => {
    // A forms the top row AND appears a fourth time at bottom-centre.
    expect(classifyGrid(grid(['AAA', 'BCD', 'EAF']))).toBe('THREE_LINE');
  });

  it('lets a loose triple outrank a pair on the main row', () => {
    // A pairs on the main row and appears once more at top-left — three visible.
    expect(classifyGrid(grid(['ABC', 'AAD', 'EFG']))).toBe('THREE_ANYWHERE');
  });

  it('highlights the cells a player should look at', () => {
    expect(winningCells(grid(['BCD', 'AAA', 'EFG']))).toEqual([[1, 0], [1, 1], [1, 2]]);
    expect(winningCells(grid(['BCD', 'AAE', 'FGH']))).toEqual([[1, 0], [1, 1]]);
    expect(winningCells(grid(['BCD', 'AEA', 'FGH']))).toEqual([[1, 0], [1, 2]]);
    expect(winningCells(grid(['ABC', 'DEA', 'AFG']))).toEqual([[0, 0], [1, 2], [2, 0]]);
    expect(winningCells(grid(['ABC', 'DEF', 'GHI']))).toEqual([]);
  });
});

describe('generating a field for a chosen type', () => {
  // The central guarantee of the whole feature: the category the randomiser drew is the
  // category the field shows. If this ever fails, the configured chances are a lie.
  it('always produces a field that classifies as the requested type', () => {
    for (const type of SLOT_OUTCOME_TYPES) {
      for (let seed = 1; seed <= 300; seed += 1) {
        const grid = generateGrid(type, SYMBOLS, seededRng(seed));
        expect(classifyGrid(grid), `${type} seed ${seed} produced ${gridLabel(grid)}`).toBe(type);
      }
    }
  });

  it('never lets a weaker category hide a stronger pattern', () => {
    for (const type of ['NO_WIN', 'TWO_SPLIT', 'TWO_ADJACENT'] as SlotOutcomeType[]) {
      for (let seed = 1; seed <= 300; seed += 1) {
        const grid = generateGrid(type, SYMBOLS, seededRng(seed));
        const counts = new Map<number, number>();
        for (const row of grid) for (const symbol of row) counts.set(symbol, (counts.get(symbol) || 0) + 1);
        // No symbol reaches three, so no loose triple can be lurking.
        expect(Math.max(...counts.values()), `${type} seed ${seed}: ${gridLabel(grid)}`).toBeLessThan(3);
        // And no payline is complete.
        for (const line of SLOT_LINES) {
          const [a, b, c] = line.map(([r, col]) => grid[r][col]);
          expect(a === b && b === c).toBe(false);
        }
      }
    }
  });

  it('puts the main row pair side by side for adjacent and apart for split', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const adjacent = generateGrid('TWO_ADJACENT', SYMBOLS, seededRng(seed))[SLOT_MAIN_ROW];
      expect(adjacent[0] === adjacent[1] || adjacent[1] === adjacent[2]).toBe(true);
      expect(adjacent[0] === adjacent[2]).toBe(false);

      const split = generateGrid('TWO_SPLIT', SYMBOLS, seededRng(seed))[SLOT_MAIN_ROW];
      expect(split[0]).toBe(split[2]);
      expect(split[1]).not.toBe(split[0]);
    }
  });

  it('uses both the left and the right pair for adjacent wins', () => {
    const sides = new Set<string>();
    for (let seed = 1; seed <= 120; seed += 1) {
      const row = generateGrid('TWO_ADJACENT', SYMBOLS, seededRng(seed))[SLOT_MAIN_ROW];
      sides.add(row[0] === row[1] ? 'left' : 'right');
    }
    expect(sides).toEqual(new Set(['left', 'right']));
  });

  it('puts the three on an actual payline for a line win', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const grid = generateGrid('THREE_LINE', SYMBOLS, seededRng(seed));
      const onLine = SLOT_LINES.some(line => {
        const [a, b, c] = line.map(([r, col]) => grid[r][col]);
        return a === b && b === c;
      });
      expect(onLine).toBe(true);
    }
  });

  it('keeps a loose triple off every payline', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const grid = generateGrid('THREE_ANYWHERE', SYMBOLS, seededRng(seed));
      for (const line of SLOT_LINES) {
        const [a, b, c] = line.map(([r, col]) => grid[r][col]);
        expect(a === b && b === c).toBe(false);
      }
      const counts = new Map<number, number>();
      for (const row of grid) for (const symbol of row) counts.set(symbol, (counts.get(symbol) || 0) + 1);
      expect([...counts.values()].filter(n => n >= 3)).toHaveLength(1);
    }
  });

  // Any of the twelve may fill any pattern — that is what "payout belongs to the
  // pattern, not the picture" means.
  it('draws the winning symbol from the whole symbol set over many spins', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 600; seed += 1) {
      const grid = generateGrid('THREE_LINE', SYMBOLS, seededRng(seed));
      for (const line of SLOT_LINES) {
        const [a, b, c] = line.map(([r, col]) => grid[r][col]);
        if (a === b && b === c) seen.add(a);
      }
    }
    expect(seen.size).toBeGreaterThan(8);
  });

  it('refuses to build a field from too few symbols rather than guessing', () => {
    expect(() => generateGrid('NO_WIN', [1, 2, 3], seededRng(1))).toThrow(/at least/);
  });

  it('works with the smallest workable symbol set', () => {
    for (const type of SLOT_OUTCOME_TYPES) {
      const grid = generateGrid(type, [1, 2, 3, 4, 5], seededRng(7));
      expect(classifyGrid(grid)).toBe(type);
    }
  });
});

describe('weighted selection of the outcome type', () => {
  const weights = [
    weight('NO_WIN', 60),
    weight('TWO_SPLIT', 20, 1.4),
    weight('TWO_ADJACENT', 10, 1.8),
    weight('THREE_LINE', 7, 3),
    weight('THREE_ANYWHERE', 3, 5),
  ];

  it('gives every category exactly its configured share across the range', () => {
    const counts = new Map<string, number>();
    for (let ticket = 0; ticket < 100; ticket += 1) {
      const picked = pickOutcomeType(weights, 100, () => ticket);
      counts.set(picked.type, (counts.get(picked.type) || 0) + 1);
    }
    expect(counts.get('NO_WIN')).toBe(60);
    expect(counts.get('TWO_SPLIT')).toBe(20);
    expect(counts.get('TWO_ADJACENT')).toBe(10);
    expect(counts.get('THREE_LINE')).toBe(7);
    expect(counts.get('THREE_ANYWHERE')).toBe(3);
  });

  it('maps the boundary tickets to the right category', () => {
    expect(pickOutcomeType(weights, 100, () => 0).type).toBe('NO_WIN');
    expect(pickOutcomeType(weights, 100, () => 59).type).toBe('NO_WIN');
    expect(pickOutcomeType(weights, 100, () => 60).type).toBe('TWO_SPLIT');
    expect(pickOutcomeType(weights, 100, () => 79).type).toBe('TWO_SPLIT');
    expect(pickOutcomeType(weights, 100, () => 80).type).toBe('TWO_ADJACENT');
    expect(pickOutcomeType(weights, 100, () => 97).type).toBe('THREE_ANYWHERE');
    expect(pickOutcomeType(weights, 100, () => 99).type).toBe('THREE_ANYWHERE');
  });

  it('carries the payout for the category it drew', () => {
    expect(pickOutcomeType(weights, 100, () => 0).payoutMultiplier).toBe(0);
    expect(pickOutcomeType(weights, 100, () => 60).payoutMultiplier).toBe(1.4);
    expect(pickOutcomeType(weights, 100, () => 80).payoutMultiplier).toBe(1.8);
  });

  it('never draws a category with no chance assigned', () => {
    const noSplit = [weight('NO_WIN', 50), weight('TWO_SPLIT', 0, 9), weight('TWO_ADJACENT', 50, 2)];
    for (let ticket = 0; ticket < 100; ticket += 1) {
      expect(pickOutcomeType(noSplit, 100, () => ticket).type).not.toBe('TWO_SPLIT');
    }
  });

  it('refuses an invalid distribution rather than guessing', () => {
    expect(() => pickOutcomeType(weights, 97, () => 0)).toThrow(/do not match/);
    expect(() => pickOutcomeType([], 100, () => 0)).toThrow(/no weighted outcome types/);
    expect(() => pickOutcomeType(weights, 100, () => 100)).toThrow(/out of range/);
    expect(() => pickOutcomeType(weights, 100, () => -1)).toThrow(/out of range/);
  });

  // Two-step, end to end: the drawn category is the category the field shows.
  it('produces fields matching the drawn category in the configured proportions', () => {
    const counts = new Map<SlotOutcomeType, number>();
    for (let ticket = 0; ticket < 100; ticket += 1) {
      const picked = pickOutcomeType(weights, 100, () => ticket);
      const grid = generateGrid(picked.type, SYMBOLS, seededRng(ticket + 1));
      const shown = classifyGrid(grid);
      expect(shown).toBe(picked.type);
      counts.set(shown, (counts.get(shown) || 0) + 1);
    }
    expect(counts.get('NO_WIN')).toBe(60);
    expect(counts.get('THREE_ANYWHERE')).toBe(3);
  });
});

describe('slotmachine percentages and payouts', () => {
  it('derives percentage as chances over total', () => {
    expect(outcomePercentage(60, 100)).toBe(60);
    expect(outcomePercentage(7, 100)).toBe(7);
    // A different denominator moves every percentage, which is the whole point of the
    // Admin setting the total rather than it being fixed at 100.
    expect(outcomePercentage(1, 50)).toBe(2);
  });

  it('never divides by a zero or missing total', () => {
    expect(outcomePercentage(5, 0)).toBe(0);
  });

  it('pays the multiplier over the stake for one spin, not the series total', () => {
    expect(slotPayout(5, 1.4)).toBe(7);
    expect(slotPayout(5, 1.8)).toBe(9);
    expect(slotPayout(5, 3)).toBe(15);
    expect(slotPayout(5, 5)).toBe(25);
    expect(slotPayout(5, 0)).toBe(0);
  });

  it('totals a series as stake per spin times spins', () => {
    expect(seriesTotalStake(5, 10)).toBe(50);
  });
});

describe('slotmachine configuration validity', () => {
  const valid = () => [
    weight('NO_WIN', 60),
    weight('TWO_SPLIT', 20, 1.4),
    weight('TWO_ADJACENT', 10, 1.8),
    weight('THREE_LINE', 7, 3),
    weight('THREE_ANYWHERE', 3, 5),
  ];

  it('accepts chances that sum to exactly the total with every symbol uploaded', () => {
    const status = evaluateSlotConfig(100, valid(), allSymbols());
    expect(status.valid).toBe(true);
    expect(status.allocatedWeight).toBe(100);
    expect(status.remainingWeight).toBe(0);
  });

  it('rejects chances short of the total', () => {
    const status = evaluateSlotConfig(100, [weight('NO_WIN', 97)], allSymbols());
    expect(status.valid).toBe(false);
    expect(status.remainingWeight).toBe(3);
    expect(status.reason).toContain('not complete');
  });

  it('rejects chances that exceed the total', () => {
    const status = evaluateSlotConfig(100, [weight('NO_WIN', 103)], allSymbols());
    expect(status.valid).toBe(false);
    expect(status.reason).toContain('exceeds');
  });

  it('rejects a total of zero', () => {
    expect(evaluateSlotConfig(0, [], allSymbols()).valid).toBe(false);
  });

  // The generator draws freely from the whole set, so a missing picture is a spin that
  // cannot be drawn.
  it('requires all twelve symbols, because any of them can fill any pattern', () => {
    const eleven = allSymbols();
    eleven.delete(12);
    const status = evaluateSlotConfig(100, valid(), eleven);
    expect(status.valid).toBe(false);
    expect(status.reason).toContain('remaining 1 symbol');
  });

  it('accepts a machine that never pays, as long as the chances add up', () => {
    // All chance on no-win is a legitimate, if mean, configuration.
    expect(evaluateSlotConfig(100, [weight('NO_WIN', 100)], allSymbols()).valid).toBe(true);
  });

  it('reaches the same verdict from counts alone as from the full configuration', () => {
    const full = evaluateSlotConfig(100, valid(), allSymbols());
    const fromCounts = describeSlotConfig({ totalWeight: 100, allocatedWeight: 100, symbolCount: SLOT_SYMBOL_COUNT });
    expect(fromCounts.valid).toBe(full.valid);
    expect(fromCounts.reason).toBe(full.reason);

    const shortFull = evaluateSlotConfig(100, [weight('NO_WIN', 40)], allSymbols());
    const shortCounts = describeSlotConfig({ totalWeight: 100, allocatedWeight: 40, symbolCount: SLOT_SYMBOL_COUNT });
    expect(shortCounts.valid).toBe(shortFull.valid);
    expect(shortCounts.reason).toBe(shortFull.reason);
  });
});

describe('slotmachine symbol vocabulary', () => {
  it('names the twelve positions A to L', () => {
    expect(symbolLetter(1)).toBe('A');
    expect(symbolLetter(12)).toBe('L');
    expect(symbolLetter(0)).toBe('?');
    expect(symbolLetter(13)).toBe('?');
  });

  it('needs one shared set of twelve symbols', () => {
    expect(SLOT_SYMBOL_COUNT).toBe(12);
  });

  it('reads a field as three rows of letters', () => {
    expect(gridLabel([[1, 2, 3], [4, 4, 5], [6, 7, 8]])).toBe('ABC/DDE/FGH');
  });
});

describe('slotmachine series limits', () => {
  it('caps spins by the block maximum and by what the wallet covers', () => {
    expect(maxLockableSpins(5, 40, 20)).toBe(8);
    expect(maxLockableSpins(5, 200, 20)).toBe(20);
  });

  it('returns zero when the wallet cannot cover a single spin', () => {
    expect(maxLockableSpins(5, 4, 20)).toBe(0);
    expect(maxLockableSpins(0, 100, 20)).toBe(0);
  });
});

describe('who may play a slotmachine round', () => {
  // No rows in the allowlist means everyone plays, which is the usual case — the
  // endpoints must never read an empty list as "nobody".
  it('treats an empty allowlist as everyone rather than nobody', () => {
    expect(playerMayPlaySlot({ maxSpins: 10, allowedPlayerIds: [] }, 7)).toBe(true);
  });

  it('restricts play to the listed players when the Admin selected some', () => {
    const restricted = { maxSpins: 10, allowedPlayerIds: [1, 2] };
    expect(playerMayPlaySlot(restricted, 1)).toBe(true);
    expect(playerMayPlaySlot(restricted, 3)).toBe(false);
  });

  // A player buys their whole run up front and then everyone waits through it, so eight
  // is a product rule rather than a database limit. The same number is the ceiling on
  // `slotmachine_rounds.max_spins`, so a round cannot be authored past it either.
  it('caps a run at eight spins', () => {
    expect(SLOT_MAX_SPINS_LIMIT).toBe(8);
  });

  it('never offers more than the cap, whatever the round or the wallet allows', () => {
    // A rich player on a round authored for the maximum still cannot buy a ninth.
    expect(maxLockableSpins(1, 1_000_000, SLOT_MAX_SPINS_LIMIT)).toBe(SLOT_MAX_SPINS_LIMIT);
    // And the wallet still binds below it.
    expect(maxLockableSpins(10, 35, SLOT_MAX_SPINS_LIMIT)).toBe(3);
  });
});;

describe('taking turns', () => {
  /** Series arrive in lock order, which is the turn order. */
  const series = (seriesId: number, playerId: number, totalSpins: number, spinsRemaining: number, status = 'ACTIVE'): SlotSeriesTurn =>
    ({ seriesId, playerId, playerName: `P${playerId}`, stakePerSpin: 10, totalSpins, spinsRemaining, status });

  // The worked example from the brief: Daan 6, Bas 4, Twan 8, locked in that order.
  const daan = (left: number) => series(1, 11, 6, left);
  const bas = (left: number) => series(2, 22, 4, left);
  const twan = (left: number) => series(3, 33, 8, left);

  it('gives the turn to whoever locked first', () => {
    const turn = resolveSlotTurn([daan(6), bas(4), twan(8)]);
    expect(turn.current?.playerId).toBe(11);
    expect(turn.next?.playerId).toBe(22);
    expect(turn.spinning).toBe(false);
  });

  // The headline rule: one player finishes their whole run before the next starts.
  it('keeps the same player for their entire run', () => {
    for (const left of [6, 5, 4, 3, 2, 1]) {
      const turn = resolveSlotTurn([daan(left), bas(4), twan(8)]);
      expect(turn.current?.playerId, `${left} spins left`).toBe(11);
    }
  });

  it('hands over only once the run is used up', () => {
    const turn = resolveSlotTurn([series(1, 11, 6, 0, 'COMPLETED'), bas(4), twan(8)]);
    expect(turn.current?.playerId).toBe(22);
    expect(turn.next?.playerId).toBe(33);
    expect(turn.finished.map(f => f.playerId)).toEqual([11]);
  });

  it('walks the whole running order to the end', () => {
    const afterTwo = resolveSlotTurn([
      series(1, 11, 6, 0, 'COMPLETED'),
      series(2, 22, 4, 0, 'COMPLETED'),
      twan(8),
    ]);
    expect(afterTwo.current?.playerId).toBe(33);
    expect(afterTwo.next).toBeNull();

    const allDone = resolveSlotTurn([
      series(1, 11, 6, 0, 'COMPLETED'),
      series(2, 22, 4, 0, 'COMPLETED'),
      series(3, 33, 8, 0, 'COMPLETED'),
    ]);
    expect(allDone.current).toBeNull();
    expect(allDone.finished).toHaveLength(3);
  });

  // Otherwise the projector would cut away from the last result of a run.
  it('holds the turn on the player whose spin is still resolving', () => {
    const turn = resolveSlotTurn([series(1, 11, 6, 0, 'COMPLETED'), bas(4)], 11);
    expect(turn.current?.playerId).toBe(11);
    expect(turn.spinning).toBe(true);
    // Bas is up next, but not yet.
    expect(turn.next?.playerId).toBe(22);
  });

  it('moves on as soon as that spin has resolved', () => {
    const turn = resolveSlotTurn([series(1, 11, 6, 0, 'COMPLETED'), bas(4)], null);
    expect(turn.current?.playerId).toBe(22);
    expect(turn.spinning).toBe(false);
  });

  it('ignores a cancelled series entirely', () => {
    const turn = resolveSlotTurn([series(1, 11, 6, 4, 'CANCELLED'), bas(4)]);
    expect(turn.current?.playerId).toBe(22);
    expect(turn.finished).toHaveLength(0);
  });

  it('reports nobody up when no series exist', () => {
    const turn = resolveSlotTurn([]);
    expect(turn.current).toBeNull();
    expect(turn.next).toBeNull();
    expect(turn.queue).toHaveLength(0);
  });

  it('handles a single player without stalling', () => {
    expect(resolveSlotTurn([daan(3)]).current?.playerId).toBe(11);
    expect(resolveSlotTurn([daan(3)]).next).toBeNull();
  });

  describe('who may spin', () => {
    const three = [daan(6), bas(4), twan(8)];

    it('lets only the player whose turn it is spin', () => {
      const turn = resolveSlotTurn(three);
      expect(maySpin(turn, 11)).toBe(true);
      expect(maySpin(turn, 22)).toBe(false);
      expect(maySpin(turn, 33)).toBe(false);
    });

    // The anti-spam rule: no second spin until the first has an outcome.
    it('refuses everyone, including the active player, while a spin is resolving', () => {
      const turn = resolveSlotTurn(three, 11);
      expect(turn.spinning).toBe(true);
      expect(maySpin(turn, 11)).toBe(false);
      expect(maySpin(turn, 22)).toBe(false);
    });

    it('lets the active player spin again once the previous one landed', () => {
      expect(maySpin(resolveSlotTurn([daan(5), bas(4)], null), 11)).toBe(true);
    });

    it('refuses a player with no spins left', () => {
      const turn = resolveSlotTurn([series(1, 11, 6, 0, 'COMPLETED'), bas(4)]);
      expect(maySpin(turn, 11)).toBe(false);
      expect(maySpin(turn, 22)).toBe(true);
    });

    it('refuses everyone when every run is done', () => {
      const turn = resolveSlotTurn([series(1, 11, 6, 0, 'COMPLETED')]);
      expect(maySpin(turn, 11)).toBe(false);
    });
  });
});
