/**
 * Rules for the live (Kahoot-style) question block.
 *
 * The block's phases already live on `round_blocks.interactive_status`; this module is
 * the arithmetic and the gating that Admin, phones and the projector must all agree on,
 * kept pure so the three surfaces cannot drift into three different answers.
 */

export const QUESTION_STATUSES = ['READY', 'OPEN', 'CLOSED', 'REVEALED', 'SETTLED'] as const;
export type QuestionStatus = typeof QUESTION_STATUSES[number];

/** Answers are accepted in exactly one phase. The server enforces this, not the phone. */
export function acceptsAnswers(status: string | null | undefined) {
  return status === 'OPEN';
}

/** The correct answer is public from the reveal onwards, and not one moment sooner. */
export function isRevealed(status: string | null | undefined) {
  return status === 'REVEALED' || status === 'SETTLED';
}

/**
 * The context photo is a beat *after* the reveal, never before: the whole point is that
 * it lands as evidence once the room already knows the answer. Gated on the same
 * condition as the answer itself, so there is one rule rather than two that can diverge.
 */
export function mayShowContextPhoto(status: string | null | undefined) {
  return isRevealed(status);
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
 * bar stuck short of full. `answered` is clamped to `eligible` for the same reason from
 * the other direction: a player who answered and was then deactivated must not push this
 * past 100%, which would read as a bug at exactly the moment the host is trusting it.
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
