import { describe, expect, it } from 'vitest';
import { HttpError } from '../netlify/lib/http';
import { screenModeValue } from '../netlify/lib/game-state';

describe('screen mode validation', () => {
  it('accepts supported modes', () => {
    expect(screenModeValue('DASHBOARD')).toBe('DASHBOARD');
    expect(screenModeValue('BETTING_OPEN')).toBe('BETTING_OPEN');
  });

  it('rejects arbitrary modes', () => {
    try {
      screenModeValue('WHATEVER');
      throw new Error('Expected HttpError');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
    }
  });
});
