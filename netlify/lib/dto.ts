/**
 * Explicit payload builders, one per audience.
 *
 * The projector URL is effectively public and a player's phone is not trusted either, so
 * what those two surfaces receive is built field by field from a row rather than derived
 * by taking the row and deleting the parts we remember are secret. The difference matters:
 * a "strip the secrets" serialiser leaks every field somebody adds later and forgets to
 * add to the strip list, while a builder leaks nothing it was not told to include.
 *
 * So there is no spread of a database row anywhere in this file. Each builder names its
 * fields, and a new column is invisible to players and the projector until someone adds a
 * line here on purpose.
 */

import { isRevealed, questionParticipation, type QuizQuestionStatus } from './live-quiz';
import { slideIsRevealed, slideTitleIsPublic } from './presentation';
import type { RoundType } from './round-types';

// ---------------------------------------------------------------------------
// Row shapes as they come out of the database. Loose on purpose: these describe
// what a query returns, not what anybody is allowed to see.
// ---------------------------------------------------------------------------

export type RoundRow = {
  id: number | string;
  game_night_id: number | string;
  sort_order: number | string;
  title: string;
  description: string | null;
  type: RoundType;
  status: string;
  instructions: string;
  default_points: number | string;
  started_at?: unknown;
  completed_at?: unknown;
};

export type QuizQuestionRow = {
  id: number | string;
  round_id: number | string;
  sort_order: number | string;
  prompt: string;
  body: string;
  points: number | string;
  time_limit_seconds: number | string | null;
  context_media_key: string | null;
  status?: string | null;
  opened_at?: unknown;
  closed_at?: unknown;
  revealed_at?: unknown;
  settled_at?: unknown;
  context_photo_shown?: boolean;
  revision?: number | string;
  answer_count?: number | string;
};

export type QuizOptionRow = {
  id: number | string;
  question_id: number | string;
  sort_order: number | string;
  text: string;
  is_correct: boolean;
};

export type SlideRow = {
  id: number | string;
  round_id: number | string;
  sort_order: number | string;
  title: string | null;
  body: string;
  media_key: string | null;
  media_kind: string | null;
  media_name: string | null;
  reveal_text: string | null;
  hide_title_until_reveal: boolean;
  revealed_at?: unknown;
  revision?: number | string;
};

export type SubjectRow = {
  id: number | string;
  round_id: number | string;
  sort_order: number | string;
  subject_key: string;
  label: string;
  points: number | string;
  reference_media_key: string | null;
};

const num = (value: unknown) => Number(value ?? 0);

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

/** Everything about a round the Admin is entitled to, which is everything. */
export function adminRound(row: RoundRow) {
  return {
    id: num(row.id),
    sortOrder: num(row.sort_order),
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    status: row.status,
    instructions: row.instructions ?? '',
    defaultPoints: num(row.default_points),
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

/**
 * What any non-admin surface may know about a round: which round it is and what it is
 * called. Not its description, which is the host's own planning note, and not its
 * instructions unless the round is actually running.
 */
export function publicRound(row: RoundRow | null | undefined) {
  if (!row) return null;
  return {
    id: num(row.id),
    sortOrder: num(row.sort_order),
    title: row.title,
    type: row.type,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// Live quiz
// ---------------------------------------------------------------------------

export function adminQuizQuestion(row: QuizQuestionRow, options: QuizOptionRow[], eligibleCount = 0) {
  return {
    id: num(row.id),
    roundId: num(row.round_id),
    sortOrder: num(row.sort_order),
    prompt: row.prompt,
    body: row.body ?? '',
    points: num(row.points),
    timeLimitSeconds: row.time_limit_seconds == null ? null : num(row.time_limit_seconds),
    contextMediaKey: row.context_media_key ?? null,
    status: (row.status ?? 'READY') as QuizQuestionStatus,
    openedAt: row.opened_at ?? null,
    closedAt: row.closed_at ?? null,
    revealedAt: row.revealed_at ?? null,
    settledAt: row.settled_at ?? null,
    contextPhotoShown: Boolean(row.context_photo_shown),
    revision: num(row.revision),
    answerCount: num(row.answer_count),
    participation: questionParticipation(num(row.answer_count), eligibleCount),
    options: options.map(option => ({
      id: num(option.id),
      sortOrder: num(option.sort_order),
      text: option.text,
      isCorrect: Boolean(option.is_correct),
    })),
  };
}

/**
 * The question as a phone may see it.
 *
 * Option texts travel from the start — they are the buttons. Which option is correct does
 * not, until the reveal, and neither does the context photo. `myOptionId` is this player's
 * own answer, which only they receive.
 */
export function playerQuizQuestion(
  row: QuizQuestionRow,
  options: QuizOptionRow[],
  mine: { optionId: number | null },
) {
  const status = (row.status ?? 'READY') as QuizQuestionStatus;
  const revealed = isRevealed(status);
  return {
    id: num(row.id),
    prompt: row.prompt,
    body: row.body ?? '',
    points: num(row.points),
    status,
    timeLimitSeconds: row.time_limit_seconds == null ? null : num(row.time_limit_seconds),
    closesAt: row.closed_at ?? null,
    options: options.map(option => ({
      id: num(option.id),
      sortOrder: num(option.sort_order),
      text: option.text,
      // Correctness is the answer. It appears here at the reveal and never before.
      ...(revealed ? { isCorrect: Boolean(option.is_correct) } : {}),
    })),
    myOptionId: mine.optionId,
    // Only meaningful once the answer is public; before that the phone is told nothing
    // it could use to work out whether it guessed right.
    myAnswerCorrect: revealed && mine.optionId != null
      ? options.some(o => Number(o.id) === mine.optionId && o.is_correct)
      : null,
  };
}

/**
 * The question as the projector may see it.
 *
 * Deliberately close to the player payload minus anything personal: there is no "my
 * answer" on a projector. The context photo key appears only once the host has both
 * revealed the answer and asked for the photo, so an early render has no file to name.
 */
export function screenQuizQuestion(row: QuizQuestionRow, options: QuizOptionRow[], eligibleCount = 0) {
  const status = (row.status ?? 'READY') as QuizQuestionStatus;
  const revealed = isRevealed(status);
  const showingPhoto = revealed && Boolean(row.context_photo_shown) && Boolean(row.context_media_key);
  return {
    id: num(row.id),
    prompt: row.prompt,
    body: row.body ?? '',
    points: num(row.points),
    status,
    options: options.map(option => ({
      id: num(option.id),
      sortOrder: num(option.sort_order),
      text: option.text,
      ...(revealed ? { isCorrect: Boolean(option.is_correct) } : {}),
    })),
    participation: questionParticipation(num(row.answer_count), eligibleCount),
    showingContextPhoto: showingPhoto,
    // The key itself, not merely a flag: withholding the key is what makes "never before
    // the reveal" structural rather than a UI promise.
    contextMediaKey: showingPhoto ? row.context_media_key : null,
  };
}

// ---------------------------------------------------------------------------
// Presentation slides
// ---------------------------------------------------------------------------

export function adminSlide(row: SlideRow) {
  return {
    id: num(row.id),
    roundId: num(row.round_id),
    sortOrder: num(row.sort_order),
    title: row.title ?? null,
    body: row.body ?? '',
    mediaKey: row.media_key ?? null,
    mediaKind: row.media_kind ?? null,
    mediaName: row.media_name ?? null,
    revealText: row.reveal_text ?? null,
    hideTitleUntilReveal: Boolean(row.hide_title_until_reveal),
    revealedAt: row.revealed_at ?? null,
    revision: num(row.revision),
  };
}

/**
 * A slide for the projector.
 *
 * The title is omitted entirely while it is the answer, and the reveal line is absent
 * until the host reveals — neither is sent as null-with-a-flag, because a value that is
 * not on the wire cannot be read off the wire.
 */
export function screenSlide(row: SlideRow) {
  const revealed = slideIsRevealed(row.revealed_at);
  const titleIsPublic = slideTitleIsPublic(Boolean(row.hide_title_until_reveal), row.revealed_at);
  return {
    id: num(row.id),
    sortOrder: num(row.sort_order),
    title: titleIsPublic ? (row.title ?? null) : null,
    titleHidden: !titleIsPublic,
    body: row.body ?? '',
    mediaKey: row.media_key ?? null,
    mediaKind: row.media_kind ?? null,
    revealed,
    ...(revealed && row.reveal_text ? { revealText: row.reveal_text } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fotoronde subjects
// ---------------------------------------------------------------------------

export function adminSubject(row: SubjectRow) {
  return {
    id: num(row.id),
    roundId: num(row.round_id),
    sortOrder: num(row.sort_order),
    key: row.subject_key,
    label: row.label,
    points: num(row.points),
    referenceMediaKey: row.reference_media_key ?? null,
  };
}

/**
 * What a team is asked to photograph.
 *
 * The reference image is the host's own note about what they are looking for, so it stays
 * out of both the phone and the projector payload — sending it would answer the question.
 */
export function publicSubject(row: SubjectRow) {
  return {
    id: num(row.id),
    sortOrder: num(row.sort_order),
    key: row.subject_key,
    label: row.label,
    points: num(row.points),
  };
}

// ---------------------------------------------------------------------------
// Roulette
// ---------------------------------------------------------------------------

export type RouletteRow = {
  id: number | string;
  round_id: number | string | null;
  status: string;
  result_number: number | string | null;
  spun_at?: unknown;
  public_bets?: unknown;
};

/**
 * The roulette table as the projector may see it.
 *
 * Built rather than spread, like everything else here — the row it replaces was a
 * `SELECT rg.*` going straight onto a public snapshot.
 *
 * `resultNumber` is the deliberate exception to "withhold until revealed": the wheel is a
 * CSS animation that spins seven turns and lands on the server-chosen pocket, so the
 * projector needs the number *while* the wheel is still `SPINNING`. Withholding it would
 * make the wheel jump to the answer instead of landing on it. The Admin is held back
 * from it instead, which is where an early reveal would actually matter — the host is
 * the one who could act on it. Anyone holding the projector URL can read the number for
 * the ~5.5s the animation runs; that is inherent to animating to a committed result and
 * is the reason the number is committed server-side in the first place.
 *
 * The chips carry a display name and a colour because the room is meant to see whose they
 * are. They carry no player id: the projector has no use for one, and an id is a handle
 * for anyone who reads the snapshot.
 */
export function screenRoulette(row: RouletteRow | null | undefined) {
  if (!row) return null;
  return {
    id: num(row.id),
    roundId: row.round_id == null ? null : num(row.round_id),
    status: row.status,
    resultNumber: row.result_number == null ? null : num(row.result_number),
    spunAt: row.spun_at ?? null,
    publicBets: (Array.isArray(row.public_bets) ? row.public_bets : []).map((bet: any) => ({
      id: num(bet?.id),
      displayName: bet?.displayName ?? null,
      color: bet?.color ?? null,
      betType: bet?.betType ?? null,
      selection: String(bet?.selection ?? ''),
      stake: num(bet?.stake),
    })),
  };
}
