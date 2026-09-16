import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreenMode } from '../lib/game-state';
import { mayShowContextPhoto } from '../lib/question';
import { wrap } from './_wrap';

/**
 * Put a live question's context photo on the projector, as the beat after the reveal.
 *
 * Reuses the existing presentation model rather than adding a phase to the question: the
 * answers are already closed and the reward already paid, so showing the photo changes
 * nothing about the game — it is a projector step. The flag rides in `screen_state.payload`
 * exactly as the Fotoronde selection does, so the Big Screen reads it from the snapshot it
 * already polls. Passing `show: false` takes it down again and the question returns.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const blockId = intValue(p.blockId, 'blockId', { min: 1 });
  const show = p.show == null ? true : Boolean(p.show);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const roundId = Number(game.rows[0].current_round_id || 0);
    if (!roundId) throw new HttpError(409, 'No round is active');

    const blockResult = await client.query(
      'SELECT id,round_id,type,interactive_status,payload FROM round_blocks WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [blockId, gameId],
    );
    const block = blockResult.rows[0];
    if (!block) throw new HttpError(404, 'Live question not found');
    if (block.type !== 'DUOLINGO_QUESTION') throw new HttpError(409, 'Block is not a live question');

    if (show) {
      // The two rules that make this a reveal-then-context flow rather than a spoiler,
      // enforced here so no client can reorder them.
      if (!mayShowContextPhoto(block.interactive_status)) {
        throw new HttpError(409, 'Reveal the correct answer before showing the context photo');
      }
      if (!block.payload?.contextImageKey) throw new HttpError(409, 'This question has no context photo');
    }

    await setScreenMode(client, gameId, 'ROUND_BLOCK', admin.username, {
      roundId,
      blockId,
      // Scoped to the block rather than a bare boolean: a flag left over from the
      // previous question could otherwise put its photo up the instant the *next* one is
      // revealed. An id can only ever match the question it was set for.
      payload: { questionContextPhotoBlockId: show ? blockId : null },
    });
    await audit(client, gameId, admin.username, show ? 'showed question context photo' : 'hid question context photo', 'round_block', blockId, { roundId });
    return { showing: show, version: await incrementGameVersion(client, gameId) };
  }));
});
