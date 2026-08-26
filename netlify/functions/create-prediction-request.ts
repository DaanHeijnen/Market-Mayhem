import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { assertCanSubmit, normalizeQuestion } from '../lib/prediction-requests';
import { wrap } from './_wrap';

// A player proposes a market from their phone.
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const player = await requirePlayer(request, gameId);
  const question = normalizeQuestion(p.question);

  return ok(await withTransaction(async client => {
    // Lock the player's rows so two quick taps cannot both pass the cap check.
    const mine = await client.query(
      'SELECT created_at FROM prediction_requests WHERE game_night_id=$1 AND player_id=$2 ORDER BY created_at DESC FOR UPDATE',
      [gameId, player.playerId],
    );
    assertCanSubmit(mine.rowCount || 0, mine.rows[0]?.created_at ?? null);

    await client.query(
      'INSERT INTO prediction_requests(game_night_id,player_id,question) VALUES($1,$2,$3)',
      [gameId, player.playerId, question],
    );
    return { ok: true, version: await incrementGameVersion(client, gameId) };
  }));
});
