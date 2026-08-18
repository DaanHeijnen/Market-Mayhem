import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const name = textValue(p.name, 'name', 120);
  const startingBalance = intValue(p.startingBalance, 'startingBalance', { min: 0, max: 1_000_000 });
  const maximumWalletPercentage = p.maximumWalletPercentage == null || p.maximumWalletPercentage === ''
    ? null
    : intValue(p.maximumWalletPercentage, 'maximumWalletPercentage', { min: 1, max: 100 });

  return ok(await withTransaction(async client => {
    const q = await client.query(
      `UPDATE game_nights SET name=$2,starting_balance=$3,maximum_wallet_percentage=$4,updated_at=NOW()
       WHERE id=$1 RETURNING id`,
      [gameId, name, startingBalance, maximumWalletPercentage],
    );
    if (!q.rows[0]) throw new HttpError(404, 'Game not found');
    await audit(client, gameId, admin.username, 'updated game settings', 'game', gameId, { name, startingBalance, maximumWalletPercentage });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
