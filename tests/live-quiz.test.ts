import { describe, expect, it } from 'vitest';
import {
  QUIZ_QUESTION_STATUSES,
  QUIZ_ACTION_TARGET,
  acceptsAnswers,
  canTransitionQuestion,
  isRevealed,
  mayShowContextPhoto,
  questionIsLive,
  questionParticipation,
  rewardForAnswer,
  type QuizQuestionStatus,
} from '../netlify/lib/live-quiz';
import { playerQuizQuestion, screenQuizQuestion, adminQuizQuestion } from '../netlify/lib/dto';

const OPTIONS = [
  { id: 1, question_id: 9, sort_order: 0, text: 'Lima', is_correct: true },
  { id: 2, question_id: 9, sort_order: 1, text: 'La Paz', is_correct: false },
  { id: 3, question_id: 9, sort_order: 2, text: 'Quito', is_correct: false },
];

const question = (status: QuizQuestionStatus, extra: Record<string, unknown> = {}) => ({
  id: 9, round_id: 3, sort_order: 0,
  prompt: 'Hoofdstad van Peru?', body: 'Zuid-Amerika',
  points: 40, time_limit_seconds: null, context_media_key: 'ctx-1',
  status, answer_count: 2, revision: 3,
  ...extra,
});

describe('the quiz question phases', () => {
  it('has the five phases the flow runs through', () => {
    expect(QUIZ_QUESTION_STATUSES).toEqual(['READY', 'OPEN', 'CLOSED', 'REVEALED', 'SETTLED']);
  });

  // The host decides when to close, so answers are accepted in exactly one phase and
  // the phone is never the authority on which one that is.
  it('accepts answers only while the question is open', () => {
    expect(acceptsAnswers('OPEN')).toBe(true);
    for (const status of ['READY', 'CLOSED', 'REVEALED', 'SETTLED'] as QuizQuestionStatus[]) {
      expect(acceptsAnswers(status), status).toBe(false);
    }
    expect(acceptsAnswers(null)).toBe(false);
    expect(acceptsAnswers(undefined)).toBe(false);
  });

  it('treats the answer as public from the reveal onwards and not before', () => {
    expect(isRevealed('REVEALED')).toBe(true);
    expect(isRevealed('SETTLED')).toBe(true);
    for (const status of ['READY', 'OPEN', 'CLOSED'] as QuizQuestionStatus[]) {
      expect(isRevealed(status), status).toBe(false);
    }
  });

  it('gates the context photo on exactly the same rule as the answer', () => {
    for (const status of QUIZ_QUESTION_STATUSES) {
      expect(mayShowContextPhoto(status), status).toBe(isRevealed(status));
    }
  });
});

describe('the quiz phase machine', () => {
  it('walks forward through the flow', () => {
    expect(canTransitionQuestion('READY', 'OPEN')).toBe(true);
    expect(canTransitionQuestion('OPEN', 'CLOSED')).toBe(true);
    expect(canTransitionQuestion('CLOSED', 'REVEALED')).toBe(true);
    // Revealing is also paying, so a revealed question is finished and goes nowhere.
    expect(canTransitionQuestion('REVEALED', 'SETTLED')).toBe(false);
  });

  // The point of the machine: a stale command from a second admin tab must not roll a
  // question backwards into a phase the room has already left.
  it('refuses to go backwards, and refuses to skip the reveal', () => {
    expect(canTransitionQuestion('SETTLED', 'REVEALED')).toBe(false);
    expect(canTransitionQuestion('SETTLED', 'OPEN')).toBe(false);
    expect(canTransitionQuestion('REVEALED', 'CLOSED')).toBe(false);
    expect(canTransitionQuestion('OPEN', 'REVEALED')).toBe(false);
    expect(canTransitionQuestion('READY', 'SETTLED')).toBe(false);
  });

  // Reopening is the one deliberate step back, and only from CLOSED — before anyone has
  // been paid, which is what makes it safe.
  it('allows reopening a closed question, but not a revealed one', () => {
    expect(canTransitionQuestion('CLOSED', 'OPEN')).toBe(true);
    expect(canTransitionQuestion('REVEALED', 'OPEN')).toBe(false);
  });

  it('maps every action to the phase it produces', () => {
    expect(QUIZ_ACTION_TARGET).toEqual({
      OPEN: 'OPEN', CLOSE: 'CLOSED', REVEAL: 'REVEALED', REOPEN: 'OPEN',
    });
  });

  it('knows which phases still owe the host something', () => {
    expect(questionIsLive('OPEN')).toBe(true);
    expect(questionIsLive('CLOSED')).toBe(true);
    expect(questionIsLive('READY')).toBe(false);
    expect(questionIsLive('SETTLED')).toBe(false);
    // Finished: its answer is up and its rewards are paid, both by the same transition.
    expect(questionIsLive('REVEALED')).toBe(false);
  });
});

describe('participation', () => {
  it('reports answered, eligible, remaining and a whole percentage', () => {
    expect(questionParticipation(8, 11)).toEqual({ answered: 8, eligible: 11, remaining: 3, percentage: 73 });
  });

  // A player who answered and was then deactivated must not push the bar past 100%,
  // which would read as a bug at exactly the moment the host is trusting it.
  it('clamps answers to the number of players who may answer', () => {
    expect(questionParticipation(9, 4)).toEqual({ answered: 4, eligible: 4, remaining: 0, percentage: 100 });
  });

  it('survives an empty room without dividing by zero', () => {
    expect(questionParticipation(0, 0)).toEqual({ answered: 0, eligible: 0, remaining: 0, percentage: 0 });
  });
});

describe('what a question is worth', () => {
  it('pays the authored points for a correct option and nothing otherwise', () => {
    expect(rewardForAnswer(40, true)).toBe(40);
    expect(rewardForAnswer(40, false)).toBe(0);
  });

  it('never pays a negative reward', () => {
    expect(rewardForAnswer(-5, true)).toBe(0);
  });
});

// These are the security rules, not formatting: the projector URL is effectively public
// and a phone is not trusted either, so what each receives is asserted directly.
describe('what leaves the server', () => {
  it('withholds which option is correct from a phone until the reveal', () => {
    for (const status of ['READY', 'OPEN', 'CLOSED'] as QuizQuestionStatus[]) {
      const payload = playerQuizQuestion(question(status), OPTIONS, { optionId: null });
      for (const option of payload.options) {
        expect(option, status).not.toHaveProperty('isCorrect');
      }
      expect(payload.myAnswerCorrect, status).toBeNull();
    }
  });

  it('gives a phone the correct options once revealed', () => {
    const payload = playerQuizQuestion(question('REVEALED'), OPTIONS, { optionId: 1 });
    expect(payload.options.map(o => (o as any).isCorrect)).toEqual([true, false, false]);
    expect(payload.myAnswerCorrect).toBe(true);
  });

  it('tells a phone it was wrong only once the answer is public', () => {
    expect(playerQuizQuestion(question('CLOSED'), OPTIONS, { optionId: 2 }).myAnswerCorrect).toBeNull();
    expect(playerQuizQuestion(question('SETTLED'), OPTIONS, { optionId: 2 }).myAnswerCorrect).toBe(false);
  });

  // The key itself is withheld, not merely a flag — an early render has no file to name.
  it('never names the context photo before the reveal, even when asked to show it', () => {
    const early = screenQuizQuestion(question('OPEN', { context_photo_shown: true }), OPTIONS);
    expect(early.contextMediaKey).toBeNull();
    expect(early.showingContextPhoto).toBe(false);
  });

  it('names the context photo once revealed and asked for', () => {
    const shown = screenQuizQuestion(question('REVEALED', { context_photo_shown: true }), OPTIONS);
    expect(shown.contextMediaKey).toBe('ctx-1');
    expect(shown.showingContextPhoto).toBe(true);
  });

  it('withholds the photo while revealed but not asked for', () => {
    const hidden = screenQuizQuestion(question('REVEALED', { context_photo_shown: false }), OPTIONS);
    expect(hidden.contextMediaKey).toBeNull();
  });

  // A builder must not leak a column nobody added to a strip list, so the projector
  // payload is asserted as a closed set of keys.
  it('sends the projector only the fields it was built with', () => {
    const payload = screenQuizQuestion(question('OPEN'), OPTIONS);
    expect(Object.keys(payload).sort()).toEqual([
      'body', 'contextMediaKey', 'id', 'options', 'participation', 'points', 'prompt',
      'showingContextPhoto', 'status',
    ]);
  });

  it('sends a phone only the fields it was built with', () => {
    const payload = playerQuizQuestion(question('OPEN'), OPTIONS, { optionId: null });
    expect(Object.keys(payload).sort()).toEqual([
      'body', 'closesAt', 'id', 'myAnswerCorrect', 'myOptionId', 'options', 'points', 'prompt',
      'status', 'timeLimitSeconds',
    ]);
  });

  // The Admin is the one audience entitled to everything, including before the reveal.
  it('gives the Admin the correct options at every phase', () => {
    const payload = adminQuizQuestion(question('READY'), OPTIONS, 4);
    expect(payload.options.map(o => o.isCorrect)).toEqual([true, false, false]);
    expect(payload.contextMediaKey).toBe('ctx-1');
    expect(payload.points).toBe(40);
    expect(payload.revision).toBe(3);
  });
});
