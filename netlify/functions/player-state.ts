import { getPlayerState } from '../lib/queries';
import { requirePlayer } from '../lib/auth';
import { ok } from '../lib/http';
import { wrap, gameIdFrom } from './_wrap';

export default wrap(async (request) => {
  const gameId = gameIdFrom(request);
  const session = await requirePlayer(request, gameId);
  return ok(await getPlayerState(gameId, session.playerId));
}, 'GET');
