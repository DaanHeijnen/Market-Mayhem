import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue } from '../lib/http';
import { incrementGameVersion, screenTargetFromRequest, stageScreen } from '../lib/game-state';
import { wrap } from './_wrap';

/**
 * Choose what the projector will show next, without changing what it shows now.
 *
 * Reads the same target shapes as the live endpoint, from the same helper: staging
 * something the host could not then go live with would be a trap.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const target = screenTargetFromRequest(p);

  return ok(await withTransaction(async client => {
    const resolved = await stageScreen(client, gameId, target, admin.username);
    await audit(client, gameId, admin.username, `staged ${resolved.mode}`, 'screen');
    return { mode: resolved.mode, version: await incrementGameVersion(client, gameId) };
  }));
});
