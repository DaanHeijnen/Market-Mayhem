import { describe, expect, it } from 'vitest';
import {
  canTransition,
  ledgerBalance,
  maxPredictionStake,
  payoutForStake,
  predictionSettlementCredit,
  probabilityToMultipliers,
  publicPredictionStatus,
} from '../netlify/lib/economy';

describe('prediction economy', () => {
  it('derives canonical multipliers from probability', () => {
    expect(probabilityToMultipliers(0.2)).toEqual({ yes: 5, no: 1.25 });
    expect(probabilityToMultipliers(0.4)).toEqual({ yes: 2.5, no: 1.667 });
    expect(() => probabilityToMultipliers(0)).toThrow();
    expect(() => probabilityToMultipliers(1)).toThrow();
  });

  it('uses the accepted multiplier snapshot for payout math', () => {
    expect(payoutForStake(20, 2.7)).toBe(54);
    expect(predictionSettlementCredit(20, 2.5, true)).toBe(50);
    expect(predictionSettlementCredit(20, 2.5, false)).toBe(0);
  });

  it('keeps a deposit in total player value until settlement', () => {
    const availableAfterDeposit = ledgerBalance([100, -20]);
    const lockedDeposit = 20;
    expect(availableAfterDeposit).toBe(80);
    expect(availableAfterDeposit + lockedDeposit).toBe(100);
    expect(ledgerBalance([100, -20, 50])).toBe(130);
  });

  it('abstention creates no wallet movement', () => expect(ledgerBalance([100])).toBe(100));

  it('caps deposit by available balance, market max and wallet percentage', () => {
    expect(maxPredictionStake(200, 5, 500, 25)).toBe(50);
    expect(maxPredictionStake(4, 5, 500, null)).toBe(0);
  });

  it('maps internal states to the requested public lifecycle', () => {
    expect(publicPredictionStatus('OPEN')).toBe('OPEN');
    expect(publicPredictionStatus('SETTLED', 'YES')).toBe('RESOLVED_YES');
    expect(publicPredictionStatus('RESULT', 'NO')).toBe('RESOLVED_NO');
    expect(publicPredictionStatus('CANCELLED', 'CANCEL')).toBe('CANCELLED');
  });

  it('uses the internal scheduling state machine without crowd-voting phases', () => {
    expect(canTransition('DRAFT', 'SCHEDULED')).toBe(true);
    expect(canTransition('SCHEDULED', 'OPEN')).toBe(true);
    expect(canTransition('OPEN', 'LOCKED')).toBe(true);
    expect(canTransition('LOCKED', 'RESULT')).toBe(true);
    expect(canTransition('RESULT', 'SETTLED')).toBe(true);
    expect(canTransition('RESULT', 'CANCELLED')).toBe(false);
    expect(canTransition('SETTLED', 'OPEN')).toBe(false);
  });
});
