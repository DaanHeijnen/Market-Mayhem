import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const groupId = intValue(p.groupId, 'groupId', { min: 1 });
  if (!Array.isArray(p.playerIds)) throw new HttpError(400, 'playerIds must be an array');
  const playerIds = p.playerIds.map((v: unknown) => intValue(v, 'playerId', { min: 1 }));
  if (new Set(playerIds).size !== playerIds.length) throw new HttpError(400, 'playerIds contains duplicates');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const group = await client.query(`SELECT g.round_id,r.status AS round_status FROM round_groups g JOIN rounds r ON r.id=g.round_id WHERE g.id=$1 AND g.game_night_id=$2 FOR UPDATE OF g,r`, [groupId, gameId]);
    if (!group.rows[0]) throw new HttpError(404, 'Round group not found');
    const roundId = Number(group.rows[0].round_id);
    if (group.rows[0].round_status === 'COMPLETED') throw new HttpError(409, 'Completed round group membership is read-only');
    if (playerIds.length) {
      const players = await client.query('SELECT id FROM players WHERE game_night_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE', [gameId, playerIds]);
      if (players.rowCount !== playerIds.length) throw new HttpError(400, 'Every group member must belong to this game');
    }
    await client.query('DELETE FROM round_group_members WHERE group_id=$1', [groupId]);
    for (const playerId of playerIds) {
      // A player belongs to at most one group inside the same round.
      await client.query('DELETE FROM round_group_members WHERE round_id=$1 AND player_id=$2', [roundId, playerId]);
      await client.query('INSERT INTO round_group_members(group_id,game_night_id,round_id,player_id) VALUES($1,$2,$3,$4)', [groupId, gameId, roundId, playerId]);
    }
    await audit(client, gameId, admin.username, 'updated round group members', 'round_group', groupId, { roundId, playerIds });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
