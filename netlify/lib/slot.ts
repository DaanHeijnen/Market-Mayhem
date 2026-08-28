import { HttpError } from './http';

export const SLOT_REELS = [1, 2, 3] as const;
export const SLOT_SYMBOLS_PER_REEL = 12;
export const SLOT_COMBINATION_COUNT = SLOT_SYMBOLS_PER_REEL ** 3; // 1728
export const SLOT_SYMBOL_SLOT_COUNT = SLOT_REELS.length * SLOT_SYMBOLS_PER_REEL; // 36
export const SLOT_SYMBOL_LETTERS = 'ABCDEFGHIJKL';
export const SLOT_MAX_SYMBOL_BYTES = 1_048_576;

/** Client presentation time between the SPIN command and the revealed outcome. */
export const SLOT_SPIN_MS = 4000;

export type SlotReel = typeof SLOT_REELS[number];

export interface SlotOutcomeWeight {
  reel1: number;
  reel2: number;
  reel3: number;
  weight: number;
}

export function slotSymbolLetter(position: number) {
  return SLOT_SYMBOL_LETTERS[position - 1] || '?';
}

/** Human label of a combination, e.g. positions 1/1/2 become "AAB". */
export function slotOutcomeLabel(reel1: number, reel2: number, reel3: number) {
  return `${slotSymbolLetter(reel1)}${slotSymbolLetter(reel2)}${slotSymbolLetter(reel3)}`;
}

export function slotReelValue(value: unknown, field: string): SlotReel {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SLOT_REELS.length) {
    throw new HttpError(400, `${field} must be reel 1, 2 or 3`);
  }
  return parsed as SlotReel;
}

export function slotPositionValue(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SLOT_SYMBOLS_PER_REEL) {
    throw new HttpError(400, `${field} must be a position between 1 and ${SLOT_SYMBOLS_PER_REEL}`);
  }
  return parsed;
}

export type SlotConfigurationState = 'VALID' | 'NO_POOL' | 'INCOMPLETE' | 'EXCEEDS' | 'MISSING_SYMBOLS';

export interface SlotConfigurationInput {
  totalPool: number;
  assignedWeight: number;
  symbolCount: number;
}

export interface SlotConfigurationStatus {
  state: SlotConfigurationState;
  valid: boolean;
  message: string;
  totalPool: number;
  assignedWeight: number;
  remainingWeight: number;
  symbolCount: number;
  missingSymbols: number;
}

/**
 * The single source of truth for "may the slot machine be used?". Admin
 * Settings renders this and both player endpoints re-check it server side.
 */
export function slotConfigurationStatus({ totalPool, assignedWeight, symbolCount }: SlotConfigurationInput): SlotConfigurationStatus {
  const missingSymbols = Math.max(0, SLOT_SYMBOL_SLOT_COUNT - symbolCount);
  const remainingWeight = totalPool - assignedWeight;
  const base = { totalPool, assignedWeight, remainingWeight, symbolCount, missingSymbols };

  if (missingSymbols > 0) {
    return { ...base, state: 'MISSING_SYMBOLS', valid: false, message: `${missingSymbols} of ${SLOT_SYMBOL_SLOT_COUNT} reel symbols are still missing` };
  }
  if (totalPool < 1) {
    return { ...base, state: 'NO_POOL', valid: false, message: 'Set a total probability pool of at least 1' };
  }
  if (assignedWeight < totalPool) {
    return { ...base, state: 'INCOMPLETE', valid: false, message: `Configuration is not complete: ${assignedWeight} of ${totalPool} assigned` };
  }
  if (assignedWeight > totalPool) {
    return { ...base, state: 'EXCEEDS', valid: false, message: `Configuration exceeds the total: ${assignedWeight} of ${totalPool} assigned` };
  }
  return { ...base, state: 'VALID', valid: true, message: `Valid configuration: ${assignedWeight} of ${totalPool} assigned` };
}

export function requireUsableSlotConfiguration(status: SlotConfigurationStatus) {
  if (!status.valid) throw new HttpError(409, `Slot machine configuration is not usable. ${status.message}`);
  return status;
}

export function slotOutcomePercentage(weight: number, totalPool: number) {
  if (!Number.isFinite(totalPool) || totalPool <= 0) return 0;
  return (weight / totalPool) * 100;
}

/**
 * Chooses the complete outcome from the configured distribution. The three
 * reels are never rolled independently: `roll` addresses the weighted table and
 * the stored combination decides which symbol each reel shows.
 */
export function pickWeightedOutcome<T extends SlotOutcomeWeight>(outcomes: T[], totalPool: number, roll: number): T {
  if (!Number.isInteger(roll) || roll < 0 || roll >= totalPool) {
    throw new HttpError(500, 'Slot randomizer produced a value outside the probability pool');
  }
  let cursor = 0;
  for (const outcome of outcomes) {
    if (outcome.weight <= 0) continue;
    cursor += outcome.weight;
    if (roll < cursor) return outcome;
  }
  throw new HttpError(409, 'Slot probability configuration does not cover the full pool');
}

export function slotPayoutAmount(stake: number, multiplier: number) {
  const payout = Math.round(stake * multiplier);
  return payout > 0 ? payout : 0;
}

export function slotLockedValue(remainingSpins: number, stakePerSpin: number) {
  return Math.max(0, remainingSpins) * Math.max(0, stakePerSpin);
}
