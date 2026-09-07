import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { PREDICTION_SLOTS, validatePrediction } from '../lib/pak-een-zes';
import { wrap } from './_wrap';

/**
 * Save a player's four Pak een Zes picks.
 *
 * Duplicates are the point, not an edge case: naming the same person twice is a real
 * strategy and picking yourself is allowed, so the picks are stored one row per slot
 * and never de-duplicated. "Daan, Twan, Daan, Bas" stays four picks.
 *
 * Re-submitting replaces the whole prediction, so a player can change their mind while
 * predictions are open. Once the host closes them the window is shut — a late
 * prediction would be a prediction about something already under way.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const session = await requirePlayer(request, gameId);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (Number(game.rows[0].current_round_block_id || 0) !== blockId) throw new HttpError(409, 'Pak een Zes is not the live content block');

    const blockResult = await client.query(
      `SELECT b.id,b.round_id,b.type,r.status AS round_status
       FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.game_night_id=$2`,
      [blockId, gameId],
    );
    const block = blockResult.rows[0];
    if (!block) throw new HttpError(404, 'Pak een Zes block not found');
    if (block.type !== 'PAK_EEN_ZES') throw new HttpError(409, 'Block is not a Pak een Zes');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== Number(block.round_id)) {
      throw new HttpError(409, 'The Pak een Zes round is not active');
    }

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');

    const existing = await client.query(
      `SELECT id,status FROM pak_een_zes_games
       WHERE game_night_id=$1 AND round_block_id=$2
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [gameId, blockId],
    );
    const current = existing.rows[0];
    if (!current) throw new HttpError(409, 'Predictions are not open yet');
    if (current.status !== 'PREDICTING') throw new HttpError(409, 'Predictions are closed');
    const pakEenZesGameId = Number(current.id);

    // Anyone active can be named, whether or not they have predicted themselves.
    const eligible = await client.query(
      'SELECT id FROM players WHERE game_night_id=$1 AND active=TRUE',
      [gameId],
    );
    const eligibleIds = eligible.rows.map((r: any) => Number(r.id));

    let picks: number[];
    try {
      picks = validatePrediction(p.picks, eligibleIds);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }

    // Replace rather than merge, so a re-submission cannot leave a stale slot behind.
    await client.query(
      'DELETE FROM pak_een_zes_predictions WHERE pak_een_zes_game_id=$1 AND player_id=$2',
      [pakEenZesGameId, session.playerId],
    );
    for (let slot = 0; slot < PREDICTION_SLOTS; slot += 1) {
      await client.query(
        `INSERT INTO pak_een_zes_predictions(pak_een_zes_game_id,player_id,slot,predicted_player_id)
         VALUES($1,$2,$3,$4)`,
        [pakEenZesGameId, session.playerId, slot + 1, picks[slot]],
      );
    }

    return { saved: true, picks, version: await incrementGameVersion(client, gameId) };
  }));
});
