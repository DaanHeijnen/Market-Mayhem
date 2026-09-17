import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreen } from '../lib/game-state';
import { recoverScreenTarget } from '../lib/screen-recovery';
import { wrap } from './_wrap';

/**
 * Put the projector back into a state it can draw.
 *
 * The authoritative fix, not a refresh: it writes a valid target into `screen_state`, so
 * the big screen, the Admin's LIVE pane and every phone all arrive at the same place on
 * their next poll. Refreshing the Admin browser would have fixed nothing, because the
 * broken state was in the database.
 *
 * It recovers *forwards* where it can. A quiz sitting on question four comes back to
 * question four, reconstructed from the round's own cursor — only when that cannot be
 * trusted does it fall back to the round's title card, and only when there is no round to
 * the dashboard. Nothing about the round's runtime is reset: no answer is reopened, no
 * reward is undone, no page is un-revealed. This moves a pointer.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const target = await recoverScreenTarget(client, gameId);
    const resolved = await setScreen(client, gameId, target, admin.username);

    await audit(client, gameId, admin.username, 'reset the big screen', 'screen', resolved.roundId ?? undefined, {
      recoveredTo: target.kind,
    });
    return {
      recoveredTo: target.kind,
      mode: resolved.mode,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
