import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, booleanValue, HttpError } from '../lib/http';
import { incrementGameVersion, clearScreenIfReferences } from '../lib/game-state';
import { lockRound, assertRoundType } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Take a presentation page out of the run, or put it back in.
 *
 * Authored state, so this is a decision about the evening rather than about the moment:
 * it is written to `presentation_slides.hidden`, survives a refresh and survives a Full
 * Reset, exactly like the page's title and body do.
 *
 * Allowed while the round is UPCOMING *and* while it is ACTIVE. Deliberately not held to
 * `assertRoundEditable` like the rest of authoring: realising mid-presentation that the
 * spare page is needed after all is the case this exists for, and a host who has to stop
 * the round to reach it would just not use it. A COMPLETED round is refused, because
 * changing what a finished round contained is rewriting history.
 *
 * Hiding the page that is currently on the projector takes it off the projector. That is
 * the same rule deleting a page follows, and for the same reason: the alternative is a
 * screen still showing something the host has just said is not part of the evening.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const slideId = intValue(p.slideId, 'slideId', { min: 1 });
  const hidden = booleanValue(p.hidden, 'hidden');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const found = await client.query(
      'SELECT id,round_id,hidden FROM presentation_slides WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [slideId, gameId],
    );
    if (!found.rows[0]) throw new HttpError(404, 'Page not found');
    const round = await lockRound(client, gameId, Number(found.rows[0].round_id));
    assertRoundType(round, 'PRESENTATIE');
    if (round.status === 'COMPLETED') throw new HttpError(409, 'This round is finished — its pages can no longer be changed');

    // A second click, or a second tab sending the same command, finds the page already in
    // the state it asked for. That is the request succeeding, not a conflict.
    if (Boolean(found.rows[0].hidden) === hidden) return { duplicate: true, hidden };

    // Guarded on the value this transaction read. Two tabs racing in opposite directions
    // resolve to one winner rather than to whichever reply happened to arrive last.
    const updated = await client.query(
      'UPDATE presentation_slides SET hidden=$2,updated_at=NOW() WHERE id=$1 AND hidden=$3 RETURNING id',
      [slideId, hidden, !hidden],
    );
    if (!updated.rows[0]) throw new HttpError(409, 'This page has changed since — refresh and try again');

    // Only on the way out. Making a page visible never moves the projector on its own:
    // what the room is looking at stays the host's explicit choice.
    let clearedScreen = false;
    if (hidden) {
      const live = await client.query('SELECT slide_id FROM screen_state WHERE game_night_id=$1', [gameId]);
      clearedScreen = Number(live.rows[0]?.slide_id || 0) === slideId;
      await clearScreenIfReferences(client, gameId, admin.username, { slideId });
      // A staged page that can no longer go live would fail at GO LIVE with nothing said
      // until then, so the staged slot is emptied here instead.
      await client.query(
        `UPDATE screen_state
         SET staged_mode=NULL,staged_round_id=NULL,staged_prediction_id=NULL,
             staged_quiz_question_id=NULL,staged_slide_id=NULL,staged_payload='{}'::jsonb,updated_at=NOW()
         WHERE game_night_id=$1 AND staged_slide_id=$2`,
        [gameId, slideId],
      );
    }

    await audit(client, gameId, admin.username, hidden ? 'hid presentation page' : 'made presentation page visible', 'round', round.id, { slideId });
    return { hidden, clearedScreen, version: await incrementGameVersion(client, gameId) };
  }));
});
