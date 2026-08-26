import { HttpError } from './http';

/**
 * Limits on player-proposed markets, from the design: a player gets two requests and
 * must wait an hour between them.
 *
 * These live here as pure functions rather than as database constraints because both
 * are relative to the requesting player and both need to explain themselves — a player
 * who has run out should be told they have run out, and one on cooldown should be told
 * how long is left, not shown a constraint violation.
 */

export const MAX_REQUESTS_PER_PLAYER = 2;
export const REQUEST_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_QUESTION_LENGTH = 300;

export type RequestDecision = 'APPROVED' | 'DENIED';

export function requestsRemaining(existingCount: number) {
  return Math.max(0, MAX_REQUESTS_PER_PLAYER - existingCount);
}

/** Milliseconds left on the cooldown, given the most recent submission. 0 when clear. */
export function cooldownRemainingMs(lastSubmittedAt: Date | string | null, now = Date.now()) {
  if (!lastSubmittedAt) return 0;
  const last = new Date(lastSubmittedAt).getTime();
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, REQUEST_COOLDOWN_MS - (now - last));
}

export function cooldownMinutesLeft(lastSubmittedAt: Date | string | null, now = Date.now()) {
  return Math.ceil(cooldownRemainingMs(lastSubmittedAt, now) / 60000);
}

export function normalizeQuestion(value: unknown) {
  if (typeof value !== 'string') throw new HttpError(400, 'question must be a string');
  const question = value.trim();
  if (!question) throw new HttpError(400, 'Write a question before sending it');
  if (question.length > MAX_QUESTION_LENGTH) throw new HttpError(400, `Keep the question under ${MAX_QUESTION_LENGTH} characters`);
  return question;
}

/** Throws the player-facing reason they cannot submit right now. */
export function assertCanSubmit(existingCount: number, lastSubmittedAt: Date | string | null, now = Date.now()) {
  if (requestsRemaining(existingCount) === 0) {
    throw new HttpError(409, `You have already used all ${MAX_REQUESTS_PER_PLAYER} of your prediction requests`);
  }
  const waitMs = cooldownRemainingMs(lastSubmittedAt, now);
  if (waitMs > 0) {
    throw new HttpError(429, `You can send another prediction in ${Math.ceil(waitMs / 60000)} min`);
  }
}

export function decisionValue(value: unknown): RequestDecision {
  if (value !== 'APPROVED' && value !== 'DENIED') throw new HttpError(400, 'decision must be APPROVED or DENIED');
  return value;
}

/** A denial without a reason is not actionable for the player, so it is rejected. */
export function reasonForDecision(decision: RequestDecision, value: unknown) {
  if (decision === 'APPROVED') return '';
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'A reason is required when denying a request');
  return value.trim().slice(0, MAX_QUESTION_LENGTH);
}

/** What the player sees about their own requests. */
export function describeRequestStatus(status: string, reason: string) {
  if (status === 'PENDING') return 'In review';
  if (status === 'APPROVED') return 'Approved · waiting for prediction to go live';
  return `Denied · ${reason}`;
}
