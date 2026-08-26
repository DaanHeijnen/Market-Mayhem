import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue } from '../lib/http';
import { incrementGameVersion, promoteStaged } from '../lib/game-state';
import { wrap } from './_wrap';

// Push the staged step to the projector, then advance the preview to the next step.
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });

  return ok(await withTransaction(async client => {
    const result = await promoteStaged(client, gameId, admin.username);
    await audit(client, gameId, admin.username, `went live with ${result.liveKind || 'dashboard'}`, 'screen', result.liveId ?? undefined);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
