import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

/**
 * Save the Pak een Zes scoring rate: one game-wide amount per correct prediction.
 *
 * Its own endpoint rather than a field on update-settings, the same way the slotmachine
 * configuration has its own — Settings edits and saves each game's section
 * independently, so one save must not have to resend the others.
 *
 * Changing this never rewrites a game that already paid out: the rate is snapshotted
 * onto the game row when it finishes.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  // Zero is allowed: a host may want the prediction to be for pride alone.
  const pointsPerCorrect = intValue(p.pointsPerCorrect, 'pointsPerCorrect', { min: 0, max: 1_000_000 });

  return ok(await withTransaction(async client => {
    const updated = await client.query(
      'UPDATE game_nights SET pak_een_zes_points_per_correct=$2,updated_at=NOW() WHERE id=$1 RETURNING id',
      [gameId, pointsPerCorrect],
    );
    if (!updated.rows[0]) throw new HttpError(404, 'Game not found');
    await audit(client, gameId, admin.username, 'updated Pak een Zes scoring', 'game', gameId, { pointsPerCorrect });
    return { pointsPerCorrect, version: await incrementGameVersion(client, gameId) };
  }));
});
