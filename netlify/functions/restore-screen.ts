import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue } from '../lib/http';
import { incrementGameVersion, restorePreviousScreen } from '../lib/game-state';
import { wrap } from './_wrap';

// Return to whatever was on the projector before the host stepped away to show the
// market dashboard. Presentation only — the active round and block are untouched.
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });

  return ok(await withTransaction(async client => {
    await restorePreviousScreen(client, gameId, admin.username);
    await audit(client, gameId, admin.username, 'restored previous screen', 'screen');
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
