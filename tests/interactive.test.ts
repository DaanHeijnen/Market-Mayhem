import { describe, expect, it } from 'vitest';
import { QUESTION_EMOJIS } from '../netlify/lib/economy';

// Database uniqueness/idempotency for answers/rewards is exercised by the E2E flow.
describe('live Duolingo question contract', () => {
  it('uses the fixed four player emoji controls in order', () => {
    expect(QUESTION_EMOJIS).toEqual(['🍆', '🌽', '🍑', '😳']);
  });
});
