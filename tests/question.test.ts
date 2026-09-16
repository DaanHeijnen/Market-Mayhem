import { describe, expect, it } from 'vitest';
import {
  QUESTION_STATUSES,
  acceptsAnswers,
  isRevealed,
  mayShowContextPhoto,
  questionParticipation,
  type QuestionStatus,
} from '../netlify/lib/question';
import { normalizeBlock } from '../netlify/lib/queries';

describe('the live question phases', () => {
  it('has the five phases the flow runs through', () => {
    expect(QUESTION_STATUSES).toEqual(['READY', 'OPEN', 'CLOSED', 'REVEALED', 'SETTLED']);
  });

  // The host decides when to close, so answers are accepted in exactly one phase and
  // the phone is never the authority on which one that is.
  it('accepts answers only while the question is open', () => {
    expect(acceptsAnswers('OPEN')).toBe(true);
    for (const status of ['READY', 'CLOSED', 'REVEALED', 'SETTLED'] as QuestionStatus[]) {
      expect(acceptsAnswers(status), status).toBe(false);
    }
  });

  it('treats a missing status as not accepting answers', () => {
    expect(acceptsAnswers(null)).toBe(false);
    expect(acceptsAnswers(undefined)).toBe(false);
    expect(acceptsAnswers('')).toBe(false);
  });

  it('keeps the correct answer secret until the host reveals it', () => {
    expect(isRevealed('REVEALED')).toBe(true);
    expect(isRevealed('SETTLED')).toBe(true);
    for (const status of ['READY', 'OPEN', 'CLOSED'] as QuestionStatus[]) {
      expect(isRevealed(status), status).toBe(false);
    }
  });
});

describe('the context photo gate', () => {
  // The whole point of the photo is that it lands after the room knows the answer.
  it('is closed until the answer has been revealed', () => {
    for (const status of ['READY', 'OPEN', 'CLOSED'] as QuestionStatus[]) {
      expect(mayShowContextPhoto(status), status).toBe(false);
    }
  });

  it('stays open once revealed, including after settling', () => {
    expect(mayShowContextPhoto('REVEALED')).toBe(true);
    expect(mayShowContextPhoto('SETTLED')).toBe(true);
  });

  // One rule, not two: the photo becomes visible exactly when the answer does, so the
  // two can never drift into disagreeing.
  it('opens at the same moment the answer becomes public', () => {
    for (const status of [...QUESTION_STATUSES, null, undefined, 'NONSENSE']) {
      expect(mayShowContextPhoto(status as any), String(status)).toBe(isRevealed(status as any));
    }
  });
});

describe('participation the host decides on', () => {
  it('reports the brief\'s worked example', () => {
    expect(questionParticipation(8, 11)).toEqual({ answered: 8, eligible: 11, remaining: 3, percentage: 73 });
  });

  it('reads as complete when everyone has answered', () => {
    expect(questionParticipation(11, 11)).toEqual({ answered: 11, eligible: 11, remaining: 0, percentage: 100 });
  });

  it('starts at nothing', () => {
    expect(questionParticipation(0, 11)).toEqual({ answered: 0, eligible: 11, remaining: 11, percentage: 0 });
  });

  // A game with nobody in it must not divide by zero and must not claim 100%.
  it('says nothing rather than everything when no player may answer', () => {
    expect(questionParticipation(0, 0)).toEqual({ answered: 0, eligible: 0, remaining: 0, percentage: 0 });
  });

  // A player who answered and was then deactivated would otherwise push this over 100%,
  // which reads as a bug at exactly the moment the host is trusting the number.
  it('never exceeds the number of players who may answer', () => {
    expect(questionParticipation(12, 11)).toEqual({ answered: 11, eligible: 11, remaining: 0, percentage: 100 });
    expect(questionParticipation(5, 0)).toEqual({ answered: 0, eligible: 0, remaining: 0, percentage: 0 });
  });

  it('never goes negative', () => {
    expect(questionParticipation(-3, 11).answered).toBe(0);
    expect(questionParticipation(3, -11)).toEqual({ answered: 0, eligible: 0, remaining: 0, percentage: 0 });
  });

  it('gives a whole percentage, never a floating-point tail', () => {
    for (let eligible = 1; eligible <= 40; eligible += 1) {
      for (let answered = 0; answered <= eligible; answered += 1) {
        const { percentage } = questionParticipation(answered, eligible);
        expect(Number.isInteger(percentage), `${answered}/${eligible} → ${percentage}`).toBe(true);
        expect(percentage).toBeGreaterThanOrEqual(0);
        expect(percentage).toBeLessThanOrEqual(100);
      }
    }
  });

  // The three numbers are read together off one panel, so they have to add up.
  it('always splits the eligible players into answered and remaining', () => {
    for (let eligible = 0; eligible <= 30; eligible += 1) {
      for (let answered = 0; answered <= eligible; answered += 1) {
        const p = questionParticipation(answered, eligible);
        expect(p.answered + p.remaining, `${answered}/${eligible}`).toBe(p.eligible);
      }
    }
  });

  it('reaches 100% only when nobody is left to answer', () => {
    for (let eligible = 1; eligible <= 30; eligible += 1) {
      for (let answered = 0; answered <= eligible; answered += 1) {
        const p = questionParticipation(answered, eligible);
        expect(p.percentage === 100, `${answered}/${eligible}`).toBe(p.remaining === 0);
      }
    }
  });

  it('tolerates fractional input rather than producing a fractional readout', () => {
    // Counts arrive from SQL as numbers; a non-integer would be a bug elsewhere, but it
    // must not turn into "7.5 / 11 answered" on the projector.
    expect(questionParticipation(7.6, 11.2)).toEqual({ answered: 7, eligible: 11, remaining: 4, percentage: 64 });
    expect(questionParticipation(Number.NaN, 11).answered).toBe(0);
    expect(questionParticipation(4, Number.NaN)).toEqual({ answered: 0, eligible: 0, remaining: 0, percentage: 0 });
  });
});

describe('what each surface is told about a question', () => {
  const PHOTO = '1/image/secret123.jpg';
  const row = (status: string) => ({
    id: 33,
    round_id: 3,
    type: 'DUOLINGO_QUESTION',
    title: 'Wie deed dit?',
    sort_order: 1,
    interactive_status: status,
    answer_count: 8,
    payload: {
      body: 'Denk goed na.',
      answers: ['Twan', 'Bas', 'Emma', 'Jorrit'],
      correctAnswerIndex: 1,
      rewardCoins: 10,
      contextImageKey: PHOTO,
    },
  });

  const projector = (status: string) => normalizeBlock(row(status), false, 11) as any;
  const admin = (status: string) => normalizeBlock(row(status), true, 11) as any;

  it('gives the projector the question, its supporting text and the answers', () => {
    const view = projector('OPEN');
    expect(view.title).toBe('Wie deed dit?');
    expect(view.payload.body).toBe('Denk goed na.');
    expect(view.payload.answers).toEqual(['Twan', 'Bas', 'Emma', 'Jorrit']);
  });

  // The secret must not cross the wire, not merely stay unrendered — the projector
  // snapshot is served to anyone holding the screen URL.
  it('withholds the correct answer until the host reveals it', () => {
    for (const status of ['READY', 'OPEN', 'CLOSED']) {
      expect(projector(status).payload.correctAnswerIndex, status).toBeUndefined();
    }
    expect(projector('REVEALED').payload.correctAnswerIndex).toBe(1);
    expect(projector('SETTLED').payload.correctAnswerIndex).toBe(1);
  });

  // Same rule for the photo, which is why it cannot be shown early even by a client that
  // asks: before the reveal there is no key to fetch it with.
  it('withholds the context photo key until the host reveals the answer', () => {
    for (const status of ['READY', 'OPEN', 'CLOSED']) {
      expect(projector(status).payload.contextImageKey, status).toBeUndefined();
    }
    expect(projector('REVEALED').payload.contextImageKey).toBe(PHOTO);
    expect(projector('SETTLED').payload.contextImageKey).toBe(PHOTO);
  });

  it('still tells every surface that a photo exists, so the step can be offered', () => {
    expect(projector('OPEN').hasContextPhoto).toBe(true);
    expect(admin('OPEN').hasContextPhoto).toBe(true);
    const none = normalizeBlock({ ...row('REVEALED'), payload: { ...row('REVEALED').payload, contextImageKey: '' } }, false, 11) as any;
    expect(none.hasContextPhoto).toBe(false);
  });

  it('gives the Admin everything from the start, including before the reveal', () => {
    const view = admin('OPEN');
    expect(view.payload.correctAnswerIndex).toBe(1);
    expect(view.payload.contextImageKey).toBe(PHOTO);
  });

  it('attaches the same participation figures to both surfaces', () => {
    const expected = { answered: 8, eligible: 11, remaining: 3, percentage: 73 };
    expect(projector('OPEN').participation).toEqual(expected);
    expect(admin('OPEN').participation).toEqual(expected);
  });

  // Other block types have no participation of their own; a zero would read as "nobody
  // has answered" rather than "this does not take answers".
  it('gives no participation figures to a block that takes no answers', () => {
    const text = normalizeBlock({ id: 1, round_id: 3, type: 'TEXT', sort_order: 1, payload: {}, interactive_status: null }, true, 11) as any;
    expect(text.participation).toBeNull();
    expect(text.hasContextPhoto).toBe(false);
  });
});
