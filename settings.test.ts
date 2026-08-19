import { describe, expect, it } from 'vitest';
import { GAME_RESET_PHRASE, predictionCloseTime, requireGameResetPhrase } from '../netlify/lib/settings';

describe('settings and market timing rules', () => {
  it('calculates close time from the prediction-owned duration', () => {
    expect(predictionCloseTime(1_000, 5)).toBe(6_000);
    expect(predictionCloseTime(1_000, 90)).toBe(91_000);
  });

  it('only accepts the exact destructive reset phrase', () => {
    expect(requireGameResetPhrase(GAME_RESET_PHRASE)).toBe(true);
    expect(() => requireGameResetPhrase('YES DELETE')).toThrow();
    expect(() => requireGameResetPhrase('yes delete ')).toThrow();
  });
});
