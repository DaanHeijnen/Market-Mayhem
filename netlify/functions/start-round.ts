import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const roundId = intValue(payload.roundId, 'roundId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const round = await client.query(
      'SELECT round_number,status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [roundId, gameId],
    );
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status !== 'UPCOMING') throw new HttpError(409, 'Only upcoming rounds can be started');

    const active = await client.query(
      `SELECT id,round_number FROM rounds
       WHERE game_night_id=$1 AND status='ACTIVE' AND id<>$2
       FOR UPDATE`,
      [gameId, roundId],
    );
    if (active.rows[0]) {
      throw new HttpError(409, `Complete R${active.rows[0].round_number} before starting another round`);
    }

    await client.query(
      `UPDATE rounds
       SET status='ACTIVE', started_at=NOW(), completed_at=NULL, updated_at=NOW()
       WHERE id=$1`,
      [roundId],
    );
    await client.query(
      'UPDATE game_nights SET current_round_id=$2,updated_at=NOW() WHERE id=$1',
      [gameId, roundId],
    );
    await setScreenMode(client, gameId, 'ROUND_STARTED', admin.username, roundId, null);
    await audit(client, gameId, admin.username, `started R${round.rows[0].round_number}`, 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
