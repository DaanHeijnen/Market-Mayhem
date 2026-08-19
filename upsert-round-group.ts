import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const groupId = p.groupId == null ? null : intValue(p.groupId, 'groupId', { min: 1 });
  const name = textValue(p.name, 'name', 80);
  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await client.query('SELECT id,status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed round group structure is read-only; financial adjustments remain available');
    const nameClash = await client.query(
      `SELECT id FROM round_groups
       WHERE round_id=$1 AND game_night_id=$2 AND lower(name)=lower($3)
         AND ($4::bigint IS NULL OR id<>$4)
       LIMIT 1`,
      [roundId, gameId, name, groupId],
    );
    if (nameClash.rows[0]) throw new HttpError(409, 'A group with that name already exists in this round');
    let id = groupId;
    if (groupId) {
      const q = await client.query('UPDATE round_groups SET name=$4,updated_at=NOW() WHERE id=$1 AND round_id=$2 AND game_night_id=$3 RETURNING id', [groupId, roundId, gameId, name]);
      if (!q.rows[0]) throw new HttpError(404, 'Round group not found');
    } else {
      const q = await client.query('INSERT INTO round_groups(game_night_id,round_id,name) VALUES($1,$2,$3) RETURNING id', [gameId, roundId, name]);
      id = Number(q.rows[0].id);
    }
    await audit(client, gameId, admin.username, groupId ? 'renamed round group' : 'created round group', 'round_group', id || undefined, { roundId, name });
    return { groupId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
