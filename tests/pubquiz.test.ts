import { describe, expect, it } from 'vitest';
import {
  canTransitionPubquiz,
  pubquizAcceptsAnswers,
  pubquizIsLive,
  pubquizIsRevealed,
  pubquizResults,
  pubquizReward,
  PUBQUIZ_ACTION_TARGET,
  PUBQUIZ_STATUSES,
} from '../netlify/lib/pubquiz';
import { adminPubquizQuestion, screenPubquizQuestion, playerPubquizQuestion } from '../netlify/lib/dto';

const question = (extra: Record<string, unknown> = {}) => ({
  id: 7, round_id: 3, sort_order: 0,
  question: 'Hoofdstad van Peru?', body: 'Denk goed na.',
  points: 40, media_key: 'pic-7', media_name: 'peru.png',
  time_limit_seconds: 30, hidden: false,
  status: 'OPEN', opened_at: null, closed_at: null, revealed_at: null, revision: 2,
  answer_count: 3,
  ...extra,
});

const options = [
  { id: 11, question_id: 7, sort_order: 0, text: 'Lima', is_correct: true },
  { id: 12, question_id: 7, sort_order: 1, text: 'La Paz', is_correct: false },
  { id: 13, question_id: 7, sort_order: 2, text: 'Quito', is_correct: false },
];

const answers = [{ optionId: 11 }, { optionId: 11 }, { optionId: 12 }];

describe('the pubquiz phase machine', () => {
  it('has four phases, not the quiz’s five', () => {
    expect(PUBQUIZ_STATUSES).toEqual(['READY', 'OPEN', 'CLOSED', 'REVEALED']);
    // Revealing is also paying, so there is nothing left for a SETTLED phase to mean.
    expect(PUBQUIZ_STATUSES).not.toContain('SETTLED');
  });

  it('walks READY → OPEN → CLOSED → REVEALED', () => {
    expect(canTransitionPubquiz('READY', 'OPEN')).toBe(true);
    expect(canTransitionPubquiz('OPEN', 'CLOSED')).toBe(true);
    expect(canTransitionPubquiz('CLOSED', 'REVEALED')).toBe(true);
  });

  // Closing too early is the mistake that actually happens, so it is the one that is
  // undoable.
  it('lets a closed question be reopened', () => {
    expect(canTransitionPubquiz('CLOSED', 'OPEN')).toBe(true);
    expect(PUBQUIZ_ACTION_TARGET.REOPEN).toBe('OPEN');
  });

  // Reopening a revealed question would mean paying twice or leaving the first payout
  // standing against a question being asked again. Neither is a button.
  it('never lets a revealed question go anywhere', () => {
    for (const to of PUBQUIZ_STATUSES) expect(canTransitionPubquiz('REVEALED', to), to).toBe(false);
  });

  it('refuses to skip a phase', () => {
    expect(canTransitionPubquiz('READY', 'REVEALED')).toBe(false);
    expect(canTransitionPubquiz('READY', 'CLOSED')).toBe(false);
    expect(canTransitionPubquiz('OPEN', 'REVEALED')).toBe(false);
  });

  it('accepts answers in exactly one phase', () => {
    expect(pubquizAcceptsAnswers('OPEN')).toBe(true);
    for (const status of ['READY', 'CLOSED', 'REVEALED', null, undefined]) {
      expect(pubquizAcceptsAnswers(status as any), String(status)).toBe(false);
    }
  });

  it('reveals in exactly one phase', () => {
    expect(pubquizIsRevealed('REVEALED')).toBe(true);
    for (const status of ['READY', 'OPEN', 'CLOSED']) expect(pubquizIsRevealed(status), status).toBe(false);
  });

  it('knows which phases still owe the room something', () => {
    expect(pubquizIsLive('OPEN')).toBe(true);
    expect(pubquizIsLive('CLOSED')).toBe(true);
    expect(pubquizIsLive('READY')).toBe(false);
    expect(pubquizIsLive('REVEALED')).toBe(false);
  });
});

describe('what a pubquiz question pays', () => {
  it('pays the question’s points for the right answer and nothing for a wrong one', () => {
    expect(pubquizReward(40, true)).toBe(40);
    expect(pubquizReward(40, false)).toBe(0);
  });

  it('never pays a negative or fractional amount', () => {
    expect(pubquizReward(-10, true)).toBe(0);
    expect(pubquizReward(12.7, true)).toBe(12);
    expect(pubquizReward(Number.NaN, true)).toBe(0);
  });
});

describe('how the room answered', () => {
  it('counts every option, including the ones nobody picked', () => {
    const results = pubquizResults(
      options.map(o => ({ id: o.id, isCorrect: o.is_correct })),
      answers,
      10,
    );
    expect(results.tally).toEqual([
      { optionId: 11, count: 2, isCorrect: true },
      { optionId: 12, count: 1, isCorrect: false },
      { optionId: 13, count: 0, isCorrect: false },
    ]);
    expect(results.answered).toBe(3);
    expect(results.correct).toBe(2);
    expect(results.participation).toMatchObject({ answered: 3, eligible: 10, percentage: 30 });
  });
});

describe('what each audience is told about a pubquiz question', () => {
  // ---------------------------------------------------------------------
  // The projector
  // ---------------------------------------------------------------------
  describe('the projector', () => {
    it('sends no answer key and no tally before the reveal', () => {
      for (const status of ['READY', 'OPEN', 'CLOSED']) {
        const dto = screenPubquizQuestion(question({ status }), options, answers, 10);
        for (const option of dto.options) {
          expect(option, status).not.toHaveProperty('isCorrect');
          // A tally is the answer key in disguise: an option everyone picked says as much
          // as the flag would.
          expect(option, status).not.toHaveProperty('count');
        }
        expect(dto, status).not.toHaveProperty('correctCount');
      }
    });

    it('sends both the moment it is revealed', () => {
      const dto = screenPubquizQuestion(question({ status: 'REVEALED' }), options, answers, 10);
      expect(dto.options.map((o: any) => o.isCorrect)).toEqual([true, false, false]);
      expect(dto.options.map((o: any) => o.count)).toEqual([2, 1, 0]);
      expect(dto.correctCount).toBe(2);
    });

    // How many have answered says nothing about *what* they answered, so the room may
    // watch the bar fill.
    it('always says how many have answered', () => {
      expect(screenPubquizQuestion(question({ status: 'OPEN' }), options, answers, 10).participation)
        .toMatchObject({ answered: 3, eligible: 10, percentage: 30 });
    });

    // The image is part of the question, unlike the quiz's context photo.
    it('sends the question image from the start', () => {
      expect(screenPubquizQuestion(question({ status: 'READY' }), options, [], 10).mediaKey).toBe('pic-7');
    });

    it('sends nothing the room has no use for', () => {
      const dto = screenPubquizQuestion(question(), options, answers, 10);
      for (const field of ['hidden', 'roundId', 'revision', 'mediaName', 'sortOrder', 'results']) {
        expect(dto, field).not.toHaveProperty(field);
      }
    });
  });

  // ---------------------------------------------------------------------
  // The player
  // ---------------------------------------------------------------------
  describe('a player’s phone', () => {
    it('sends no answer key before the reveal', () => {
      const dto = playerPubquizQuestion(question({ status: 'OPEN' }), options, { optionId: 12 });
      for (const option of dto.options) expect(option).not.toHaveProperty('isCorrect');
      expect(dto).not.toHaveProperty('myPoints');
      expect(dto.myAnswerCorrect).toBeNull();
    });

    it('tells the player what they picked, even before the reveal', () => {
      expect(playerPubquizQuestion(question({ status: 'OPEN' }), options, { optionId: 12 }).myOptionId).toBe(12);
    });

    it('tells a winner they were right and what it paid', () => {
      const dto = playerPubquizQuestion(question({ status: 'REVEALED' }), options, { optionId: 11 });
      expect(dto.myAnswerCorrect).toBe(true);
      expect(dto.myPoints).toBe(40);
      expect(dto.options.find((o: any) => o.id === 11)!.isCorrect).toBe(true);
    });

    // Zero rather than absent: "you got nothing" is information the player is owed, and
    // an absent field renders as "not scored yet".
    it('tells a loser they got nothing, rather than saying nothing', () => {
      const dto = playerPubquizQuestion(question({ status: 'REVEALED' }), options, { optionId: 12 });
      expect(dto.myAnswerCorrect).toBe(false);
      expect(dto.myPoints).toBe(0);
    });

    it('does not claim a player who never answered was wrong', () => {
      const dto = playerPubquizQuestion(question({ status: 'REVEALED' }), options, { optionId: null });
      expect(dto.myOptionId).toBeNull();
      expect(dto.myAnswerCorrect).toBeNull();
    });

    it('never sends another player’s answers or the distribution', () => {
      const dto = playerPubquizQuestion(question({ status: 'REVEALED' }), options, { optionId: 11 });
      expect(dto).not.toHaveProperty('results');
      expect(dto).not.toHaveProperty('participation');
      for (const option of dto.options) expect(option).not.toHaveProperty('count');
    });
  });

  // ---------------------------------------------------------------------
  // The host
  // ---------------------------------------------------------------------
  describe('the Admin', () => {
    it('sees the answer key while authoring', () => {
      const dto = adminPubquizQuestion(question({ status: 'READY' }), options, [], 10);
      expect(dto.options.map(o => o.isCorrect)).toEqual([true, false, false]);
    });

    // Deciding when to close is exactly what the distribution is for, so the host has it
    // before the reveal — and no other surface does.
    it('sees the distribution before the reveal', () => {
      const dto = adminPubquizQuestion(question({ status: 'OPEN' }), options, answers, 10);
      expect(dto.results.tally.map(t => t.count)).toEqual([2, 1, 0]);
      expect(dto.results.participation.percentage).toBe(30);
    });

    it('sees whether the question is in the run', () => {
      expect(adminPubquizQuestion(question({ hidden: true }), options, [], 10).hidden).toBe(true);
      expect(adminPubquizQuestion(question(), options, [], 10).hidden).toBe(false);
    });
  });
});
