import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable } from '../lib/rounds';
import { MAX_PHOTO_SUBJECTS, subjectKeyFromLabel } from '../lib/photo-round';
import { wrap } from './_wrap';

/**
 * Create or update one Fotoronde subject.
 *
 * The key is the identity a photo is filed under and is derived once, when the subject is
 * created. Renaming the label afterwards therefore keeps the photos attached, which is the
 * whole reason the label is not the identity.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const subjectId = p.subjectId == null ? null : intValue(p.subjectId, 'subjectId', { min: 1 });
  const label = textValue(p.label, 'label', 200);
  const referenceMediaKey = typeof p.referenceMediaKey === 'string' && p.referenceMediaKey.trim()
    ? p.referenceMediaKey.trim()
    : null;

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'FOTORONDE');
    assertRoundEditable(round);

    const points = p.points == null ? round.defaultPoints : intValue(p.points, 'points', { min: 0, max: 100000 });

    if (subjectId) {
      const existing = await client.query('SELECT id FROM fotoronde_subjects WHERE id=$1 AND round_id=$2 FOR UPDATE', [subjectId, roundId]);
      if (!existing.rows[0]) throw new HttpError(404, 'Subject not found in this round');
      // The key is deliberately not updatable: it is what the photos point at.
      await client.query(
        'UPDATE fotoronde_subjects SET label=$2,points=$3,reference_media_key=$4,updated_at=NOW() WHERE id=$1',
        [subjectId, label, points, referenceMediaKey],
      );
      await audit(client, gameId, admin.username, 'edited Fotoronde subject', 'round', roundId);
      return { subjectId, version: await incrementGameVersion(client, gameId) };
    }

    const siblings = await client.query('SELECT subject_key FROM fotoronde_subjects WHERE round_id=$1', [roundId]);
    if (siblings.rows.length >= MAX_PHOTO_SUBJECTS) {
      throw new HttpError(409, `A Fotoronde holds at most ${MAX_PHOTO_SUBJECTS} subjects`);
    }
    const key = subjectKeyFromLabel(label, siblings.rows.map((r: any) => r.subject_key));
    const next = await client.query(
      'SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM fotoronde_subjects WHERE round_id=$1',
      [roundId],
    );
    const inserted = await client.query(
      `INSERT INTO fotoronde_subjects(game_night_id,round_id,sort_order,subject_key,label,points,reference_media_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [gameId, roundId, Number(next.rows[0].next), key, label, points, referenceMediaKey],
    );
    await audit(client, gameId, admin.username, 'added Fotoronde subject', 'round', roundId);
    return { subjectId: Number(inserted.rows[0].id), version: await incrementGameVersion(client, gameId) };
  }));
});
