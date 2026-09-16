import { describe, expect, it } from 'vitest';
import {
  ROUND_TYPES, SCENE_FOR_ROUND_TYPE, SCREEN_MODES,
  isRoundType, isSteppedRound, type RoundType,
} from '../netlify/lib/round-types';
import { ROUND_META, roundMeta, ROUND_TYPES as UI_ROUND_TYPES } from '../src/components/admin/roundMeta';
import { neighbours } from '../netlify/lib/rounds';

describe('the round type vocabulary', () => {
  it('is the seven types the evening is built from', () => {
    expect(ROUND_TYPES).toEqual(['LIVE_QUIZ', 'PRESENTATIE', 'PUBQUIZ', 'ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE']);
  });

  it('refuses anything that is not one of them', () => {
    expect(isRoundType('LIVE_QUIZ')).toBe(true);
    expect(isRoundType('KAHOOT')).toBe(false);
    expect(isRoundType('TEXT')).toBe(false);
    expect(isRoundType(null)).toBe(false);
  });

  // The server owns the CHECK constraint and the UI is what the host reads; the two
  // drifting apart would show a type the database then refuses.
  it('is the same list the Admin console offers', () => {
    expect([...UI_ROUND_TYPES].sort()).toEqual([...ROUND_TYPES].sort());
    for (const type of ROUND_TYPES) {
      expect(ROUND_META[type as keyof typeof ROUND_META], type).toBeDefined();
    }
  });

  // One scene per type, so the projector can never be pointed at a slotmachine round
  // with the quiz scene.
  it('gives every round type exactly one scene, and every scene is a real mode', () => {
    for (const type of ROUND_TYPES) {
      const scene = SCENE_FOR_ROUND_TYPE[type as RoundType];
      expect(scene, type).toBeDefined();
      expect(SCREEN_MODES, type).toContain(scene);
    }
  });

  it('knows which types the host steps through and which are one thing', () => {
    expect(isSteppedRound('LIVE_QUIZ')).toBe(true);
    expect(isSteppedRound('PRESENTATIE')).toBe(true);
    for (const type of ['ROULETTE', 'SLOTMACHINE', 'PAK_EEN_ZES', 'FOTORONDE'] as RoundType[]) {
      expect(isSteppedRound(type), type).toBe(false);
      expect(roundMeta(type).stepped, type).toBe(false);
    }
  });

  it('falls back rather than throwing on a type it does not know', () => {
    expect(roundMeta('NOPE').label).toBe('Round');
  });
});

describe('stepping through a round', () => {
  const items = [{ id: 10 }, { id: 11 }, { id: 12 }];

  it('finds the neighbours of the current item', () => {
    expect(neighbours(items, 11)).toMatchObject({
      index: 1, previous: { id: 10 }, next: { id: 12 }, current: { id: 11 },
    });
  });

  // Never wraps: the host decides what follows the last question, not the list.
  it('has no next past the end and no previous before the start', () => {
    expect(neighbours(items, 12).next).toBeNull();
    expect(neighbours(items, 10).previous).toBeNull();
  });

  it('offers the first item when the cursor points at nothing', () => {
    const around = neighbours(items, null);
    expect(around.index).toBe(-1);
    expect(around.first).toEqual({ id: 10 });
    expect(around.current).toBeNull();
  });

  it('copes with a round that has no content yet', () => {
    expect(neighbours([], null)).toMatchObject({ index: -1, first: null, next: null, previous: null });
  });
});
