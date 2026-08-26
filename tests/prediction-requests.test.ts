import { describe, expect, it } from 'vitest';
import {
  MAX_REQUESTS_PER_PLAYER,
  REQUEST_COOLDOWN_MS,
  assertCanSubmit,
  cooldownMinutesLeft,
  cooldownRemainingMs,
  decisionValue,
  describeRequestStatus,
  normalizeQuestion,
  reasonForDecision,
  requestsRemaining,
} from '../netlify/lib/prediction-requests';

const NOW = new Date('2026-08-26T20:00:00Z').getTime();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe('prediction request limits', () => {
  it('gives each player two requests', () => {
    expect(MAX_REQUESTS_PER_PLAYER).toBe(2);
    expect(requestsRemaining(0)).toBe(2);
    expect(requestsRemaining(1)).toBe(1);
    expect(requestsRemaining(2)).toBe(0);
    expect(requestsRemaining(5)).toBe(0);
  });

  it('holds a submission for an hour', () => {
    expect(cooldownRemainingMs(minutesAgo(0), NOW)).toBe(REQUEST_COOLDOWN_MS);
    expect(cooldownRemainingMs(minutesAgo(59), NOW)).toBe(60_000);
    expect(cooldownRemainingMs(minutesAgo(60), NOW)).toBe(0);
    expect(cooldownRemainingMs(minutesAgo(600), NOW)).toBe(0);
  });

  it('has no cooldown for a player who has never submitted', () => {
    expect(cooldownRemainingMs(null, NOW)).toBe(0);
    expect(cooldownMinutesLeft(null, NOW)).toBe(0);
  });

  it('rounds the remaining wait up, so it never says 0 min while still blocked', () => {
    expect(cooldownMinutesLeft(minutesAgo(59.5), NOW)).toBe(1);
    expect(cooldownMinutesLeft(minutesAgo(30), NOW)).toBe(30);
  });

  it('ignores an unparseable timestamp rather than blocking forever', () => {
    expect(cooldownRemainingMs('not a date', NOW)).toBe(0);
  });

  describe('assertCanSubmit', () => {
    it('allows a first request', () => {
      expect(() => assertCanSubmit(0, null, NOW)).not.toThrow();
    });

    it('allows a second request once the hour has passed', () => {
      expect(() => assertCanSubmit(1, minutesAgo(61), NOW)).not.toThrow();
    });

    it('refuses a third request even after the cooldown', () => {
      expect(() => assertCanSubmit(2, minutesAgo(600), NOW)).toThrow(/already used all 2/);
    });

    it('refuses while on cooldown, and says how long is left', () => {
      expect(() => assertCanSubmit(1, minutesAgo(45), NOW)).toThrow(/another prediction in 15 min/);
    });

    it('reports the cap rather than the cooldown when both apply', () => {
      expect(() => assertCanSubmit(2, minutesAgo(1), NOW)).toThrow(/already used all 2/);
    });
  });
});

describe('prediction request review', () => {
  it('only accepts a real decision', () => {
    expect(decisionValue('APPROVED')).toBe('APPROVED');
    expect(decisionValue('DENIED')).toBe('DENIED');
    expect(() => decisionValue('MAYBE')).toThrow(/APPROVED or DENIED/);
    expect(() => decisionValue(undefined)).toThrow();
  });

  it('requires a reason to deny, because the player is shown it', () => {
    expect(() => reasonForDecision('DENIED', '')).toThrow(/reason is required/);
    expect(() => reasonForDecision('DENIED', '   ')).toThrow(/reason is required/);
    expect(reasonForDecision('DENIED', '  too vague  ')).toBe('too vague');
  });

  it('does not attach a reason to an approval', () => {
    expect(reasonForDecision('APPROVED', 'ignored')).toBe('');
  });

  it('tells the player what happened, including why it was denied', () => {
    expect(describeRequestStatus('PENDING', '')).toBe('In review');
    expect(describeRequestStatus('APPROVED', '')).toBe('Approved · waiting for prediction to go live');
    expect(describeRequestStatus('DENIED', 'too vague')).toBe('Denied · too vague');
  });
});

describe('question validation', () => {
  it('trims and keeps the question', () => {
    expect(normalizeQuestion('  Wint Team Blauw?  ')).toBe('Wint Team Blauw?');
  });

  it('rejects blank and non-string input', () => {
    expect(() => normalizeQuestion('   ')).toThrow(/Write a question/);
    expect(() => normalizeQuestion('')).toThrow(/Write a question/);
    expect(() => normalizeQuestion(null)).toThrow(/must be a string/);
    expect(() => normalizeQuestion(42)).toThrow(/must be a string/);
  });

  it('rejects a question longer than the column allows', () => {
    expect(() => normalizeQuestion('x'.repeat(301))).toThrow(/under 300 characters/);
    expect(normalizeQuestion('x'.repeat(300))).toHaveLength(300);
  });
});
