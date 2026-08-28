import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, numberValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { slotPositionValue, slotOutcomeLabel } from '../lib/slot';
import { slotStatus } from '../lib/slot-store';
import { wrap } from './_wrap';

const MAX_BATCH = 500;

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  if (p.clearAll === true) {
    return ok(await withTransaction(async client => {
      const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
      if (!game.rows[0]) throw new HttpError(404, 'Game not found');
      const removed = await client.query('DELETE FROM slot_outcomes WHERE game_night_id=$1 RETURNING id', [gameId]);
      await audit(client, gameId, admin.username, 'cleared slot outcome distribution', 'slot_outcomes', gameId, { removed: removed.rowCount });
      const snapshot = await slotStatus(client, gameId);
      return { cleared: removed.rowCount, status: snapshot.status, version: await incrementGameVersion(client, gameId) };
    }));
  }

  if (!Array.isArray(p.outcomes)) throw new HttpError(400, 'outcomes must be an array');
  if (p.outcomes.length === 0) throw new HttpError(400, 'outcomes must contain at least one combination');
  if (p.outcomes.length > MAX_BATCH) throw new HttpError(400, `outcomes may contain at most ${MAX_BATCH} combinations per save`);

  const seen = new Set<string>();
  const parsed = p.outcomes.map((raw: any, index: number) => {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, `outcomes[${index}] must be an object`);
    const reel1 = slotPositionValue(raw.reel1, `outcomes[${index}].reel1`);
    const reel2 = slotPositionValue(raw.reel2, `outcomes[${index}].reel2`);
    const reel3 = slotPositionValue(raw.reel3, `outcomes[${index}].reel3`);
    const key = `${reel1}-${reel2}-${reel3}`;
    if (seen.has(key)) throw new HttpError(400, `Combination ${slotOutcomeLabel(reel1, reel2, reel3)} appears more than once`);
    seen.add(key);
    const weight = intValue(raw.weight ?? 0, `outcomes[${index}].weight`, { min: 0, max: 1_000_000 });
    const payoutMultiplier = Number(numberValue(raw.payoutMultiplier ?? 0, `outcomes[${index}].payoutMultiplier`, { min: 0, max: 10_000 }).toFixed(2));
    return { reel1, reel2, reel3, weight, payoutMultiplier };
  });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    for (const outcome of parsed) {
      // A combination without weight and without payout carries no meaning, so
      // it is removed rather than stored as an empty row.
      if (outcome.weight === 0 && outcome.payoutMultiplier === 0) {
        await client.query(
          'DELETE FROM slot_outcomes WHERE game_night_id=$1 AND reel1_position=$2 AND reel2_position=$3 AND reel3_position=$4',
          [gameId, outcome.reel1, outcome.reel2, outcome.reel3],
        );
        continue;
      }
      await client.query(
        `INSERT INTO slot_outcomes (game_night_id,reel1_position,reel2_position,reel3_position,weight,payout_multiplier,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (game_night_id,reel1_position,reel2_position,reel3_position)
         DO UPDATE SET weight=EXCLUDED.weight,payout_multiplier=EXCLUDED.payout_multiplier,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [gameId, outcome.reel1, outcome.reel2, outcome.reel3, outcome.weight, outcome.payoutMultiplier, admin.username],
      );
    }

    await audit(client, gameId, admin.username, 'updated slot outcome distribution', 'slot_outcomes', gameId, { combinations: parsed.length });
    const snapshot = await slotStatus(client, gameId);
    return { saved: parsed.length, status: snapshot.status, version: await incrementGameVersion(client, gameId) };
  }));
});
