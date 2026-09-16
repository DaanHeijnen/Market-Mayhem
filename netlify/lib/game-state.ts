import type { PoolClient } from 'pg';
import { HttpError, intValue } from './http';
import { SCENE_FOR_ROUND_TYPE, SCREEN_MODES, type ScreenMode, type RoundType } from './round-types';

/**
 * Presentation state: what the projector is showing.
 *
 * Deliberately independent of progression. Starting a round, advancing the round cursor
 * and settling a question all change *game* state and none of them touch this file; the
 * host decides what the audience looks at, explicitly, every time. The one exception is
 * deletion — content that no longer exists cannot stay on screen — and that is
 * `clearScreenIfReferences`, at the bottom.
 *
 * The pointers are typed columns (`round_id`, `quiz_question_id`, `slide_id`) rather than
 * an id fished out of a JSON payload, so a pointer at deleted content is cleaned up by a
 * foreign key instead of going stale.
 */

export { SCREEN_MODES };
export type { ScreenMode };

export function screenModeValue(value: unknown): ScreenMode {
  if (typeof value !== 'string' || !SCREEN_MODES.includes(value as ScreenMode)) {
    throw new HttpError(400, 'Invalid screen mode');
  }
  return value as ScreenMode;
}

/**
 * Read a screen target from a request body.
 *
 * Lives here rather than in one of the two endpoints that need it, because a Netlify
 * function is an entry point: importing one from another is a bundling accident waiting
 * to happen. `show-on-screen` and the NEXT/PREVIOUS step read the same shapes on purpose —
 * staging something the host could not then go live with would be a trap.
 */
export function screenTargetFromRequest(p: any): ScreenTarget {
  const kind = String(p?.kind || '');
  if (kind === 'dashboard') return { kind: 'dashboard' };
  if (kind === 'prediction') return { kind: 'prediction', predictionId: intValue(p.predictionId, 'predictionId', { min: 1 }) };
  if (kind === 'quizQuestion') {
    return {
      kind: 'quizQuestion',
      roundId: intValue(p.roundId, 'roundId', { min: 1 }),
      questionId: intValue(p.questionId, 'questionId', { min: 1 }),
    };
  }
  if (kind === 'slide') {
    return {
      kind: 'slide',
      roundId: intValue(p.roundId, 'roundId', { min: 1 }),
      slideId: intValue(p.slideId, 'slideId', { min: 1 }),
    };
  }
  if (kind === 'pubquizQuestion') {
    return {
      kind: 'pubquizQuestion',
      roundId: intValue(p.roundId, 'roundId', { min: 1 }),
      questionId: intValue(p.questionId, 'questionId', { min: 1 }),
    };
  }
  if (kind === 'round') return { kind: 'roundGame', roundId: intValue(p.roundId, 'roundId', { min: 1 }) };
  throw new HttpError(400, 'kind must be dashboard, round, quizQuestion, slide, pubquizQuestion or prediction');
}

export async function incrementGameVersion(client: PoolClient, gameId: number) {
  const { rows } = await client.query<{ game_state_version: string }>(
    `UPDATE game_nights SET game_state_version=game_state_version+1,updated_at=NOW() WHERE id=$1 RETURNING game_state_version`,
    [gameId],
  );
  if (!rows[0]) throw new HttpError(404, 'Game not found');
  return Number(rows[0].game_state_version);
}

/** What the projector can be pointed at. One shape per scene, so nothing is half-specified. */
export type ScreenTarget =
  | { kind: 'dashboard' }
  | { kind: 'quizQuestion'; roundId: number; questionId: number }
  | { kind: 'slide'; roundId: number; slideId: number }
  | { kind: 'pubquizQuestion'; roundId: number; questionId: number }
  | { kind: 'roundGame'; roundId: number }
  | { kind: 'prediction'; predictionId: number };

type ResolvedTarget = {
  mode: ScreenMode;
  roundId: number | null;
  predictionId: number | null;
  quizQuestionId: number | null;
  slideId: number | null;
  pubquizQuestionId: number | null;
};

/**
 * Turn a target into the row that will be written, refusing anything inconsistent.
 *
 * All the validation lives here rather than in each caller, so `setScreen`, `stageScreen`
 * and `restorePreviousScreen` cannot drift into three different ideas of what is legal.
 */
async function resolveTarget(
  client: PoolClient,
  gameId: number,
  target: ScreenTarget,
  options: { requireActiveRound: boolean },
): Promise<ResolvedTarget> {
  const blank: ResolvedTarget = { mode: 'DASHBOARD', roundId: null, predictionId: null, quizQuestionId: null, slideId: null, pubquizQuestionId: null };

  if (target.kind === 'dashboard') return blank;

  if (target.kind === 'prediction') {
    const { rows } = await client.query(
      `SELECT round_id,status,result,closes_at,(closes_at IS NOT NULL AND closes_at<=NOW()) AS expired
       FROM predictions WHERE id=$1 AND game_night_id=$2`,
      [target.predictionId, gameId],
    );
    if (!rows[0]) throw new HttpError(404, 'Prediction not found');
    const status = rows[0].status;
    const mode: ScreenMode = status === 'OPEN'
      ? 'PREDICTIONS_OPEN'
      : ['RESULT', 'SETTLED'].includes(status) ? 'PREDICTION_RESULT' : 'PREDICTION_LOCKED';
    if (options.requireActiveRound && mode === 'PREDICTIONS_OPEN' && (!rows[0].closes_at || rows[0].expired)) {
      throw new HttpError(409, 'Prediction timer has expired');
    }
    return {
      ...blank,
      mode,
      predictionId: target.predictionId,
      roundId: rows[0].round_id ? Number(rows[0].round_id) : null,
    };
  }

  const round = await client.query('SELECT id,type,status FROM rounds WHERE id=$1 AND game_night_id=$2', [target.roundId, gameId]);
  if (!round.rows[0]) throw new HttpError(404, 'Round not found');
  const type = round.rows[0].type as RoundType;

  // Staging is allowed for a round that has not started — the point of staging is to line
  // up what comes next. Going live is not: the audience must not be shown a round nobody
  // is playing.
  if (options.requireActiveRound && round.rows[0].status !== 'ACTIVE') {
    throw new HttpError(409, 'Only the active round can be presented');
  }

  const scene = SCENE_FOR_ROUND_TYPE[type];

  if (target.kind === 'quizQuestion') {
    if (type !== 'LIVE_QUIZ') throw new HttpError(409, `A ${type} round has no quiz questions to show`);
    const question = await client.query('SELECT id FROM live_quiz_questions WHERE id=$1 AND round_id=$2', [target.questionId, target.roundId]);
    if (!question.rows[0]) throw new HttpError(404, 'Question not found in this round');
    return { ...blank, mode: scene, roundId: target.roundId, quizQuestionId: target.questionId };
  }

  if (target.kind === 'slide') {
    if (type !== 'PRESENTATIE') throw new HttpError(409, `A ${type} round has no slides to show`);
    const slide = await client.query('SELECT id,hidden FROM presentation_slides WHERE id=$1 AND round_id=$2', [target.slideId, target.roundId]);
    if (!slide.rows[0]) throw new HttpError(404, 'Slide not found in this round');
    // The one place this is enforced, which is why it holds everywhere. Showing, staging,
    // going live and returning from the standings all resolve their target here, so a
    // hidden page cannot reach the projector by any route — including a command issued
    // before it was hidden, which now fails instead of overwriting the screen with it.
    if (slide.rows[0].hidden) {
      throw new HttpError(409, 'That page is hidden — make it visible before putting it on the big screen');
    }
    return { ...blank, mode: scene, roundId: target.roundId, slideId: target.slideId };
  }

  if (target.kind === 'pubquizQuestion') {
    if (type !== 'PUBQUIZ') throw new HttpError(409, `A ${type} round has no pubquiz questions to show`);
    const question = await client.query(
      'SELECT id,hidden FROM pubquiz_questions WHERE id=$1 AND round_id=$2',
      [target.questionId, target.roundId],
    );
    if (!question.rows[0]) throw new HttpError(404, 'Question not found in this round');
    // Same rule a held-back presentation page gets, enforced in the same one place: a
    // question the host has taken out of the run cannot reach the projector by any route,
    // including a command issued before it was held back.
    if (question.rows[0].hidden) {
      throw new HttpError(409, 'That question is hidden — make it visible before putting it on the big screen');
    }
    return { ...blank, mode: scene, roundId: target.roundId, pubquizQuestionId: target.questionId };
  }

  // A game round is shown whole: there is no sub-item to point at, the scene reads the
  // round's own runtime tables.
  if (type === 'LIVE_QUIZ' || type === 'PRESENTATIE' || type === 'PUBQUIZ') {
    throw new HttpError(409, `A ${type} round is shown one item at a time — name the question or slide`);
  }
  return { ...blank, mode: scene, roundId: target.roundId };
}

/**
 * What a target resolves to, without applying it.
 *
 * Exported so the Admin's next-state preview can be built from exactly the resolution the
 * real step would perform — same type checks, same hidden-page refusal — rather than from
 * a second reading of the same rules.
 */
export async function resolveScreenTarget(client: PoolClient, gameId: number, target: ScreenTarget) {
  return resolveTarget(client, gameId, target, { requireActiveRound: false });
}

/**
 * Put something on the projector.
 *
 * `remember` is for the deliberate "show the standings for a moment" detour, so BACK TO
 * RUN OF SHOW can restore this exact presentation afterwards. It is opt-in because the
 * other route to the dashboard is `clearScreenIfReferences`, which fires when the thing on
 * screen was deleted — and there is nothing there worth returning to.
 */
export async function setScreen(
  client: PoolClient,
  gameId: number,
  target: ScreenTarget,
  actor: string,
  options: { remember?: boolean } = {},
) {
  const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');

  if (options.remember) {
    await client.query(
      `UPDATE screen_state
       SET previous_mode=mode,previous_round_id=round_id,previous_prediction_id=prediction_id,
           previous_quiz_question_id=quiz_question_id,previous_slide_id=slide_id,
           previous_pubquiz_question_id=pubquiz_question_id,previous_payload=payload
       WHERE game_night_id=$1`,
      [gameId],
    );
  }

  const resolved = await resolveTarget(client, gameId, target, { requireActiveRound: true });

  await client.query(
    `INSERT INTO screen_state(game_night_id,mode,round_id,prediction_id,quiz_question_id,slide_id,pubquiz_question_id,payload,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8)
     ON CONFLICT(game_night_id) DO UPDATE SET
       mode=EXCLUDED.mode,round_id=EXCLUDED.round_id,prediction_id=EXCLUDED.prediction_id,
       quiz_question_id=EXCLUDED.quiz_question_id,slide_id=EXCLUDED.slide_id,
       pubquiz_question_id=EXCLUDED.pubquiz_question_id,
       -- The payload is presentational extras only (which Fotoronde photo is enlarged),
       -- and they belong to the scene that set them, so a new scene starts without them.
       payload='{}'::jsonb,updated_at=NOW(),updated_by=EXCLUDED.updated_by`,
    [gameId, resolved.mode, resolved.roundId, resolved.predictionId, resolved.quizQuestionId, resolved.slideId, resolved.pubquizQuestionId, actor],
  );
  await client.query('UPDATE game_nights SET current_screen_mode=$2,updated_at=NOW() WHERE id=$1', [gameId, resolved.mode]);

  // The round's cursor follows what the room is looking at.
  //
  // Progression and presentation stay two different concepts — the cursor is still per
  // round, still survives the round being taken off screen, and a dashboard detour does
  // not move it. But there is exactly one way to disagree about "which question are we
  // on", and it is having two places that answer it. Whenever the projector is pointed at
  // an item inside a round, that item is where the round is.
  if (resolved.roundId && (resolved.quizQuestionId || resolved.slideId || resolved.pubquizQuestionId)) {
    await client.query(
      `UPDATE round_runtime SET
         current_quiz_question_id=COALESCE($2::bigint,current_quiz_question_id),
         current_slide_id=COALESCE($3::bigint,current_slide_id),
         current_pubquiz_question_id=COALESCE($4::bigint,current_pubquiz_question_id),
         revision=revision+1,updated_at=NOW()
       WHERE round_id=$1`,
      [resolved.roundId, resolved.quizQuestionId, resolved.slideId, resolved.pubquizQuestionId],
    );
  }
  return resolved;
}

/** Merge presentational extras into the live payload without disturbing the pointers. */
export async function patchScreenPayload(client: PoolClient, gameId: number, patch: Record<string, unknown>) {
  await client.query(
    `UPDATE screen_state SET payload=payload || $2::jsonb,updated_at=NOW() WHERE game_night_id=$1`,
    [gameId, JSON.stringify(patch)],
  );
}

/**
 * Record what the host intends to show next.
 *
 * Almost side-effect free on purpose: it validates that the target exists and belongs to
 * this game, and nothing else. It does not require the round to be active and never
 * touches the live pointers — staging must never change what the audience is looking at.
 */
export async function stageScreen(client: PoolClient, gameId: number, target: ScreenTarget, actor: string) {
  const resolved = await resolveTarget(client, gameId, target, { requireActiveRound: false });
  await client.query(
    `INSERT INTO screen_state(game_night_id,mode,staged_mode,staged_round_id,staged_prediction_id,
       staged_quiz_question_id,staged_slide_id,updated_by)
     VALUES($1,'DASHBOARD',$2,$3,$4,$5,$6,$7)
     ON CONFLICT(game_night_id) DO UPDATE SET
       staged_mode=EXCLUDED.staged_mode,staged_round_id=EXCLUDED.staged_round_id,
       staged_prediction_id=EXCLUDED.staged_prediction_id,
       staged_quiz_question_id=EXCLUDED.staged_quiz_question_id,staged_slide_id=EXCLUDED.staged_slide_id,
       updated_at=NOW(),updated_by=EXCLUDED.updated_by`,
    [gameId, resolved.mode, resolved.roundId, resolved.predictionId, resolved.quizQuestionId, resolved.slideId, actor],
  );
  return resolved;
}

function targetFromRow(mode: string | null, roundId: unknown, predictionId: unknown, questionId: unknown, slideId: unknown, pubquizQuestionId: unknown = null): ScreenTarget | null {
  if (!mode) return null;
  if (mode === 'DASHBOARD') return { kind: 'dashboard' };
  const round = Number(roundId || 0) || null;
  if (questionId && round) return { kind: 'quizQuestion', roundId: round, questionId: Number(questionId) };
  if (slideId && round) return { kind: 'slide', roundId: round, slideId: Number(slideId) };
  if (pubquizQuestionId && round) return { kind: 'pubquizQuestion', roundId: round, questionId: Number(pubquizQuestionId) };
  if (predictionId) return { kind: 'prediction', predictionId: Number(predictionId) };
  if (round) return { kind: 'roundGame', roundId: round };
  return null;
}

/** Promote the staged step to live. */
export async function promoteStaged(client: PoolClient, gameId: number, actor: string) {
  const state = await client.query(
    `SELECT staged_mode,staged_round_id,staged_prediction_id,staged_quiz_question_id,staged_slide_id
     FROM screen_state WHERE game_night_id=$1 FOR UPDATE`,
    [gameId],
  );
  const row = state.rows[0];
  if (!row?.staged_mode) throw new HttpError(409, 'Nothing is staged');

  const target = targetFromRow(row.staged_mode, row.staged_round_id, row.staged_prediction_id, row.staged_quiz_question_id, row.staged_slide_id);
  if (!target) throw new HttpError(409, 'Staged item is incomplete');
  return setScreen(client, gameId, target, actor);
}

/** Return to the presentation saved by the last `remember` detour to the dashboard. */
export async function restorePreviousScreen(client: PoolClient, gameId: number, actor: string) {
  const state = await client.query(
    `SELECT previous_mode,previous_round_id,previous_prediction_id,previous_quiz_question_id,previous_slide_id,previous_pubquiz_question_id
     FROM screen_state WHERE game_night_id=$1 FOR UPDATE`,
    [gameId],
  );
  const row = state.rows[0];
  if (!row?.previous_mode) throw new HttpError(409, 'There is no previous screen to return to');

  const target = targetFromRow(row.previous_mode, row.previous_round_id, row.previous_prediction_id, row.previous_quiz_question_id, row.previous_slide_id, row.previous_pubquiz_question_id);
  if (!target) throw new HttpError(409, 'The previous screen can no longer be restored');

  await setScreen(client, gameId, target, actor);
  await client.query(
    `UPDATE screen_state SET previous_mode=NULL,previous_round_id=NULL,previous_prediction_id=NULL,
       previous_quiz_question_id=NULL,previous_slide_id=NULL,previous_pubquiz_question_id=NULL,previous_payload='{}'::jsonb
     WHERE game_night_id=$1`,
    [gameId],
  );
}

/**
 * Take deleted content off the projector.
 *
 * The one place presentation follows game state rather than the host, because the
 * alternative is a scene rendering a round, question or slide that no longer exists.
 */
export async function clearScreenIfReferences(
  client: PoolClient,
  gameId: number,
  actor: string,
  refs: { roundId?: number; questionId?: number; slideId?: number; pubquizQuestionId?: number; predictionId?: number },
) {
  const state = await client.query(
    'SELECT mode,round_id,prediction_id,quiz_question_id,slide_id,pubquiz_question_id FROM screen_state WHERE game_night_id=$1',
    [gameId],
  );
  const row = state.rows[0];
  if (!row) return;
  const matches = (refs.roundId && Number(row.round_id) === refs.roundId)
    || (refs.predictionId && Number(row.prediction_id) === refs.predictionId)
    || (refs.questionId && Number(row.quiz_question_id) === refs.questionId)
    || (refs.slideId && Number(row.slide_id) === refs.slideId)
    || (refs.pubquizQuestionId && Number(row.pubquiz_question_id) === refs.pubquizQuestionId);
  if (matches) await setScreen(client, gameId, { kind: 'dashboard' }, actor);
}
