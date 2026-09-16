import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundActive } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Reveal a slide's answer, or hide it again.
 *
 * Reversible on purpose: a host who reveals too early needs a way back, and unlike a quiz
 * reward nothing has been paid that un-revealing would have to undo.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const slideId = intValue(p.slideId, 'slideId', { min: 1 });
  const revealed = booleanValue(p.revealed, 'revealed');
  const expectedRevision = p.revision == null ? null : intValue(p.revision, 'revision', { min: 0 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      `SELECT s.id,s.round_id,st.revision,st.revealed_at
       FROM presentation_slides s
       JOIN presentation_slide_state st ON st.slide_id=s.id
       WHERE s.id=$1 AND s.game_night_id=$2 FOR UPDATE OF st`,
      [slideId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Slide not found');
    const slide = found.rows[0];
    const round = await lockRound(client, gameId, Number(slide.round_id));
    assertRoundType(round, 'PRESENTATIE');
    assertRoundActive(round);

    if (Boolean(slide.revealed_at) === revealed) {
      return { duplicate: true, revealed, revision: Number(slide.revision) };
    }
    if (expectedRevision != null && Number(slide.revision) !== expectedRevision) {
      throw new HttpError(409, 'This slide has moved on since — refresh and try again');
    }

    const updated = await client.query(
      `UPDATE presentation_slide_state
       SET revealed_at=$2,revision=revision+1,updated_at=NOW()
       WHERE slide_id=$1 AND revision=$3 RETURNING revision`,
      [slideId, revealed ? new Date() : null, Number(slide.revision)],
    );
    if (!updated.rows[0]) throw new HttpError(409, 'This slide has moved on since — refresh and try again');

    await audit(client, gameId, admin.username, revealed ? 'revealed slide' : 'hid slide', 'round', round.id, { slideId });
    return { revealed, revision: Number(updated.rows[0].revision), version: await incrementGameVersion(client, gameId) };
  }));
});
