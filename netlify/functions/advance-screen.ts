import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { advanceScreen, type NavigationDirection } from '../lib/screen-flow';
import { wrap } from './_wrap';

/**
 * Step the projector forward or back.
 *
 * This is what replaced staging plus GO LIVE. NEXT means the next thing is on the big
 * screen, now — there is no intermediate state in which the host has chosen something the
 * room cannot see yet, because that state is what made the old preview untrustworthy.
 *
 * `revision` is the big screen's own revision as the Admin last saw it. A step from a tab
 * that has fallen behind is refused rather than dragging the room back to where that tab
 * thought the evening was. The screen rather than the round cursor, because the intro and
 * the round-ending step belong to no item inside a round.
 */
const DIRECTIONS: NavigationDirection[] = ['NEXT', 'PREVIOUS'];

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const direction = String(p.direction || '').toUpperCase() as NavigationDirection;
  if (!DIRECTIONS.includes(direction)) throw new HttpError(400, 'direction must be NEXT or PREVIOUS');
  const expectedRevision = p.revision == null ? null : intValue(p.revision, 'revision', { min: 0 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const result = await advanceScreen(client, gameId, direction, admin.username, expectedRevision);
    await audit(client, gameId, admin.username, `screen ${direction.toLowerCase()}`, 'screen', result.roundId, {
      outcome: result.kind,
    });
    return { ...result, version: await incrementGameVersion(client, gameId) };
  }));
});
