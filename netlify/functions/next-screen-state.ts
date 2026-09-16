import { requireAdmin } from '../lib/auth';
import { database } from '../lib/db';
import { ok, HttpError } from '../lib/http';
import { resolveScreenTarget } from '../lib/game-state';
import { planStep, navigationCapabilities, type NavigationDirection } from '../lib/screen-flow';
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

  // planStep only reads, so it runs on the pool rather than opening a transaction for a
  // question the Admin asks on every poll.
  const step = await planStep(pool as any, gameId, direction);

  if (step.kind !== 'target') {
    return ok({
      direction,
      capabilities,
      step: step.kind,
      label: step.kind === 'completeRound' ? step.label : null,
      reason: step.kind === 'none' ? step.reason : null,
      preview: null,
    });
  }

  const resolved = await resolveScreenTarget(pool as any, gameId, step.target);
  const preview = await getScreenState(gameId, {
    mode: resolved.mode,
    roundId: resolved.roundId,
    quizQuestionId: resolved.quizQuestionId,
    slideId: resolved.slideId,
    pubquizQuestionId: resolved.pubquizQuestionId,
    predictionId: resolved.predictionId,
  });

  return ok({ direction, capabilities, step: 'target', label: step.label, reason: null, preview });
}, 'GET');
