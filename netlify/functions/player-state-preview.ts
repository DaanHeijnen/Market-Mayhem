import { getPlayerState } from '../lib/queries';
import { requireAdmin } from '../lib/auth';
import { ok, intValue } from '../lib/http';
import { wrap, gameIdFrom } from './_wrap';

/**
 * The exact payload `player-state` returns for one player, read with Admin
 * authority so the host can see what a phone currently shows.
 *
 * Deliberately an Admin-authenticated read rather than an impersonated player
 * session. Minting a real player session for the Admin would be new auth surface,
 * and because the preview is a same-origin view it would overwrite the
 * `mm_player_session` cookie of anyone also joined as a player in another tab.
 *
 * getPlayerState scopes its lookup to `game_night_id` and active players, so an
 * arbitrary playerId cannot read across games — it 404s.
 */
export default wrap(async (request) => {
  await requireAdmin(request);
  const gameId = gameIdFrom(request);
  const playerId = intValue(new URL(request.url).searchParams.get('playerId'), 'playerId', { min: 1 });
  return ok(await getPlayerState(gameId, playerId));
}, 'GET');
