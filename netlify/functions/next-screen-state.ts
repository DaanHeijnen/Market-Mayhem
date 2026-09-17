import { requireAdmin } from '../lib/auth';
import { database } from '../lib/db';
import { ok, HttpError } from '../lib/http';
import { resolveScreenTarget } from '../lib/game-state';
import { planStep, navigationCapabilities, type NavigationDirection, type ScreenStep } from '../lib/screen-flow';
import { getScreenState } from '../lib/queries';
import { wrap, gameIdFrom } from './_wrap';

/**
 * What the projector will show if the host presses NEXT — or PREVIOUS.
 *
 * The honest version of the old staged card, which described the next step in the Admin's
 * own words and could therefore be wrong about it. This asks `planStep` for the step the
 * button would actually take and then renders it through `getScreenState`, the projector's
 * own snapshot builder, so the preview and the real screen cannot disagree: they are the
 * same DTO fed to the same components.
 *
 * Read-only. It resolves the target the way applying it would — same type checks, same
 * refusal for a hidden page — but writes nothing, so the Admin can poll it.
 */
export default wrap(async request => {
  await requireAdmin(request);
  const gameId = gameIdFrom(request);
  const url = new URL(request.url);
  const direction = String(url.searchParams.get('direction') || 'NEXT').toUpperCase() as NavigationDirection;
  if (!['NEXT', 'PREVIOUS'].includes(direction)) throw new HttpError(400, 'direction must be NEXT or PREVIOUS');

  const pool = database().pool;
  const active = await pool.query(
    `SELECT r.type FROM rounds r JOIN game_nights g ON g.current_round_id=r.id WHERE g.id=$1 AND r.status='ACTIVE'`,
    [gameId],
  );
  const capabilities = navigationCapabilities(active.rows[0]?.type ?? null);

  // Both directions in one request. The Admin needs the preview for one of them and the
  // button state for both, and asking twice on every poll would double the work for an
  // answer that comes from the same read.
  //
  // planStep only reads, so it runs on the pool rather than opening a transaction for a
  // question the Admin asks on every poll.
  const [step, other] = await Promise.all([
    planStep(pool as any, gameId, direction),
    planStep(pool as any, gameId, direction === 'NEXT' ? 'PREVIOUS' : 'NEXT'),
  ]);

  const describe = (s: ScreenStep) => ({
    // "Available" is the server's answer, so the button is disabled because the step is
    // impossible rather than because the frontend guessed.
    available: s.kind !== 'none',
    step: s.kind,
    label: s.kind === 'none' ? null : s.label,
    reason: s.kind === 'none' ? s.reason : null,
  });

  const directions = {
    [direction]: describe(step),
    [direction === 'NEXT' ? 'PREVIOUS' : 'NEXT']: describe(other),
  } as Record<NavigationDirection, ReturnType<typeof describe>>;

  if (step.kind !== 'target') {
    return ok({ direction, capabilities, ...describe(step), directions, preview: null });
  }

  const resolved = await resolveScreenTarget(pool as any, gameId, step.target);
  const preview = await getScreenState(gameId, {
    mode: resolved.mode,
    roundId: resolved.roundId,
    quizQuestionId: resolved.quizQuestionId,
    slideId: resolved.slideId,
    pubquizQuestionId: resolved.pubquizQuestionId,
    predictionId: resolved.predictionId,
    // The step may be "reveal what is already up". The preview renders it as it will be,
    // through the same DTO, rather than as it is.
    previewReveal: step.reveal === true,
    // `false` rather than absent when stepping back off the photo: the preview has to show
    // the answer without it, which is not the same as "leave the row alone".
    previewContext: step.showContext === true ? true : (step.hideContext === true ? false : undefined),
  });

  return ok({ direction, capabilities, ...describe(step), directions, preview });
}, 'GET');
