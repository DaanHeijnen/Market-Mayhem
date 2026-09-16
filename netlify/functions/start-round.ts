import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound } from '../lib/rounds';
import { enterRound } from '../lib/round-lifecycle';
import { wrap } from './_wrap';

/**
 * Start a round.
 *
 * Changes progression only. Scheduled markets open for phones in the background and the
 * round's own runtime is prepared, but the projector stays exactly where it was until the
 * Admin explicitly shows something — `enterRound` writes no screen state and this handler
 * does not call `setScreen`.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const round = await lockRound(client, gameId, roundId);
    if (round.status !== 'UPCOMING') throw new HttpError(409, 'Only upcoming rounds can be started');

    // Locked before the status write, so two admins pressing START on two rounds at once
    // queue up rather than both passing the check. The partial unique index is the
    // backstop if they somehow do.
    const active = await client.query(
      "SELECT sort_order,title FROM rounds WHERE game_night_id=$1 AND status='ACTIVE' AND id<>$2 FOR UPDATE",
      [gameId, roundId],
    );
    if (active.rows[0]) {
      throw new HttpError(409, `Complete round ${active.rows[0].sort_order} (${active.rows[0].title}) before starting another`);
    }

    await client.query(
      "UPDATE rounds SET status='ACTIVE',started_at=NOW(),completed_at=NULL,updated_at=NOW() WHERE id=$1 AND status='UPCOMING'",
      [roundId],
    );
    await client.query('UPDATE game_nights SET current_round_id=$2,updated_at=NOW() WHERE id=$1', [gameId, roundId]);

    await enterRound(client, gameId, roundId, round.type);

    const opened = await client.query(
      `UPDATE predictions
       SET status='OPEN',opened_at=NOW(),closes_at=NOW()+(prediction_time_seconds::text||' seconds')::interval,updated_at=NOW()
       WHERE game_night_id=$1 AND round_id=$2 AND status='SCHEDULED'
       RETURNING id`,
      [gameId, roundId],
    );

    await audit(client, gameId, admin.username, `started round ${round.sortOrder} (${round.type})`, 'round', roundId, {
      openedPredictions: opened.rowCount,
    });
    return { openedPredictions: opened.rowCount, version: await incrementGameVersion(client, gameId) };
  }));
});
