import { describe, expect, it } from 'vitest';
import {
  SLOT_COMBINATION_COUNT,
  pickWeightedOutcome,
  requireUsableSlotConfiguration,
  slotConfigurationStatus,
  slotLockedValue,
  slotOutcomeLabel,
  slotOutcomePercentage,
  slotPayoutAmount,
} from '../netlify/lib/slot';

const complete = { totalPool: 100, assignedWeight: 100, symbolCount: 36 };
const table = [
  { reel1: 1, reel2: 1, reel3: 1, weight: 1 },
  { reel1: 1, reel2: 1, reel3: 2, weight: 4 },
  { reel1: 1, reel2: 1, reel3: 3, weight: 20 },
  { reel1: 1, reel2: 1, reel3: 4, weight: 75 },
];

describe('slot combination space', () => {
  it('labels a combination by reel position', () => {
    expect(slotOutcomeLabel(1, 1, 2)).toBe('AAB');
    expect(slotOutcomeLabel(12, 3, 1)).toBe('LCA');
  });

  it('covers exactly 12 x 12 x 12 combinations', () => expect(SLOT_COMBINATION_COUNT).toBe(1728));
});

describe('probability validation', () => {
  it('accepts a distribution that matches the total exactly', () => {
    const status = slotConfigurationStatus(complete);
    expect(status.state).toBe('VALID');
    expect(status.valid).toBe(true);
  });

  it('rejects an incomplete distribution', () => {
    const status = slotConfigurationStatus({ ...complete, assignedWeight: 97 });
    expect(status.state).toBe('INCOMPLETE');
    expect(status.remainingWeight).toBe(3);
    expect(() => requireUsableSlotConfiguration(status)).toThrow();
  });

  it('rejects a distribution that exceeds the total', () => {
    const status = slotConfigurationStatus({ ...complete, assignedWeight: 103 });
    expect(status.state).toBe('EXCEEDS');
    expect(() => requireUsableSlotConfiguration(status)).toThrow();
  });

  it('blocks play until all 36 reel symbols exist', () => {
    const status = slotConfigurationStatus({ ...complete, symbolCount: 35 });
    expect(status.state).toBe('MISSING_SYMBOLS');
    expect(status.missingSymbols).toBe(1);
    expect(() => requireUsableSlotConfiguration(status)).toThrow();
  });

  it('derives the percentage as chances / total x 100', () => {
    expect(slotOutcomePercentage(1, 100)).toBe(1);
    expect(slotOutcomePercentage(4, 100)).toBe(4);
    expect(slotOutcomePercentage(3, 200)).toBe(1.5);
    expect(slotOutcomePercentage(5, 0)).toBe(0);
  });
});

describe('weighted randomizer', () => {
  it('selects the whole outcome from the weighted table, never per reel', () => {
    expect(slotOutcomeLabel(...boundary(0))).toBe('AAA');
    expect(slotOutcomeLabel(...boundary(1))).toBe('AAB');
    expect(slotOutcomeLabel(...boundary(4))).toBe('AAB');
    expect(slotOutcomeLabel(...boundary(5))).toBe('AAC');
    expect(slotOutcomeLabel(...boundary(24))).toBe('AAC');
    expect(slotOutcomeLabel(...boundary(25))).toBe('AAD');
    expect(slotOutcomeLabel(...boundary(99))).toBe('AAD');
  });

  it('reproduces the configured frequency across the whole pool', () => {
    const counts = new Map<string, number>();
    for (let roll = 0; roll < 100; roll += 1) {
      const label = slotOutcomeLabel(...boundary(roll));
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    expect(counts.get('AAA')).toBe(1);
    expect(counts.get('AAB')).toBe(4);
    expect(counts.get('AAC')).toBe(20);
    expect(counts.get('AAD')).toBe(75);
  });

  it('refuses a roll outside the configured pool', () => {
    expect(() => pickWeightedOutcome(table, 100, 100)).toThrow();
    expect(() => pickWeightedOutcome(table, 100, -1)).toThrow();
  });

  it('refuses a table that does not cover the pool', () => {
    expect(() => pickWeightedOutcome(table.slice(0, 1), 100, 50)).toThrow();
  });
});

describe('slot payouts', () => {
  it('multiplies the stake of that single spin', () => {
    expect(slotPayoutAmount(5, 5)).toBe(25);
    expect(slotPayoutAmount(5, 3)).toBe(15);
    expect(slotPayoutAmount(5, 2)).toBe(10);
    expect(slotPayoutAmount(5, 0)).toBe(0);
    expect(slotPayoutAmount(5, 1.5)).toBe(8);
  });

  it('treats unspun spins as locked value', () => {
    expect(slotLockedValue(10, 5)).toBe(50);
    expect(slotLockedValue(0, 5)).toBe(0);
  });
});

function boundary(roll: number): [number, number, number] {
  const outcome = pickWeightedOutcome(table, 100, roll);
  return [outcome.reel1, outcome.reel2, outcome.reel3];
}
