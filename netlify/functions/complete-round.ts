import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { closeSlotSeriesForBlock } from '../lib/slot-state';
import { closePakEenZesForBlock } from '../lib/pak-een-zes-state';
import { closePhotoRoundForBlock } from '../lib/photo-round-state';
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


    const liveQuestion = await client.query(
      `SELECT id,interactive_status FROM round_blocks
       WHERE round_id=$1 AND type='DUOLINGO_QUESTION' AND interactive_status IN ('OPEN','CLOSED','REVEALED')
       ORDER BY sort_order,id LIMIT 1`,
      [roundId],
    );
    if (liveQuestion.rows[0]) throw new HttpError(409, `Live question #${liveQuestion.rows[0].id} is still ${liveQuestion.rows[0].interactive_status}`);
    const liveRoulette = await client.query(
      `SELECT id,status FROM roulette_games WHERE round_id=$1 AND status IN ('OPEN','LOCKED','SPINNING','RESULT') LIMIT 1`,
      [roundId],
    );
    if (liveRoulette.rows[0]) throw new HttpError(409, `Roulette #${liveRoulette.rows[0].id} is still ${liveRoulette.rows[0].status}`);

    // Slotmachine series are closed out rather than blocking completion, and unspun
    // spins are refunded. Same reasoning as changing content block: the host must be
    // able to end the round even if a player locked twenty spins and wandered off, and
    // no coins are lost by doing so.
    const slotBlocks = await client.query(
      "SELECT id FROM round_blocks WHERE round_id=$1 AND type='SLOTMACHINE' ORDER BY sort_order,id",
      [roundId],
    );
    for (const slotBlock of slotBlocks.rows) {
      await closeSlotSeriesForBlock(client, gameId, Number(slotBlock.id), admin.username, 'round completed');
    }

    // A Pak een Zes in progress is closed rather than blocking completion. Nothing
    // financial is at stake, and its draws and predictions are preserved so a later
    // scoring pass still has the full record.
    const pakBlocks = await client.query(
      "SELECT id FROM round_blocks WHERE round_id=$1 AND type='PAK_EEN_ZES' ORDER BY sort_order,id",
      [roundId],
    );
    for (const pakBlock of pakBlocks.rows) {
      await closePakEenZesForBlock(client, gameId, Number(pakBlock.id));
    }

    // A Fotoronde still taking photos is closed, not cancelled: the submissions and any
    // credits already awarded are kept, and unjudged photos stay judgeable afterwards.
    // Completing a round therefore never leaves scoring half-finished — it leaves it
    // clearly unstarted, which the Admin panel reports.
    const photoBlocks = await client.query(
      "SELECT id FROM round_blocks WHERE round_id=$1 AND type='FOTORONDE' ORDER BY sort_order,id",
      [roundId],
    );
    for (const photoBlock of photoBlocks.rows) {
      await closePhotoRoundForBlock(client, gameId, Number(photoBlock.id));
    }

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
