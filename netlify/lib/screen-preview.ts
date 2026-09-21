import type { PoolClient } from 'pg';
import { resolveScreenTarget } from './game-state';
import { getScreenState } from './queries';
import { planStep, navigationCapabilities, type NavigationDirection, type ScreenStep } from './screen-flow';

/**
 * What the projector will show if the host presses VOLGENDE — or VORIGE.
 *
 * The honest version of the old staged card, which described the next step in the Admin's
 * own words and could therefore be wrong about it. This asks `planStep` for the step the
 * button would actually take and renders it through `getScreenState`, the projector's own
 * snapshot builder, so the preview and the real screen cannot disagree: same rule, same
 * DTO, same components.
 *
 * It lives here rather than in the route so that the composition itself is testable. A
 * preview assembled inside a Netlify Function is a preview no test can compare against the
 * screen it claims to predict, and "the preview is exactly what VOLGENDE publishes" is the
 * one property that matters most about it.
 *
 * Read-only. It resolves the target the way applying it would — same type checks, same
 * refusal for a held-back page — but writes nothing, so the Admin can poll it.
 */

export type StepDescription = {
  /** The server's answer, so a button is disabled because the step is impossible. */
  available: boolean;
  step: ScreenStep['kind'];
  label: string | null;
  reason: string | null;
};

export function describeStep(step: ScreenStep): StepDescription {
  return {
    available: step.kind !== 'none',
    step: step.kind,
    label: step.kind === 'none' ? null : step.label,
    reason: step.kind === 'none' ? step.reason : null,
  };
}

export async function previewNavigation(
  client: PoolClient,
  gameId: number,
  direction: NavigationDirection,
) {
  const active = await client.query(
    `SELECT r.type FROM rounds r JOIN game_nights g ON g.current_round_id=r.id WHERE g.id=$1 AND r.status='ACTIVE'`,
    [gameId],
  );
  const capabilities = navigationCapabilities(active.rows[0]?.type ?? null);

  // Both directions in one request. The Admin needs the preview for one of them and the
  // button state for both, and asking twice on every poll would double the work for an
  // answer that comes from the same read.
  const opposite: NavigationDirection = direction === 'NEXT' ? 'PREVIOUS' : 'NEXT';
  const [step, other] = await Promise.all([
    planStep(client, gameId, direction),
    planStep(client, gameId, opposite),
  ]);

  const directions = {
    [direction]: describeStep(step),
    [opposite]: describeStep(other),
  } as Record<NavigationDirection, StepDescription>;

  if (step.kind !== 'target') {
    return { direction, capabilities, ...describeStep(step), directions, preview: null };
  }

  const resolved = await resolveScreenTarget(client, gameId, step.target);
  const preview = await getScreenState(gameId, {
    mode: resolved.mode,
    roundId: resolved.roundId,
    quizQuestionId: resolved.quizQuestionId,
    slideId: resolved.slideId,
    pubquizQuestionId: resolved.pubquizQuestionId,
    predictionId: resolved.predictionId,
    // The step may be "reveal what is already up", or — stepping back over a presentation
    // page's answer — "put it away again". The preview renders the page as it will be,
    // through the same DTO, rather than as it is. `undefined` when the step changes
    // neither, which leaves the stored reveal alone.
    previewReveal: step.reveal === true ? true : (step.unreveal === true ? false : undefined),
    previewOpen: step.open === true,
    // `false` rather than absent when stepping back off the photo: the preview has to show
    // the answer without it, which is not the same as "leave the row alone".
    previewContext: step.showContext === true ? true : (step.hideContext === true ? false : undefined),
  });

  return { direction, capabilities, ...describeStep(step), directions, preview };
}
