export const MIN_MARKET_PROBABILITY = 0.05;
export const MAX_MARKET_PROBABILITY = 0.95;
export const MIN_BET = 5;
export const MAX_BET = 500;

export function clampProbability(value: number) {
  return Math.min(MAX_MARKET_PROBABILITY, Math.max(MIN_MARKET_PROBABILITY, value));
}

export function arithmeticMeanPercent(values: number[]) {
  if (!values.length) return 50;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function oddsFromProbability(probability: number) {
  const p = clampProbability(probability);
  return Math.round((1 / p) * 1000) / 1000;
}

export function marketFromVotes(votes: number[]) {
  const rawYes = arithmeticMeanPercent(votes) / 100;
  const yesProbability = clampProbability(rawYes);
  const noProbability = clampProbability(1 - yesProbability);
  return {
    yesProbability,
    noProbability,
    yesOdds: oddsFromProbability(yesProbability),
    noOdds: oddsFromProbability(noProbability),
  };
}

export function payoutForStake(stake: number, odds: number) {
  return Math.round(stake * odds);
}

export function ledgerBalance(amounts: number[]) {
  return amounts.reduce((sum, amount) => sum + amount, 0);
}

export type PredictionStatus = 'DRAFT'|'VOTING'|'CALCULATING'|'BETTING'|'LOCKED'|'RESULT'|'SETTLED'|'CANCELLED';

const allowedTransitions: Record<PredictionStatus, PredictionStatus[]> = {
  DRAFT: ['VOTING','CANCELLED'],
  VOTING: ['CALCULATING','CANCELLED'],
  CALCULATING: ['BETTING','CANCELLED'],
  BETTING: ['LOCKED','CANCELLED'],
  LOCKED: ['RESULT','SETTLED','CANCELLED'],
  RESULT: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
};

export function canTransition(from: PredictionStatus, to: PredictionStatus) {
  return allowedTransitions[from].includes(to);
}
