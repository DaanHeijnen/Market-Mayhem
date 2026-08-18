export function payoutForStake(stake: number, odds: number) {
  return Math.round(stake * odds);
}

export function predictionSettlementCredit(stake: number, odds: number, won: boolean) {
  return won ? payoutForStake(stake, odds) : 0;
}

export function ledgerBalance(amounts: number[]) {
  return amounts.reduce((sum, amount) => sum + amount, 0);
}

export type PredictionStatus = 'DRAFT'|'SCHEDULED'|'OPEN'|'LOCKED'|'RESULT'|'SETTLED'|'CANCELLED';

const allowedTransitions: Record<PredictionStatus, PredictionStatus[]> = {
  DRAFT: ['SCHEDULED','OPEN','CANCELLED'],
  SCHEDULED: ['DRAFT','OPEN','CANCELLED'],
  OPEN: ['LOCKED','CANCELLED'],
  LOCKED: ['RESULT','CANCELLED'],
  RESULT: ['SETTLED','CANCELLED'],
  SETTLED: [],
  CANCELLED: [],
};

export function canTransition(from: PredictionStatus, to: PredictionStatus) {
  return allowedTransitions[from].includes(to);
}

export function maxPredictionStake(balance: number, minimumStake: number, maximumStake: number, walletPercentage: number | null) {
  const percentageCap = walletPercentage == null ? balance : Math.floor(balance * walletPercentage / 100);
  const cap = Math.min(balance, maximumStake, percentageCap);
  return cap >= minimumStake ? cap : 0;
}

export type RouletteBetType = 'NUMBER'|'COLOR'|'PARITY'|'RANGE';
export const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

export function normalizeRouletteSelection(type: RouletteBetType, raw: unknown) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (type === 'NUMBER') {
    if (!/^\d{1,2}$/.test(value)) throw new Error('Number must be between 0 and 36');
    const n = Number(value);
    if (n < 0 || n > 36) throw new Error('Number must be between 0 and 36');
    return String(n);
  }
  if (type === 'COLOR' && ['RED','BLACK'].includes(value)) return value;
  if (type === 'PARITY' && ['ODD','EVEN'].includes(value)) return value;
  if (type === 'RANGE' && ['LOW','HIGH'].includes(value)) return value;
  throw new Error('Invalid roulette selection');
}

export function roulettePayoutMultiplier(type: RouletteBetType) {
  return type === 'NUMBER' ? 36 : 2;
}

export function rouletteBetWins(type: RouletteBetType, selection: string, result: number) {
  if (type === 'NUMBER') return Number(selection) === result;
  if (result === 0) return false;
  if (type === 'COLOR') return selection === (RED_NUMBERS.has(result) ? 'RED' : 'BLACK');
  if (type === 'PARITY') return selection === (result % 2 ? 'ODD' : 'EVEN');
  if (type === 'RANGE') return selection === (result <= 18 ? 'LOW' : 'HIGH');
  return false;
}
