import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isSameManualAdjustment,
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

describe('replaying a manual coin adjustment', () => {
  const existing = {
    transaction_type: 'MANUAL_ADJUSTMENT',
    player_id: '7',
    amount: '150',
    description: 'Bonus for the quiz',
    attributed_round_id: '3',
  };
  const intent = { playerId: 7, requestedAmount: 150, reason: 'Bonus for the quiz', roundId: 3 };

  it('recognises the same movement sent twice', () => {
    expect(isSameManualAdjustment(existing, intent)).toBe(true);
  });

  it('refuses a key reused for a different player, reason, round or amount', () => {
    expect(isSameManualAdjustment(existing, { ...intent, playerId: 8 })).toBe(false);
    expect(isSameManualAdjustment(existing, { ...intent, reason: 'Something else' })).toBe(false);
    expect(isSameManualAdjustment(existing, { ...intent, roundId: null })).toBe(false);
    expect(isSameManualAdjustment(existing, { ...intent, requestedAmount: 149 })).toBe(false);
  });

  it('refuses an entry that is not a manual adjustment at all', () => {
    expect(isSameManualAdjustment({ ...existing, transaction_type: 'BET_PAYOUT' }, intent)).toBe(false);
  });

  // The case the two modes exist for: "set it to 250" moved 150 the first time and would
  // move 0 the second, so the amount cannot be what identifies the request.
  it('recognises a replayed destination whatever movement it worked out to', () => {
    expect(isSameManualAdjustment(existing, { ...intent, requestedAmount: null })).toBe(true);
  });

  it('still compares everything else when the caller named a destination', () => {
    expect(isSameManualAdjustment(existing, { ...intent, requestedAmount: null, reason: 'Other' })).toBe(false);
  });
});
