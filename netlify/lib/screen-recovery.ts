import type { PoolClient } from 'pg';
import type { ScreenTarget } from './game-state';
import type { RoundType } from './round-types';

/**
 * Getting the projector out of a state it cannot draw.
 *
 * `screen_state` points at content with foreign keys that are `ON DELETE SET NULL`. That
 * is the right choice — a pointer at deleted content must not keep the row alive — but it
 * leaves a shape nothing can render: `mode='SLIDE'` with no `slide_id`. The same happens
 * when a page is hidden while it is up, or when a round ends with the projector still
 * inside it.
 *
 * Before this, that shape reached the big screen and stayed there. The host's only way out
 * was to find something else to show, and if the round had been completed there was
 * nothing else to pick.
 *
 * Two halves, deliberately separate:
 *
 *   `isRenderable`      a pure check, used by the read path to degrade the *response*
 *                       without writing anything, so the projector heals on its next poll
 *   `recoverScreen`     the write, used by RESET SCHERM, which puts a valid target back
 *                       into the database
 *
 * The read path cannot write — it is a GET on a pool — and a read path that healed by
 * writing would also be a read path that could loop.
 */

/** Which modes need an item, and which pointer that is. */
const REQUIRED_POINTER: Record<string, 'round' | 'quizQuestion' | 'slide' | 'pubquizQuestion' | 'prediction' | null> = {
  DASHBOARD: null,
  ROUND_INTRO: 'round',
  QUIZ_QUESTION: 'quizQuestion',
  SLIDE: 'slide',
  PUBQUIZ_QUESTION: 'pubquizQuestion',
  PREDICTIONS_OPEN: 'prediction',
  PREDICTION_LOCKED: 'prediction',
  PREDICTION_RESULT: 'prediction',
  ROULETTE: 'round',
  SLOTMACHINE: 'round',
  PAK_EEN_ZES: 'round',
  FOTORONDE: 'round',
};

/**
 * Whether a snapshot can actually be drawn.
 *
 * Checked against the payload the snapshot carries rather than against the pointer alone:
 * a `slide_id` that survives while its row is gone, or a question the query could not
 * join, both produce a pointer that looks fine and a scene that is empty.
 */
export function isRenderable(snapshot: {
  mode: string;
  round?: unknown;
  roundIntro?: unknown;
  quizQuestion?: unknown;
  slide?: unknown;
  pubquizQuestion?: unknown;
  prediction?: unknown;
}) {
  const needs = REQUIRED_POINTER[snapshot.mode];
  if (needs === undefined) return false; // a mode this build does not know
  if (needs === null) return true;
  if (needs === 'round') return Boolean(snapshot.mode === 'ROUND_INTRO' ? snapshot.roundIntro : snapshot.round);
  if (needs === 'quizQuestion') return Boolean(snapshot.quizQuestion);
  if (needs === 'slide') return Boolean(snapshot.slide);
  if (needs === 'pubquizQuestion') return Boolean(snapshot.pubquizQuestion);
  return Boolean(snapshot.prediction);
}

/**
 * The best valid target available, in the order a host would want it.
 *
 *   1. where the round actually is — reconstructed from its own runtime cursor, so a quiz
 *      sitting on question four comes back to question four rather than to the beginning
 *   2. the active round's title card
 *   3. the dashboard, which always exists
 *
 * Never returns something it has not checked, so the result cannot need recovering again —
 * which is what keeps this from looping.
 */
export async function recoverScreenTarget(client: PoolClient, gameId: number): Promise<ScreenTarget> {
  const active = await client.query(
    `SELECT r.id,r.type FROM rounds r JOIN game_nights g ON g.current_round_id=r.id
     WHERE g.id=$1 AND r.status='ACTIVE'`,
    [gameId],
  );
  const round = active.rows[0];
  if (!round) return { kind: 'dashboard' };

  const roundId = Number(round.id);
  const type = round.type as RoundType;

  const runtime = await client.query(
    'SELECT current_quiz_question_id,current_slide_id,current_pubquiz_question_id FROM round_runtime WHERE round_id=$1',
    [roundId],
  );
  const cursor = runtime.rows[0] || {};

  // Each lookup confirms the row is still there *and* still part of the run, so a cursor
  // left on a page that was deleted or held back falls through to the intro rather than
  // producing a target that is invalid in a new way.
  if (type === 'LIVE_QUIZ' && cursor.current_quiz_question_id) {
    const { rows } = await client.query(
      'SELECT id FROM live_quiz_questions WHERE id=$1 AND round_id=$2',
      [Number(cursor.current_quiz_question_id), roundId],
    );
    if (rows[0]) return { kind: 'quizQuestion', roundId, questionId: Number(rows[0].id) };
  }

  if (type === 'PRESENTATIE' && cursor.current_slide_id) {
    const { rows } = await client.query(
      'SELECT id FROM presentation_slides WHERE id=$1 AND round_id=$2 AND hidden=FALSE',
      [Number(cursor.current_slide_id), roundId],
    );
    if (rows[0]) return { kind: 'slide', roundId, slideId: Number(rows[0].id) };
  }

  if (type === 'PUBQUIZ' && cursor.current_pubquiz_question_id) {
    const { rows } = await client.query(
      'SELECT id FROM pubquiz_questions WHERE id=$1 AND round_id=$2 AND hidden=FALSE',
      [Number(cursor.current_pubquiz_question_id), roundId],
    );
    if (rows[0]) return { kind: 'pubquizQuestion', roundId, questionId: Number(rows[0].id) };
  }

  // A game round's scene needs nothing but the round, which the query above confirmed.
  if (!['LIVE_QUIZ', 'PRESENTATIE', 'PUBQUIZ'].includes(type)) {
    return { kind: 'roundGame', roundId };
  }

  return { kind: 'roundIntro', roundId };
}
