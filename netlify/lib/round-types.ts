/**
 * The round type vocabulary.
 *
 * A round has exactly one type and that type decides everything else about it: which
 * table holds its content, which editor the Admin sees, which state machine runs it,
 * which scene the projector may show, and what has to happen when the host leaves it.
 *
 * This module is the single place those facts are written down. Anything that needs to
 * branch on a round type reads it from here rather than re-listing the types, because a
 * list repeated in five files is a list that will disagree with itself.
 */

export const ROUND_TYPES = [
  'LIVE_QUIZ',
  'PRESENTATIE',
  'PUBQUIZ',
  'ROULETTE',
  'SLOTMACHINE',
  'PAK_EEN_ZES',
  'FOTORONDE',
] as const;

export type RoundType = typeof ROUND_TYPES[number];

export const ROUND_STATUSES = ['UPCOMING', 'ACTIVE', 'COMPLETED'] as const;
export type RoundStatus = typeof ROUND_STATUSES[number];

export function isRoundType(value: unknown): value is RoundType {
  return typeof value === 'string' && (ROUND_TYPES as readonly string[]).includes(value);
}

/**
 * The screen modes. Presentation is deliberately its own vocabulary: the projector shows
 * a *scene*, and which scene is legal depends on the round type but is not the same thing
 * as it — a LIVE_QUIZ round can be on screen as a question while the dashboard is showing
 * instead, and starting a round changes none of this.
 */
export const SCREEN_MODES = [
  'DASHBOARD',
  // The round's own title card: where every round starts, drawn from the round row.
  'ROUND_INTRO',
  'QUIZ_QUESTION',
  'SLIDE',
  'PUBQUIZ_QUESTION',
  'PREDICTIONS_OPEN',
  'PREDICTION_LOCKED',
  'PREDICTION_RESULT',
  'ROULETTE',
  'SLOTMACHINE',
  'PAK_EEN_ZES',
  'FOTORONDE',
] as const;

export type ScreenMode = typeof SCREEN_MODES[number];

/**
 * The one scene each round type is presented with.
 *
 * One entry per type rather than a set, so the projector can never be pointed at a
 * slotmachine round with the quiz scene. A LIVE_QUIZ and a PRESENTATIE additionally need
 * to say *which* question or slide, which is what the typed screen_state pointers carry.
 */
export const SCENE_FOR_ROUND_TYPE: Record<RoundType, ScreenMode> = {
  LIVE_QUIZ: 'QUIZ_QUESTION',
  PRESENTATIE: 'SLIDE',
  PUBQUIZ: 'PUBQUIZ_QUESTION',
  ROULETTE: 'ROULETTE',
  SLOTMACHINE: 'SLOTMACHINE',
  PAK_EEN_ZES: 'PAK_EEN_ZES',
  FOTORONDE: 'FOTORONDE',
};

/** Round types whose content is an ordered list the host steps through. */
export const STEPPED_ROUND_TYPES: RoundType[] = ['LIVE_QUIZ', 'PRESENTATIE', 'PUBQUIZ'];

export function isSteppedRound(type: RoundType) {
  return STEPPED_ROUND_TYPES.includes(type);
}

export const MAX_QUIZ_OPTIONS = 6;
export const MIN_QUIZ_OPTIONS = 2;
export const MAX_QUIZ_QUESTIONS = 50;
export const MAX_PRESENTATION_SLIDES = 50;

/**
 * A pubquiz question is a presentation page that happens to be a question, so it is bounded
 * like a presentation rather than like a quiz. The option bounds are the quiz's, because
 * that is what a phone can render as buttons.
 */
export const MAX_PUBQUIZ_QUESTIONS = 50;
