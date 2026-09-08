import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { payPhotoSubmission } from '../lib/photo-round-state';
import { acceptsAwards, type PhotoRoundStatus } from '../lib/photo-round';
import { wrap } from './_wrap';

/**
 * Award credits to one photo, and pay them to that photo's team.
 *
 * The Admin chooses the amount; the server does everything else. Credits are split
 * across the team's active members so the amounts add back up to exactly what was
 * awarded — see `distributeCredits` for the rule and why the member order matters.
 *
 * The same photo cannot be rewarded twice. `credits_awarded IS NULL` is the gate, taken
 * under a row lock, and behind it the ledger's unique index on
 * (photo_submission_id, player_id) refuses a second credit even if the gate were somehow
 * passed. A repeat request is answered with what was already awarded rather than an
 * error, because a double-click is not a mistake worth shouting about.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const submissionId = intValue(p.submissionId, 'submissionId', { min: 1 });
  // Zero is allowed: "seen it, worth nothing" is a real verdict, and recording it is
  // what moves the photo out of the unjudged list.
  const credits = intValue(p.credits, 'credits', { min: 0, max: 1_000_000 });

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    // FOR UPDATE is what serialises a double-click: the second request waits here and
    // then sees the award already recorded.
    const submission = await client.query(
      `SELECT s.id,s.photo_round_id,s.credits_awarded,s.subject_key,g.name AS team_name
       FROM photo_submissions s JOIN round_groups g ON g.id=s.group_id
       WHERE s.id=$1 AND s.game_night_id=$2 FOR UPDATE OF s`,
      [submissionId, gameId],
    );
    if (!submission.rows[0]) throw new HttpError(404, 'Photo submission not found');
    const row = submission.rows[0];

    if (row.credits_awarded != null) {
      // Already judged. Report it rather than paying again or failing.
      return { duplicate: true, submissionId, credits: Number(row.credits_awarded) };
    }

    const photoRound = await client.query(
      'SELECT status FROM photo_rounds WHERE id=$1 FOR UPDATE',
      [row.photo_round_id],
    );
    const status = photoRound.rows[0]?.status as PhotoRoundStatus;
    if (!acceptsAwards(status)) {
      throw new HttpError(409, 'Close the Fotoronde before awarding credits');
    }

    const payout = await payPhotoSubmission(client, gameId, submissionId, credits, admin.username);

    await client.query(
      `UPDATE photo_submissions
       SET credits_awarded=$2,awarded_at=NOW(),awarded_by=$3,updated_at=NOW()
       WHERE id=$1`,
      [submissionId, credits, admin.username],
    );

    await audit(client, gameId, admin.username, 'awarded Fotoronde credits', 'photo_submission', submissionId, {
      credits,
      teamName: row.team_name,
      subjectKey: row.subject_key,
      distribution: payout.distribution,
      memberCount: payout.memberCount,
    });

    return {
      submissionId,
      credits,
      paid: payout.paid,
      memberCount: payout.memberCount,
      distribution: payout.distribution,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
