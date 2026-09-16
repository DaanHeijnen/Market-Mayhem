import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue } from '../lib/http';
import { incrementGameVersion, screenTargetFromRequest, setScreen } from '../lib/game-state';
import { wrap } from './_wrap';

/**
 * Put something on the projector, now.
 *
 * One endpoint for every scene, because choosing what the audience looks at is one
 * decision however many round types exist. What it may be pointed at is decided by
 * `setScreen`, which knows each round's type and refuses a mismatch — so this handler only
 * has to turn a request into a target.
 *
 * Replaces the old `screen-mode` and `set-active-round-block` pair, which between them let
 * a caller name a mode and a block independently and then had to check they agreed.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const target = screenTargetFromRequest(p);

  return ok(await withTransaction(async client => {
    // `remember` is the deliberate detour to the standings, so BACK TO RUN OF SHOW can
    // return to exactly this presentation.
    const resolved = await setScreen(client, gameId, target, admin.username, { remember: p.remember === true });
    await audit(client, gameId, admin.username, `showed ${resolved.mode}`, 'screen', resolved.roundId ?? undefined);
    return { mode: resolved.mode, version: await incrementGameVersion(client, gameId) };
  }));
});
