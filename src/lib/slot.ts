// Client-side mirror of the slot presentation constants. All financial and
// probability decisions stay on the server; this file only shapes the UI.

export const SLOT_REELS = [1, 2, 3] as const;
export const SLOT_SYMBOLS_PER_REEL = 12;
export const SLOT_COMBINATION_COUNT = SLOT_SYMBOLS_PER_REEL ** 3; // 1728
export const SLOT_SYMBOL_SLOT_COUNT = SLOT_REELS.length * SLOT_SYMBOLS_PER_REEL; // 36
export const SLOT_SYMBOL_LETTERS = 'ABCDEFGHIJKL';
export const SLOT_SPIN_MS = 4000;

export type SlotReel = typeof SLOT_REELS[number];

export const slotPositions = Array.from({ length: SLOT_SYMBOLS_PER_REEL }, (_, i) => i + 1);

export function slotSymbolLetter(position: number) {
  return SLOT_SYMBOL_LETTERS[position - 1] || '?';
}

export function slotOutcomeLabel(reel1: number, reel2: number, reel3: number) {
  return `${slotSymbolLetter(reel1)}${slotSymbolLetter(reel2)}${slotSymbolLetter(reel3)}`;
}

export function slotOutcomeKey(reel1: number, reel2: number, reel3: number) {
  return `${reel1}-${reel2}-${reel3}`;
}

export function slotOutcomePercentage(weight: number, totalPool: number) {
  if (!Number.isFinite(totalPool) || totalPool <= 0) return 0;
  return (weight / totalPool) * 100;
}

export function formatSlotPercentage(weight: number, totalPool: number) {
  const percentage = slotOutcomePercentage(weight, totalPool);
  if (percentage === 0) return '0%';
  return `${percentage < 0.01 ? percentage.toFixed(4) : percentage.toFixed(2).replace(/\.00$/, '')}%`;
}

/** URL of a stored reel symbol. The checksum keeps the browser cache honest. */
export function slotSymbolUrl(gameId: number, reel: number, position: number, checksum?: string | null) {
  const version = checksum ? `&v=${encodeURIComponent(checksum)}` : '';
  return `/api/slot-symbol?gameId=${gameId}&reel=${reel}&position=${position}${version}`;
}

export type SlotConfigurationState = 'VALID' | 'NO_POOL' | 'INCOMPLETE' | 'EXCEEDS' | 'MISSING_SYMBOLS';

/**
 * Mirrors the server rule in netlify/lib/slot.ts so Settings can show the
 * verdict while typing. The server stays the authority at spin time.
 */
export function slotConfigurationSummary(totalPool: number, assignedWeight: number, symbolCount: number) {
  const missingSymbols = Math.max(0, SLOT_SYMBOL_SLOT_COUNT - symbolCount);
  const remaining = totalPool - assignedWeight;
  if (missingSymbols > 0) {
    return { state: 'MISSING_SYMBOLS' as SlotConfigurationState, valid: false, tone: 'warning' as const, remaining, headline: 'REEL SYMBOLS MISSING', message: `${missingSymbols} of ${SLOT_SYMBOL_SLOT_COUNT} reel symbols are still missing.` };
  }
  if (totalPool < 1) {
    return { state: 'NO_POOL' as SlotConfigurationState, valid: false, tone: 'warning' as const, remaining, headline: 'NO TOTAL SET', message: 'Set a total probability pool of at least 1.' };
  }
  if (assignedWeight < totalPool) {
    return { state: 'INCOMPLETE' as SlotConfigurationState, valid: false, tone: 'warning' as const, remaining, headline: 'CONFIGURATION NOT COMPLETE', message: `${assignedWeight} of ${totalPool} assigned. ${remaining} left to distribute.` };
  }
  if (assignedWeight > totalPool) {
    return { state: 'EXCEEDS' as SlotConfigurationState, valid: false, tone: 'danger' as const, remaining, headline: 'CONFIGURATION EXCEEDS TOTAL', message: `${assignedWeight} of ${totalPool} assigned. Remove ${assignedWeight - totalPool}.` };
  }
  return { state: 'VALID' as SlotConfigurationState, valid: true, tone: 'success' as const, remaining, headline: 'VALID CONFIGURATION', message: `${assignedWeight} of ${totalPool} assigned across every configured outcome.` };
}
