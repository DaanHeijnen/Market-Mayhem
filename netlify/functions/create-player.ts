import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, created, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const displayName = textValue(payload.displayName, 'displayName', 80);
  const color = typeof payload.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(payload.color) ? payload.color : '#3D5AFE';

  return created(await withTransaction(async (client) => {
    const game = await client.query('SELECT starting_balance FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const existing = await client.query('SELECT id, active FROM players WHERE game_night_id=$1 AND LOWER(display_name)=LOWER($2)', [gameId, displayName]);
    if (existing.rows[0]) throw new HttpError(409, 'A player with this name already exists');

    const player = await client.query(
      `INSERT INTO players(game_night_id,display_name,public_color,active)
       VALUES($1,$2,$3,TRUE) RETURNING id`,
      [gameId, displayName, color],
    );
    const playerId = Number(player.rows[0].id);
    const startingBalance = Number(game.rows[0].starting_balance);
    await client.query(
      'INSERT INTO wallets(player_id,game_night_id,current_balance) VALUES($1,$2,$3)',
      [playerId, gameId, startingBalance],
    );
    if (startingBalance > 0) {
      await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,created_by)
         VALUES($1,$2,$3,'STARTING_BALANCE','Starting balance',$4)`,
        [gameId, playerId, startingBalance, admin.username],
      );
    }
    await audit(client, gameId, admin.username, `created player ${displayName}`, 'player', playerId, { startingBalance });
    return { playerId, version: await incrementGameVersion(client, gameId) };
  }));
});
