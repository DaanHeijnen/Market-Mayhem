import { questionParticipation, type QuestionParticipation } from './live-quiz';

/**
 * Rules for a PUBQUIZ round.
 *
 * A pubquiz is a presentation whose pages are questions: the projector shows one large,
 * the room answers it on their phones, the host reveals, and stepping forward opens the
 * next one. Authored content (`pubquiz_questions`, `pubquiz_question_options`), runtime
 * state (`pubquiz_question_state`) and what the room answered (`pubquiz_answers`) are
 * three separate tables, and nothing in this file writes to any of them.
 *
 * Deliberately shares no *table* with LIVE_QUIZ — see migration 0020 for why — but does
 * share its pure arithmetic. `questionParticipation` is "n of m answered, as a percent"
 * and has nothing to do with which quiz asked; restating it here would be two copies of
 * one calculation, which is worse than the import.
 */

/**
 * Four phases, not the quiz's five.
 *
 * LIVE_QUIZ has a SETTLED phase after REVEALED because revealing and paying are two
 * separate host actions there. A pubquiz pays at the reveal — the room is told the answer
 * and the points land in the same breath — so REVEALED is where a question ends and there
 * is nothing left for a fifth phase to mean.
 */
export const PUBQUIZ_STATUSES = ['READY', 'OPEN', 'CLOSED', 'REVEALED'] as const;
export type PubquizStatus = typeof PUBQUIZ_STATUSES[number];

export type PubquizAction = 'OPEN' | 'CLOSE' | 'REVEAL' | 'REOPEN';

export const PUBQUIZ_ACTION_TARGET: Record<PubquizAction, PubquizStatus> = {
  OPEN: 'OPEN',
  CLOSE: 'CLOSED',
  REVEAL: 'REVEALED',
  REOPEN: 'OPEN',
};

/**
 * The phase machine, as a map rather than a chain of ifs, because every admin command is
 * checked against it — including the ones that arrive twice.
 *
 * REVEALED is terminal. Reopening a revealed question would mean either paying a second
 * set of rewards or leaving the first set standing against a question the room is being
 * asked again; neither is something a host should be able to do by pressing a button.
 * CLOSED can go back to OPEN, which is the case that actually happens: closing too early.
 */
const PUBQUIZ_TRANSITIONS: Record<PubquizStatus, PubquizStatus[]> = {
  READY: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['REVEALED', 'OPEN'],
  REVEALED: [],
};

export function canTransitionPubquiz(from: PubquizStatus, to: PubquizStatus) {
  return PUBQUIZ_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Answers are accepted in exactly one phase, and the server is what decides that. */
export function pubquizAcceptsAnswers(status: string | null | undefined) {
  return status === 'OPEN';
}

/** The answer key is public from the reveal onwards, and not one moment sooner. */
export function pubquizIsRevealed(status: string | null | undefined) {
  return status === 'REVEALED';
}

/** Phases in which the question is still the host's problem — neither fresh nor finished. */
export function pubquizIsLive(status: string | null | undefined) {
  return status === 'OPEN' || status === 'CLOSED';
}

/** What a question is worth to one player. Wrong answers are worth nothing. */
export function pubquizReward(points: number, optionIsCorrect: boolean) {
  return optionIsCorrect ? Math.max(0, Math.trunc(points) || 0) : 0;
}

export type PubquizTally = {
  optionId: number;
  count: number;
  isCorrect: boolean;
};

export type PubquizResults = {
  /** One entry per option, in the order the options are authored. */
  tally: PubquizTally[];
  answered: number;
  correct: number;
  participation: QuestionParticipation;
};

/**
 * How the room answered, once it may be told.
 *
 * Built from rows rather than counted on a surface, so the projector and the phones cannot
 * arrive at different numbers. Only ever called after the reveal — before that, the counts
 * per option are the answer key in disguise: an option nobody picked and an option everyone
 * picked would tell the room as much as `is_correct` would.
 */
export function pubquizResults(
  options: { id: number; isCorrect: boolean }[],
  answers: { optionId: number }[],
  eligibleCount: number,
): PubquizResults {
  const counts = new Map<number, number>();
  for (const answer of answers) counts.set(answer.optionId, (counts.get(answer.optionId) ?? 0) + 1);

  const tally = options.map(option => ({
    optionId: option.id,
    count: counts.get(option.id) ?? 0,
    isCorrect: option.isCorrect,
  }));

  return {
    tally,
    answered: answers.length,
    correct: tally.filter(t => t.isCorrect).reduce((sum, t) => sum + t.count, 0),
    participation: questionParticipation(answers.length, eligibleCount),
  };
}
