import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreen } from '../lib/game-state';
import { lockRound } from '../lib/rounds';
import { enterRound } from '../lib/round-lifecycle';
import { initialScreenTarget } from '../lib/screen-flow';
import { wrap } from './_wrap';

/**
 * Start a round.
 *
 * Three things, in one transaction: the round becomes ACTIVE, its own runtime is prepared,
 * and the projector is pointed at it.
 *
 * That last one is a deliberate reversal. Starting used to leave the big screen alone, on
 * the principle that progression and presentation are separate concerns — which they are,
 * and still are. But in practice every round began with a dashboard on the wall and a
 * second click to fix it, and the two ideas being separate is not a reason to make the
 * host say the same thing twice. Starting a round is now *defined* as including the
 * presentation decision, and `initialScreenTarget` is the one place that decides what each
 * type opens on, so no frontend has to guess.
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

    // A round with nothing to show — an empty presentation, a quiz with no questions —
    // returns null and leaves the screen alone rather than opening on a blank scene.
    const target = await initialScreenTarget(client, gameId, roundId, round.type);
    if (target) await setScreen(client, gameId, target, admin.username);

    const opened = await client.query(
      `UPDATE predictions
       SET status='OPEN',opened_at=NOW(),closes_at=NOW()+(prediction_time_seconds::text||' seconds')::interval,updated_at=NOW()
       WHERE game_night_id=$1 AND round_id=$2 AND status='SCHEDULED'
       RETURNING id`,
      [gameId, roundId],
    );

    await audit(client, gameId, admin.username, `started round ${round.sortOrder} (${round.type})`, 'round', roundId, {
      openedPredictions: opened.rowCount,
      shownOnScreen: target?.kind ?? null,
    });
    return {
      openedPredictions: opened.rowCount,
      shownOnScreen: target?.kind ?? null,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
