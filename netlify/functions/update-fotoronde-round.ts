import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable } from '../lib/rounds';
import { MIN_SUBMISSION_MINUTES, MAX_SUBMISSION_MINUTES } from '../lib/photo-round';
import { wrap } from './_wrap';

/**
 * A Fotoronde's own settings: how long teams get to submit.
 *
 * Authored config, not runtime. Changing it decides the length of the *next* window the
 * host opens and deliberately does not move a deadline that is already running — teams
 * are photographing against that clock, and a host adjusting a number in another tab must
 * not shorten it under them. The deadline is stamped once, by the OPEN action.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const minutes = intValue(p.submissionDurationMinutes, 'submissionDurationMinutes', {
    min: MIN_SUBMISSION_MINUTES,
    max: MAX_SUBMISSION_MINUTES,
  });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'FOTORONDE');
    assertRoundEditable(round);

    await client.query(
      `INSERT INTO fotoronde_rounds(round_id,game_night_id,submission_duration_minutes)
       VALUES($1,$2,$3)
       ON CONFLICT (round_id) DO UPDATE
         SET submission_duration_minutes=EXCLUDED.submission_duration_minutes,updated_at=NOW()`,
      [roundId, gameId, minutes],
    );

    await audit(client, gameId, admin.username, 'updated fotoronde round settings', 'round', roundId, {
      submissionDurationMinutes: minutes,
    });
    return { submissionDurationMinutes: minutes, version: await incrementGameVersion(client, gameId) };
  }));
});
