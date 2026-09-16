import { getStore } from '@netlify/blobs';
import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { randomToken } from '../lib/security';
import { BLOB_STORE, assertAcceptableMedia, buildMediaKey } from '../lib/media';
import { playerTeamForRound } from '../lib/photo-round-state';
import { acceptsUploads, type PhotoRoundStatus } from '../lib/photo-round';
import { wrap } from './_wrap';

/**
 * A player uploads one photo on behalf of their own team.
 *
 * A player-authenticated upload rather than the Admin-only `upload-block-media`, but it
 * reuses the same blob store and the same size/type limits from lib/media — a photo round
 * is round media like any other, and its bytes must not end up in the database.
 *
 * The team is derived from the session, never taken from the request: a player belongs to
 * at most one group per round, so uploading on behalf of another team is not something
 * the client can ask for. Storing the file and recording the submission happen in one
 * request so a successful upload can never leave an orphaned blob with no row, or a row
 * pointing at a file that was never written.
 */
export default wrap(async request => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'Expected a multipart form upload');
  }

  const gameId = intValue(form.get('gameId'), 'gameId', { min: 1 });
  const roundId = intValue(form.get('roundId'), 'roundId', { min: 1 });
  const subjectKey = textValue(form.get('subjectKey'), 'subjectKey', 40);
  const session = await requirePlayer(request, gameId);

  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'No photo was attached');
  const contentType = assertAcceptableMedia('image', file.type, file.size, file.name);

  // Everything that could reject the upload is checked before a byte is stored, so a
  // refused submission never leaves a file behind.
  const context = await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const roundResult = await client.query(
      'SELECT id,type,status FROM rounds WHERE id=$1 AND game_night_id=$2',
      [roundId, gameId],
    );
    const round = roundResult.rows[0];
    if (!round) throw new HttpError(404, 'Round not found');
    if (round.type !== 'FOTORONDE') throw new HttpError(409, 'That round is not a Fotoronde');
    if (round.status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== roundId) {
      throw new HttpError(409, 'The Fotoronde round is not active');
    }

    const player = await client.query('SELECT active FROM players WHERE id=$1 AND game_night_id=$2', [session.playerId, gameId]);
    if (!player.rows[0]?.active) throw new HttpError(403, 'Player is no longer active');

    const photoRound = await client.query(
      'SELECT id,status FROM photo_rounds WHERE game_night_id=$1 AND round_id=$2',
      [gameId, roundId],
    );
    if (!photoRound.rows[0]) throw new HttpError(409, 'The Fotoronde has not opened yet');
    const status = photoRound.rows[0].status as PhotoRoundStatus;
    if (!acceptsUploads(status)) {
      throw new HttpError(409, status === 'DRAFT'
        ? 'The Fotoronde has not opened yet'
        : 'Submissions are closed');
    }

    // The subject has to be one this round actually asks for, read from the round's own
    // authored list rather than from anything the phone sent.
    const subject = await client.query(
      'SELECT id FROM fotoronde_subjects WHERE round_id=$1 AND subject_key=$2',
      [roundId, subjectKey],
    );
    if (!subject.rows[0]) throw new HttpError(400, 'That subject is not part of this Fotoronde');

    // The team comes from the round's groups, not the request.
    const team = await playerTeamForRound(client, roundId, session.playerId);
    if (!team) throw new HttpError(403, 'You are not in a team for this round');

    return {
      photoRoundId: Number(photoRound.rows[0].id),
      roundId,
      team,
    };
  });

  // Keys are namespaced by game and carry a random segment, so one cannot be guessed
  // from a submission id.
  const mediaKey = buildMediaKey(gameId, 'image', contentType, randomToken(8));
  const store = getStore(BLOB_STORE);
  await store.set(mediaKey, await file.arrayBuffer(), {
    metadata: { contentType, name: file.name || '', gameId, uploadedAt: new Date().toISOString() },
  });

  return ok(await withTransaction(async client => {
    // Re-check the phase inside the writing transaction: the Admin may have closed
    // submissions while the bytes were in flight, and a stale client must not slip a
    // photo in afterwards.
    const stillOpen = await client.query(
      'SELECT status FROM photo_rounds WHERE id=$1 FOR UPDATE',
      [context.photoRoundId],
    );
    if (!acceptsUploads(stillOpen.rows[0]?.status as PhotoRoundStatus)) {
      throw new HttpError(409, 'Submissions closed before this photo arrived');
    }

    // Replacing rather than adding: one active photo per team per subject, so a second
    // upload from any team member overwrites the first while the round is open. The
    // unique index is what makes that a guarantee; this is how the guarantee is met.
    const saved = await client.query(
      `INSERT INTO photo_submissions(photo_round_id,game_night_id,round_id,
        subject_key,group_id,uploaded_by,media_key)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (photo_round_id,subject_key,group_id) DO UPDATE
         SET media_key=EXCLUDED.media_key,
             uploaded_by=EXCLUDED.uploaded_by,
             updated_at=NOW()
       RETURNING id,media_key`,
      [context.photoRoundId, gameId, context.roundId, subjectKey, context.team.groupId, session.playerId, mediaKey],
    );

    return {
      submissionId: Number(saved.rows[0].id),
      mediaKey: saved.rows[0].media_key,
      subjectKey,
      team: context.team.name,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
