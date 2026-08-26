import { describe, expect, it } from 'vitest';
import { orderRunOfShow, indexOfStep, nextStep } from '../netlify/lib/run-of-show';

// This ordering has two callers — the Admin strip and the pointer GO LIVE advances.
// If they ever disagreed by one position, going live would skip or repeat a step
// relative to what the host is looking at, mid-show.

const blocks = [
  { id: 33, round_id: 3, type: 'DUOLINGO_QUESTION', title: 'Hoofdstad van Frankrijk?', sort_order: 3 },
  { id: 31, round_id: 3, type: 'TEXT', title: 'Ronde uitleg', sort_order: 1 },
  { id: 34, round_id: 3, type: 'ROULETTE', title: 'Bonusronde', sort_order: 4 },
  { id: 32, round_id: 3, type: 'QUESTION', title: 'Hoeveel hoofdsteden?', sort_order: 2 },
  { id: 99, round_id: 4, type: 'TEXT', title: 'Other round', sort_order: 1 },
];

const predictions = [
  { id: 2, round_id: 3, status: 'SETTLED', question: 'Already resolved', display_number: 2 },
  { id: 1, round_id: 3, status: 'OPEN', question: 'Wint Team Blauw?', display_number: 1 },
  { id: 3, round_id: 3, status: 'CANCELLED', question: 'Cancelled', display_number: 3 },
  { id: 4, round_id: 3, status: 'LOCKED', question: 'Locked market', display_number: 4 },
  { id: 5, round_id: null, status: 'OPEN', question: 'No round', display_number: 5 },
  { id: 6, round_id: 4, status: 'OPEN', question: 'Other round market', display_number: 6 },
];

describe('run of show ordering', () => {
  it('puts content blocks in configured order, then the round\'s unresolved markets', () => {
    const steps = orderRunOfShow(blocks, predictions, 3);
    expect(steps.map(s => `${s.kind}:${s.id}`)).toEqual([
      'block:31', 'block:32', 'block:33', 'block:34',
      'prediction:1', 'prediction:4',
    ]);
  });

  it('excludes other rounds, unattached markets, and resolved markets', () => {
    const steps = orderRunOfShow(blocks, predictions, 3);
    const ids = steps.map(s => s.id);
    expect(ids).not.toContain(99); // block on round 4
    expect(ids).not.toContain(5);  // market with no round
    expect(ids).not.toContain(6);  // market on round 4
    expect(steps.filter(s => s.kind === 'prediction').map(s => s.id)).toEqual([1, 4]); // not 2 SETTLED / 3 CANCELLED
  });

  it('is empty when no round is active, so nothing can be staged from a dead show', () => {
    expect(orderRunOfShow(blocks, predictions, null)).toEqual([]);
  });

  it('falls back to id when sort_order ties', () => {
    const tied = [
      { id: 20, round_id: 1, type: 'TEXT', title: 'b', sort_order: 1 },
      { id: 10, round_id: 1, type: 'TEXT', title: 'a', sort_order: 1 },
    ];
    expect(orderRunOfShow(tied, [], 1).map(s => s.id)).toEqual([10, 20]);
  });

  it('labels a block by its title, or its type when untitled', () => {
    const untitled = [{ id: 1, round_id: 1, type: 'PICTURE', title: '  ', sort_order: 1 }];
    expect(orderRunOfShow(untitled, [], 1)[0].label).toBe('PICTURE');
  });

  describe('advancing', () => {
    const steps = orderRunOfShow(blocks, predictions, 3);

    it('walks blocks then markets in one continuous timeline', () => {
      expect(nextStep(steps, 'block', 31)).toMatchObject({ kind: 'block', id: 32 });
      expect(nextStep(steps, 'block', 34)).toMatchObject({ kind: 'prediction', id: 1 });
      expect(nextStep(steps, 'prediction', 1)).toMatchObject({ kind: 'prediction', id: 4 });
    });

    it('stops at the end rather than wrapping, so the host decides what follows', () => {
      expect(nextStep(steps, 'prediction', 4)).toBeNull();
    });

    it('starts at the beginning when nothing is staged or the staged step is gone', () => {
      expect(nextStep(steps, null, null)).toMatchObject({ kind: 'block', id: 31 });
      expect(nextStep(steps, 'block', 4242)).toMatchObject({ kind: 'block', id: 31 });
    });

    it('reports no position for a step that is not in the timeline', () => {
      expect(indexOfStep(steps, 'block', 4242)).toBe(-1);
      expect(indexOfStep(steps, 'block', 33)).toBe(2);
    });

    it('has nothing to advance to in an empty round', () => {
      expect(nextStep([], 'block', 31)).toBeNull();
    });
  });
});
