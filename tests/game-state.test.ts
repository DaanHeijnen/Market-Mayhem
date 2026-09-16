import { describe, expect, it } from 'vitest';
import { HttpError } from '../netlify/lib/http';
import { screenModeValue } from '../netlify/lib/game-state';
import { SCREEN_MODES } from '../netlify/lib/round-types';

describe('screen mode validation', () => {
  it('accepts every mode the projector can be in', () => {
    for (const mode of SCREEN_MODES) expect(screenModeValue(mode)).toBe(mode);
  });

  // ROUND_BLOCK belonged to the generic block model and split into the two scenes that
  // can actually present a round. Accepting it again would mean the block model is back.
  it('rejects obsolete and arbitrary modes', () => {
    for (const mode of ['ROUND_BLOCK', 'PREDICTION_VOTING', 'CROWD_REVEAL', 'WHATEVER']) {
      expect(() => screenModeValue(mode), mode).toThrow(HttpError);
    }
  });

  it('has a scene for a quiz question and one for a slide', () => {
    expect(SCREEN_MODES).toContain('QUIZ_QUESTION');
    expect(SCREEN_MODES).toContain('SLIDE');
  });
});
