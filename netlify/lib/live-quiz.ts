/**
 * Rules for a LIVE_QUIZ round.
 *
 * A quiz round is an ordered list of questions, each with its own points, its own options
 * and its own phase. The phases are what Admin, phones and the projector must all agree
 * on, so they are kept pure here rather than being re-derived on three surfaces.
 *
 * Authored content (`live_quiz_questions`, `live_quiz_question_options`) and runtime state
 * (`live_quiz_question_state`) are separate tables. Nothing in this file writes; it says
 * what is allowed, and the endpoints do the writing under a lock.
 */

/**
 * `SETTLED` is kept only because rows already carry it.
 *
 * It used to be a real phase: revealing showed the answer and a second press paid for it.
 * Revealing *is* paying now — one transition, one transaction — so `REVEALED` is where a
 * question ends and nothing moves past it. The value stays legal so questions settled
 * under the old flow still read correctly everywhere.
 */
export const QUIZ_QUESTION_STATUSES = ['READY', 'OPEN', 'CLOSED', 'REVEALED', 'SETTLED'] as const;
export type QuizQuestionStatus = typeof QUIZ_QUESTION_STATUSES[number];

/** Answers are accepted in exactly one phase. The server enforces this, never the phone. */
export function acceptsAnswers(status: string | null | undefined) {
  return status === 'OPEN';
}

/** The correct options are public from the reveal onwards, and not one moment sooner. */
export function isRevealed(status: string | null | undefined) {
  return status === 'REVEALED' || status === 'SETTLED';
}

/**
 * The context photo is a beat *after* the reveal, never before: the point is that it lands
 * as evidence once the room already knows the answer. Gated on the same condition as the
 * answer itself, so there is one rule rather than two that can diverge.
 */
export function mayShowContextPhoto(status: string | null | undefined) {
  return isRevealed(status);
}

/**
 * The phase machine.
 *
 * Written as an explicit map rather than a chain of ifs because every admin command is
 * checked against it, including the ones that arrive twice. A command whose `from` no
 * longer matches is refused rather than applied, which is what stops a stale REVEAL from a
 * second admin tab rolling a settled question back.
 */
const QUIZ_TRANSITIONS: Record<QuizQuestionStatus, QuizQuestionStatus[]> = {
  READY: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['REVEALED', 'OPEN'],
  REVEALED: [],
  SETTLED: [],
};

export type QuizAction = 'OPEN' | 'CLOSE' | 'REVEAL' | 'REOPEN';

export const QUIZ_ACTION_TARGET: Record<QuizAction, QuizQuestionStatus> = {
  OPEN: 'OPEN',
  CLOSE: 'CLOSED',
  REVEAL: 'REVEALED',
  REOPEN: 'OPEN',
};

export function canTransitionQuestion(from: QuizQuestionStatus, to: QuizQuestionStatus) {
  return QUIZ_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Phases in which a question is still the host's problem — neither fresh nor finished.
 *
 * `REVEALED` is finished: the answer is on screen and the rewards are paid, both by the
 * same transition. It was listed here while paying was a separate press, and leaving it
 * here afterwards meant a round could never be completed — every question that had been
 * answered looked unresolved.
 */
export function questionIsLive(status: string | null | undefined) {
  return status === 'OPEN' || status === 'CLOSED';
}

export type QuestionParticipation = {
  /** Answers from players who may still answer. */
  answered: number;
  /** Players who are allowed to answer at all. */
  eligible: number;
  /** How many the host is still waiting on. */
  remaining: number;
  /** Whole percent, 0–100. */
  percentage: number;
};

/**
 * "8 / 11 — 73%", the number the host decides on.
 *
 * The denominator is who may actually take part, so a deactivated player never leaves the
 * bar stuck short of full. `answered` is clamped to `eligible` for the same reason from the
 * other direction: a player who answered and was then deactivated must not push this past
 * 100%, which would read as a bug at exactly the moment the host is trusting it.
 */
export function questionParticipation(answeredRaw: number, eligibleRaw: number): QuestionParticipation {
  const eligible = Math.max(0, Math.trunc(eligibleRaw) || 0);
  const answered = Math.min(eligible, Math.max(0, Math.trunc(answeredRaw) || 0));
  return {
    answered,
    eligible,
    remaining: eligible - answered,
    // Multiplied before dividing: (7/100)*100 lands on 7.000000000000001 the other way.
    percentage: eligible === 0 ? 0 : Math.round((answered * 100) / eligible),
  };
}

/**
 * What a question is worth to one player.
 *
 * Points are authored per question, so this is a lookup rather than arithmetic — but it is
 * a function because "correct" is a property of the option, not of an index, now that a
 * question may have more than one correct option.
 */
export function rewardForAnswer(points: number, optionIsCorrect: boolean) {
  return optionIsCorrect ? Math.max(0, Math.trunc(points) || 0) : 0;
}
