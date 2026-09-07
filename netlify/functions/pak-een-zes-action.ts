import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { canTransition, type PakEenZesStatus } from '../lib/pak-een-zes';
import { wrap } from './_wrap';

const ACTIONS = {
  OPEN_PREDICTIONS: 'PREDICTING',
  CLOSE_PREDICTIONS: 'LOCKED',
  START: 'DRAWING',
} as const;

type Action = keyof typeof ACTIONS;

/**
 * The host's Pak een Zes controls: open predictions, close them, start the game.
 *
 * The phases are a state machine rather than free-form flags, so the flow can only run
 * forwards and the projector can never be showing "predict now" while cards are already
 * being drawn. The host is explicitly *not* required to wait for everyone — closing is
 * allowed with predictions missing — which is why the surfaces show who is still absent
 * instead of blocking here.
 *
 * Starting is what freezes the turn order: the participants are snapshotted at that
 * moment, so someone joining or being deactivated later cannot reshuffle whose turn it
 * is halfway through.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as Action;
  if (!(action in ACTIONS)) throw new HttpError(400, 'Invalid Pak een Zes action');
  const target = ACTIONS[action] as PakEenZesStatus;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    if (Number(game.rows[0].current_round_block_id || 0) !== blockId) throw new HttpError(409, 'Show this Pak een Zes block before running it');

    const blockResult = await client.query(
      `SELECT b.id,b.round_id,b.type,r.status AS round_status
       FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.game_night_id=$2 FOR UPDATE OF b`,
      [blockId, gameId],
    );
    const block = blockResult.rows[0];
    if (!block) throw new HttpError(404, 'Pak een Zes block not found');
    if (block.type !== 'PAK_EEN_ZES') throw new HttpError(409, 'Block is not a Pak een Zes');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== Number(block.round_id)) {
      throw new HttpError(409, 'The Pak een Zes round is not active');
    }

    // Create the game on first use rather than when the block is authored, so an
    // unplayed block carries no state.
    await client.query(
      `INSERT INTO pak_een_zes_games(game_night_id,round_id,round_block_id,status)
       SELECT $1,$2,$3,'READY'
       WHERE NOT EXISTS (
         SELECT 1 FROM pak_een_zes_games
         WHERE game_night_id=$1 AND round_block_id=$3 AND status IN ('READY','PREDICTING','LOCKED','DRAWING')
       )`,
      [gameId, Number(block.round_id), blockId],
    );

    const existing = await client.query(
      `SELECT id,status FROM pak_een_zes_games
       WHERE game_night_id=$1 AND round_block_id=$2
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [gameId, blockId],
    );
    const current = existing.rows[0];
    if (!current) throw new HttpError(409, 'Pak een Zes game could not be created');
    const status = current.status as PakEenZesStatus;
    const pakEenZesGameId = Number(current.id);

    // Replaying the same action is a no-op rather than an error: the host tapping twice
    // on a slow connection should not be told something went wrong.
    if (status === target) return { duplicate: true, status };
    if (!canTransition(status, target)) throw new HttpError(409, `Cannot ${action} while the game is ${status}`);

    if (target === 'PREDICTING') {
      await client.query(
        "UPDATE pak_een_zes_games SET status='PREDICTING',predictions_opened_at=NOW(),updated_at=NOW() WHERE id=$1",
        [pakEenZesGameId],
      );
    }

    if (target === 'LOCKED') {
      await client.query(
        "UPDATE pak_een_zes_games SET status='LOCKED',predictions_closed_at=NOW(),updated_at=NOW() WHERE id=$1",
        [pakEenZesGameId],
      );
    }

    if (target === 'DRAWING') {
      // Freeze the turn order from the players active right now. Ordered by name so the
      // order is stable and readable rather than depending on row ids.
      const players = await client.query(
        'SELECT id FROM players WHERE game_night_id=$1 AND active=TRUE ORDER BY display_name,id',
        [gameId],
      );
      if (!players.rows.length) throw new HttpError(409, 'There are no active players to take turns');
      await client.query('DELETE FROM pak_een_zes_participants WHERE pak_een_zes_game_id=$1', [pakEenZesGameId]);
      for (let index = 0; index < players.rows.length; index += 1) {
        await client.query(
          'INSERT INTO pak_een_zes_participants(pak_een_zes_game_id,player_id,turn_order) VALUES($1,$2,$3)',
          [pakEenZesGameId, Number(players.rows[index].id), index],
        );
      }
      await client.query(
        "UPDATE pak_een_zes_games SET status='DRAWING',turn_index=0,started_at=NOW(),updated_at=NOW() WHERE id=$1",
        [pakEenZesGameId],
      );
    }

    await audit(client, gameId, admin.username, `pak een zes ${action.toLowerCase()}`, 'round_block', blockId, {
      pakEenZesGameId,
      from: status,
      to: target,
    });
    return { status: target, version: await incrementGameVersion(client, gameId) };
  }));
});
