import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable } from '../lib/rounds';
import { MAX_PRESENTATION_SLIDES } from '../lib/round-types';
import { isSlideMediaKind } from '../lib/presentation';
import { wrap } from './_wrap';

/**
 * Create or update one presentation slide.
 *
 * A slide's secret is `reveal_text`, plus its title when `hideTitleUntilReveal` is set —
 * that flag is what a picture or music round needs, where the title *is* the answer. Both
 * are stored plainly here and withheld at the serialiser, because the Admin editing the
 * slide is the one audience entitled to see them.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const slideId = p.slideId == null ? null : intValue(p.slideId, 'slideId', { min: 1 });
  const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 200) : null;
  const bodyText = typeof p.body === 'string' ? p.body.trim().slice(0, 4000) : '';
  const revealText = typeof p.revealText === 'string' && p.revealText.trim() ? p.revealText.trim().slice(0, 500) : null;
  const hideTitle = Boolean(p.hideTitleUntilReveal);
  const mediaKey = typeof p.mediaKey === 'string' && p.mediaKey.trim() ? p.mediaKey.trim() : null;
  const mediaName = typeof p.mediaName === 'string' && p.mediaName.trim() ? p.mediaName.trim().slice(0, 200) : null;
  const mediaKind = mediaKey ? (isSlideMediaKind(p.mediaKind) ? p.mediaKind : null) : null;
  if (mediaKey && !mediaKind) throw new HttpError(400, 'mediaKind must be IMAGE or AUDIO when a media key is given');
  if (hideTitle && !title) throw new HttpError(400, 'A slide whose title is the answer needs a title');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'PRESENTATIE');
    assertRoundEditable(round);

    let id = slideId;
    if (id) {
      const existing = await client.query('SELECT id FROM presentation_slides WHERE id=$1 AND round_id=$2 FOR UPDATE', [id, roundId]);
      if (!existing.rows[0]) throw new HttpError(404, 'Slide not found in this round');
      await client.query(
        `UPDATE presentation_slides
         SET title=$2,body=$3,media_key=$4,media_kind=$5,media_name=$6,reveal_text=$7,
             hide_title_until_reveal=$8,updated_at=NOW()
         WHERE id=$1`,
        [id, title, bodyText, mediaKey, mediaKind, mediaName, revealText, hideTitle],
      );
    } else {
      const count = await client.query('SELECT COUNT(*)::int count FROM presentation_slides WHERE round_id=$1', [roundId]);
      if (Number(count.rows[0].count) >= MAX_PRESENTATION_SLIDES) {
        throw new HttpError(409, `A presentation round holds at most ${MAX_PRESENTATION_SLIDES} slides`);
      }
      const next = await client.query(
        'SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM presentation_slides WHERE round_id=$1',
        [roundId],
      );
      const inserted = await client.query(
        `INSERT INTO presentation_slides(game_night_id,round_id,sort_order,title,body,media_key,media_kind,media_name,reveal_text,hide_title_until_reveal)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [gameId, roundId, Number(next.rows[0].next), title, bodyText, mediaKey, mediaKind, mediaName, revealText, hideTitle],
      );
      id = Number(inserted.rows[0].id);
      await client.query(
        'INSERT INTO presentation_slide_state(slide_id,game_night_id,round_id) VALUES($1,$2,$3)',
        [id, gameId, roundId],
      );
    }

    await audit(client, gameId, admin.username, slideId ? 'edited slide' : 'added slide', 'round', roundId);
    return { slideId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
