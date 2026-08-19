import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const groupId = intValue(p.groupId, 'groupId', { min: 1 });
  const amount = intValue(p.amount, 'amount');
  const reason = textValue(p.reason, 'reason', 300);
  const key = requestIdempotencyKey(request);
  if (amount === 0) throw new HttpError(400, 'amount cannot be zero');
  if (Math.abs(amount) > 1_000_000) throw new HttpError(400, 'amount is too large');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const group = await client.query(
      `SELECT g.round_id,g.name,r.status AS round_status
       FROM round_groups g JOIN rounds r ON r.id=g.round_id
       WHERE g.id=$1 AND g.game_night_id=$2 FOR UPDATE OF g,r`,
      [groupId, gameId],
    );
    if (!group.rows[0]) throw new HttpError(404, 'Round group not found');
    if (group.rows[0].round_status === 'UPCOMING') throw new HttpError(409, 'Group coin adjustments become available when the round starts');
    const roundId = Number(group.rows[0].round_id);
    const members = await client.query(
      `SELECT p.id,p.display_name,w.current_balance
       FROM round_group_members gm JOIN players p ON p.id=gm.player_id JOIN wallets w ON w.player_id=p.id
       WHERE gm.group_id=$1 AND gm.game_night_id=$2 ORDER BY p.id FOR UPDATE OF p,w`, [groupId, gameId],
    );
    if (!members.rowCount) throw new HttpError(409, 'Group has no players');

    // Treat the request idempotency key as one atomic group operation, not as
    // a collection of independent player operations. Without this guard, a
    // retry after the group's membership changed could apply the same logical
    // adjustment to newly-added members.
    const prior = await client.query(
      `SELECT player_id,amount,description,round_group_id,attributed_round_id
       FROM ledger_entries
       WHERE game_night_id=$1 AND transaction_type='GROUP_ADJUSTMENT'
         AND metadata->>'groupAdjustmentKey'=$2
       ORDER BY player_id`,
      [gameId, key],
    );
    if (prior.rowCount) {
      const memberIds = members.rows.map((m: any) => Number(m.id));
      const priorIds = prior.rows.map((r: any) => Number(r.player_id));
      const sameMembers = memberIds.length === priorIds.length && memberIds.every((id: number, index: number) => id === priorIds[index]);
      const samePayload = prior.rows.every((r: any) => Number(r.amount) === amount
        && r.description === reason
        && Number(r.round_group_id) === groupId
        && Number(r.attributed_round_id) === roundId);
      if (sameMembers && samePayload) return { duplicate: true };
      throw new HttpError(409, 'Idempotency key conflicts with a different group adjustment');
    }

    for (const member of members.rows) {
      const entryKey = `${key}:player:${member.id}`;
      const duplicate = await client.query('SELECT amount,description,round_group_id,attributed_round_id FROM ledger_entries WHERE game_night_id=$1 AND idempotency_key=$2', [gameId, entryKey]);
      if (duplicate.rows[0]) {
        const d = duplicate.rows[0];
        if (Number(d.amount) !== amount || d.description !== reason || Number(d.round_group_id) !== groupId || Number(d.attributed_round_id) !== roundId) throw new HttpError(409, 'Idempotency key conflicts with a different group adjustment');
        continue;
      }
      if (Number(member.current_balance) + amount < 0) throw new HttpError(409, `${member.display_name} does not have enough available coins`);
      await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [amount, member.id]);
      await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,round_group_id,created_by,idempotency_key,metadata)
         VALUES($1,$2,$3,'GROUP_ADJUSTMENT',$4,$5,$6,$7,$8,$9::jsonb)`,
        [gameId, member.id, amount, reason, roundId, groupId, admin.username, entryKey, JSON.stringify({ groupName: group.rows[0].name, groupAdjustmentKey: key })],
      );
    }
    await audit(client, gameId, admin.username, 'group wallet adjustment', 'round_group', groupId, { roundId, amount, reason, playerCount: members.rowCount });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
