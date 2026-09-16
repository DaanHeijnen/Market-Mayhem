import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setScreen } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundActive, advanceRoundCursor, loadRoundRuntime, neighbours } from '../lib/rounds';
import { wrap } from './_wrap';

/**
 * Move a presentation round's cursor.
 *
 * Simpler than the quiz equivalent because a slide has nothing to settle: there are no
 * answers waiting and no reward outstanding, so stepping away from one costs nothing and
 * nothing blocks it.
 */
const ACTIONS = ['NEXT', 'PREVIOUS', 'GOTO'] as const;

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const action = String(p.action || '').toUpperCase() as typeof ACTIONS[number];
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Invalid navigation action');
  const targetId = action === 'GOTO' ? intValue(p.slideId, 'slideId', { min: 1 }) : null;
  const expectedRevision = p.revision == null ? null : intValue(p.revision, 'revision', { min: 0 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'PRESENTATIE');
    assertRoundActive(round);

    const runtime = await loadRoundRuntime(client, roundId);
    if (expectedRevision != null && runtime.revision !== expectedRevision) {
      throw new HttpError(409, 'This round has moved on since — refresh and try again');
    }

    const listed = await client.query('SELECT id FROM presentation_slides WHERE round_id=$1 ORDER BY sort_order,id', [roundId]);
    const slides = listed.rows.map((r: any) => ({ id: Number(r.id) }));
    if (!slides.length) throw new HttpError(409, 'This presentation round has no slides yet');

    const around = neighbours(slides, runtime.currentSlideId);
    let next: { id: number } | null;
    if (action === 'GOTO') {
      next = slides.find(s => s.id === targetId) ?? null;
      if (!next) throw new HttpError(404, 'Slide not found in this round');
    } else if (action === 'NEXT') {
      next = around.next ?? (around.index < 0 ? around.first : null);
      if (!next) throw new HttpError(409, 'This is the last slide');
    } else {
      next = around.previous;
      if (!next) throw new HttpError(409, 'This is the first slide');
    }

    const moved = await advanceRoundCursor(client, roundId, runtime.revision, { slideId: next.id });

    const screen = await client.query('SELECT mode,round_id FROM screen_state WHERE game_night_id=$1', [gameId]);
    const wasShowingThisRound = screen.rows[0]?.mode === 'SLIDE' && Number(screen.rows[0]?.round_id || 0) === roundId;
    if (wasShowingThisRound) {
      await setScreen(client, gameId, { kind: 'slide', roundId, slideId: next.id }, admin.username);
    }

    await audit(client, gameId, admin.username, `slide ${action.toLowerCase()}`, 'round', roundId, { slideId: next.id });
    return {
      slideId: next.id,
      revision: moved.revision,
      followedOnScreen: wasShowingThisRound,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
