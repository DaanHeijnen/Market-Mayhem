import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (Number(game.rows[0].current_round_id || 0) !== roundId) throw new HttpError(409, 'Only the current active round can be completed');

    const round = await client.query('SELECT round_number,status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status !== 'ACTIVE') throw new HttpError(409, 'Only the active round can be completed');

    const livePred = await client.query(
      `SELECT display_number,status FROM predictions
       WHERE round_id=$1 AND status IN ('OPEN','LOCKED','RESULT') ORDER BY display_number LIMIT 1`,
      [roundId],
    );
    if (livePred.rows[0]) throw new HttpError(409, `Prediction #${livePred.rows[0].display_number} is still ${livePred.rows[0].status}`);

    const liveRoulette = await client.query(
      `SELECT id,status FROM roulette_games WHERE round_id=$1 AND status IN ('OPEN','LOCKED','RESULT') LIMIT 1`,
      [roundId],
    );
    if (liveRoulette.rows[0]) throw new HttpError(409, `Roulette #${liveRoulette.rows[0].id} is still ${liveRoulette.rows[0].status}`);

    // Draft roulette games have no money attached and should not survive a
    // completed round as stray operational state.
    await client.query(
      `UPDATE roulette_games SET status='CANCELLED',settled_at=NOW(),updated_at=NOW()
       WHERE round_id=$1 AND status='DRAFT'`,
      [roundId],
    );
    await client.query("UPDATE rounds SET status='COMPLETED',completed_at=NOW(),updated_at=NOW() WHERE id=$1", [roundId]);
    await client.query('UPDATE game_nights SET current_round_id=NULL,current_round_block_id=NULL,updated_at=NOW() WHERE id=$1', [gameId]);
    await setScreenMode(client, gameId, 'DASHBOARD', admin.username);
    await audit(client, gameId, admin.username, `completed R${round.rows[0].round_number}`, 'round', roundId);
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
