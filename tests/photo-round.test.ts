import { describe, expect, it } from 'vitest';
import {
  acceptsAwards,
  acceptsUploads,
  canTransition,
  describeDistribution,
  distributeCredits,
  normalizeSubjects,
  subjectKeyFromLabel,
  DEFAULT_PHOTO_SUBJECTS,
  MAX_PHOTO_SUBJECTS,
  PHOTO_ROUND_STATUSES,
  type PhotoRoundStatus,
} from '../netlify/lib/photo-round';
import { photoRoundInstructions, photoRoundSubjects } from '../netlify/lib/photo-round-state';

describe('photo subjects', () => {
  it('starts with the six standard subjects, in order', () => {
    expect(DEFAULT_PHOTO_SUBJECTS.map(s => s.label)).toEqual([
      'Iets kunstigs',
      'Iets lelijks',
      'Iets moois',
      'Iets opwindends',
      'Iets wat met het geloof heeft te maken',
      'Iets kinderlijks',
    ]);
  });

  it('gives every subject a distinct key', () => {
    const keys = DEFAULT_PHOTO_SUBJECTS.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('derives a readable key from a label', () => {
    expect(subjectKeyFromLabel('Iets moois')).toBe('iets-moois');
    expect(subjectKeyFromLabel('Iets wat met het geloof heeft te maken')).toBe('iets-wat-met-het-geloof-heeft-te-maken');
  });

  // Two subjects may legitimately read alike; a collision must never make one inherit
  // the other's photos.
  it('never reuses a key that is already taken', () => {
    expect(subjectKeyFromLabel('Iets moois', ['iets-moois'])).toBe('iets-moois-2');
    expect(subjectKeyFromLabel('Iets moois', ['iets-moois', 'iets-moois-2'])).toBe('iets-moois-3');
  });

  it('falls back to a usable key for a label with no letters', () => {
    expect(subjectKeyFromLabel('!!!')).toBe('onderwerp');
  });

  it('falls back to the standard six when a block has no subjects', () => {
    expect(normalizeSubjects(undefined)).toEqual(DEFAULT_PHOTO_SUBJECTS);
    expect(normalizeSubjects([])).toEqual(DEFAULT_PHOTO_SUBJECTS);
    expect(normalizeSubjects('nonsense')).toEqual(DEFAULT_PHOTO_SUBJECTS);
    // A list of blanks is no list at all.
    expect(normalizeSubjects([{ label: '  ' }])).toEqual(DEFAULT_PHOTO_SUBJECTS);
  });

  it('accepts an edited list and keys anything unkeyed', () => {
    const subjects = normalizeSubjects([{ label: 'Iets grappigs' }, { label: 'Iets blauws' }]);
    expect(subjects.map(s => s.label)).toEqual(['Iets grappigs', 'Iets blauws']);
    expect(subjects.map(s => s.key)).toEqual(['iets-grappigs', 'iets-blauws']);
  });

  // The key is the identity, so renaming must not detach the photos filed under it.
  it('keeps an existing key when the label is renamed', () => {
    const subjects = normalizeSubjects([{ key: 'moois', label: 'Iets heel moois' }]);
    expect(subjects[0].key).toBe('moois');
    expect(subjects[0].label).toBe('Iets heel moois');
  });

  it('de-duplicates keys that arrive the same', () => {
    const subjects = normalizeSubjects([{ key: 'moois', label: 'A' }, { key: 'moois', label: 'B' }]);
    expect(subjects[0].key).not.toBe(subjects[1].key);
  });

  it('caps the list rather than accepting an unbounded one', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ label: `Onderwerp ${i}` }));
    expect(normalizeSubjects(many)).toHaveLength(MAX_PHOTO_SUBJECTS);
  });

  it('reads the subject list and instructions off a block payload', () => {
    expect(photoRoundSubjects({}).length).toBe(6);
    expect(photoRoundSubjects({ subjects: [{ label: 'Iets rooks' }] })).toHaveLength(1);
    expect(photoRoundInstructions({ body: 'Ga op jacht' })).toBe('Ga op jacht');
    expect(photoRoundInstructions(null)).toBe('');
  });
});

describe('the photo round phases', () => {
  it('has the four phases the flow describes', () => {
    expect(PHOTO_ROUND_STATUSES).toEqual(['DRAFT', 'OPEN', 'CLOSED', 'COMPLETED']);
  });

  it('runs forwards only', () => {
    expect(canTransition('DRAFT', 'OPEN')).toBe(true);
    expect(canTransition('OPEN', 'CLOSED')).toBe(true);
    expect(canTransition('CLOSED', 'COMPLETED')).toBe(true);
  });

  // Reopening would let a team swap a photo the Admin has already looked at.
  it('never reopens submissions', () => {
    expect(canTransition('CLOSED', 'OPEN')).toBe(false);
    expect(canTransition('COMPLETED', 'OPEN')).toBe(false);
    expect(canTransition('COMPLETED', 'CLOSED')).toBe(false);
  });

  it('lets a draft be closed without ever opening', () => {
    // The host may skip the block entirely; closing must still be reachable.
    expect(canTransition('DRAFT', 'CLOSED')).toBe(true);
  });

  it('never skips straight from draft to completed', () => {
    expect(canTransition('DRAFT', 'COMPLETED')).toBe(false);
    expect(canTransition('OPEN', 'COMPLETED')).toBe(false);
  });

  it('accepts uploads in exactly one phase', () => {
    expect(acceptsUploads('OPEN')).toBe(true);
    for (const status of ['DRAFT', 'CLOSED', 'COMPLETED'] as PhotoRoundStatus[]) {
      expect(acceptsUploads(status), status).toBe(false);
    }
  });

  // Judging stays possible after COMPLETED, so marking it done is not a trap.
  it('accepts awards once uploads have stopped, and keeps accepting them', () => {
    expect(acceptsAwards('CLOSED')).toBe(true);
    expect(acceptsAwards('COMPLETED')).toBe(true);
    expect(acceptsAwards('DRAFT')).toBe(false);
    expect(acceptsAwards('OPEN')).toBe(false);
  });
});

describe('splitting credits across a team', () => {
  const total = (shares: Array<{ amount: number }>) => shares.reduce((sum, s) => sum + s.amount, 0);

  it('divides evenly when it can', () => {
    const shares = distributeCredits(40, [1, 2, 3, 4]);
    expect(shares.map(s => s.amount)).toEqual([10, 10, 10, 10]);
    expect(total(shares)).toBe(40);
  });

  // The brief's awkward case: 25 across 4 must not lose or invent a credit.
  it('hands the remainder out one credit at a time', () => {
    const shares = distributeCredits(25, [1, 2, 3, 4]);
    expect(shares.map(s => s.amount)).toEqual([7, 6, 6, 6]);
    expect(total(shares)).toBe(25);
  });

  // The property that matters most: nothing is lost to rounding, nothing invented by it.
  it('always adds back up to exactly what was awarded', () => {
    for (let credits = 0; credits <= 60; credits += 1) {
      for (let members = 1; members <= 7; members += 1) {
        const ids = Array.from({ length: members }, (_, i) => i + 1);
        expect(total(distributeCredits(credits, ids)), `${credits}/${members}`).toBe(credits);
      }
    }
  });

  it('never differs by more than one credit between team-mates', () => {
    for (let credits = 1; credits <= 60; credits += 1) {
      for (let members = 2; members <= 7; members += 1) {
        const ids = Array.from({ length: members }, (_, i) => i + 1);
        const amounts = distributeCredits(credits, ids).map(s => s.amount);
        expect(Math.max(...amounts) - Math.min(...amounts), `${credits}/${members}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives one player the whole award', () => {
    expect(distributeCredits(25, [7]).map(s => s.amount)).toEqual([25]);
  });

  it('pays nobody when there is nobody to pay', () => {
    expect(distributeCredits(25, [])).toEqual([]);
  });

  it('pays zero rather than negative when the award is zero', () => {
    expect(distributeCredits(0, [1, 2]).map(s => s.amount)).toEqual([0, 0]);
  });

  it('handles fewer credits than players by paying only the first few', () => {
    const shares = distributeCredits(2, [1, 2, 3, 4]);
    expect(shares.map(s => s.amount)).toEqual([1, 1, 0, 0]);
    expect(total(shares)).toBe(2);
  });

  // The order decides who gets the extra credit, so it must be reproducible — including
  // on a retry.
  it('is deterministic for the same member order', () => {
    const once = distributeCredits(25, [3, 1, 2, 4]);
    const twice = distributeCredits(25, [3, 1, 2, 4]);
    expect(once).toEqual(twice);
    expect(once[0].playerId).toBe(3);
    expect(once[0].amount).toBe(7);
  });

  describe('describing the split for the Admin', () => {
    it('states an even split plainly', () => {
      expect(describeDistribution(40, 4)).toBe('4 × 10');
    });

    it('spells out an uneven split, so the odd credit is visible', () => {
      expect(describeDistribution(25, 4)).toBe('1 × 7 + 3 × 6');
      expect(describeDistribution(10, 4)).toBe('2 × 3 + 2 × 2');
    });

    it('says so when there is nothing to split or nobody to split it between', () => {
      expect(describeDistribution(0, 4)).toBe('no credits');
      expect(describeDistribution(25, 0)).toBe('no players in this team');
    });

    it('matches what the split actually pays', () => {
      // The words and the amounts must not drift apart.
      for (const [credits, members] of [[25, 4], [40, 4], [7, 3], [1, 5]] as Array<[number, number]>) {
        const ids = Array.from({ length: members }, (_, i) => i + 1);
        const amounts = distributeCredits(credits, ids).map(s => s.amount);
        const described = describeDistribution(credits, members);
        if (credits === 0) continue;
        const high = Math.max(...amounts);
        const low = Math.min(...amounts);
        const highs = amounts.filter(a => a === high).length;
        expect(described).toBe(high === low ? `${members} × ${high}` : `${highs} × ${high} + ${members - highs} × ${low}`);
      }
    });
  });
});
