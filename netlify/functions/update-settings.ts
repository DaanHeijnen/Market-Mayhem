import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const name = textValue(payload.name, 'name', 120);
  const startingBalance = intValue(payload.startingBalance, 'startingBalance', { min: 0, max: 1000000 });

  return ok(await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE game_nights
          SET name=$2, starting_balance=$3, updated_at=NOW()
        WHERE id=$1
        RETURNING id`,
      [gameId, name, startingBalance],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Game not found');
    await audit(client, gameId, admin.username, 'updated game settings', 'game', gameId, { name, startingBalance });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
