import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { mediaKeyValue } from '../lib/media';
import { SLOT_DEFAULT_MAX_SPINS, SLOT_MAX_SPINS_LIMIT } from '../lib/slotmachine';
import { normalizeSubjects } from '../lib/photo-round';
import { wrap } from './_wrap';

// Must stay in step with round_blocks_type_check (migration 0007) and with
// blockMeta.ts on the client, which generates the content picker from the same set.
const TYPES = ['TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'] as const;
type BlockType = typeof TYPES[number];

function optionalText(value: unknown, max: number) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Text field is invalid');
  return value.trim().slice(0, max);
}

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const blockId = p.blockId == null ? null : intValue(p.blockId, 'blockId', { min: 1 });
  const type = String(p.type) as BlockType;
  if (!TYPES.includes(type)) throw new HttpError(400, 'Invalid block type');

  const title = optionalText(p.title, 300);
  const bodyText = optionalText(p.body, 5000);
  let payload: Record<string, unknown> = { body: bodyText };
  if (type === 'TEXT' && !bodyText) throw new HttpError(400, 'Text blocks require body/instructions');
  if (type === 'QUESTION' && !title) throw new HttpError(400, 'Question blocks require question text');
  if (type === 'DUOLINGO_QUESTION') {
    if (!title) throw new HttpError(400, 'Live question requires question text');
    if (!Array.isArray(p.answers) || p.answers.length !== 4) throw new HttpError(400, 'Live question requires exactly four answers');
    const answers = p.answers.map((a: unknown, index: number) => textValue(a, `answer ${index + 1}`, 240));
    const correctAnswerIndex = intValue(p.correctAnswerIndex, 'correctAnswerIndex', { min: 0, max: 3 });
    const rewardCoins = intValue(p.rewardCoins, 'rewardCoins', { min: 0, max: 1_000_000 });
    // The context photo is optional and only ever a blob key — never the bytes, which
    // would ride along in every admin-state poll for the rest of the evening. It is the
    // beat after the reveal, so a question without one skips that step entirely.
    //
    // `body` is kept because the projector shows it under the question as supporting
    // text; it used to be dropped here, which silently discarded whatever was typed.
    payload = { body: bodyText, answers, correctAnswerIndex, rewardCoins, contextImageKey: p.contextImageKey == null ? '' : mediaKeyValue(p.contextImageKey) };
  }
  if (type === 'PICTURE') {
    // The image is optional at first save so the Admin can outline a round and add
    // artwork later. Only the blob key is stored — never the bytes.
    payload = { body: bodyText, imageKey: p.imageKey == null ? '' : mediaKeyValue(p.imageKey) };
  }
  if (type === 'MUSIC') {
    // The title is the song title and stays hidden from players until reveal, so it is
    // not required up front either.
    payload = {
      body: bodyText,
      audioKey: p.audioKey == null ? '' : mediaKeyValue(p.audioKey),
      audioName: optionalText(p.audioName, 300),
    };
  }
  if (type === 'BUZZER') {
    if (!title) throw new HttpError(400, 'Buzzer rounds require question text');
    payload = { body: bodyText };
  }
  if (type === 'WAGER') {
    if (!title) throw new HttpError(400, 'Wager rounds require question text');
    payload = { body: bodyText, correctAnswer: optionalText(p.correctAnswer, 300) };
  }
  if (type === 'SLOTMACHINE') {
    // Per-block settings only. The reel artwork and the outcome distribution are
    // game-wide and live in Settings, because the same machine is reused by every slot
    // block in the night.
    const maxSpins = p.maxSpins == null
      ? SLOT_DEFAULT_MAX_SPINS
      : intValue(p.maxSpins, 'maxSpins', { min: 1, max: SLOT_MAX_SPINS_LIMIT });
    // An empty allowlist means everyone plays, which is the normal case. Player ids are
    // checked against this game's roster below, so a stale id cannot silently lock
    // someone out or let an outsider in.
    if (p.allowedPlayerIds != null && !Array.isArray(p.allowedPlayerIds)) throw new HttpError(400, 'allowedPlayerIds must be an array');
    const allowedPlayerIds = Array.isArray(p.allowedPlayerIds)
      ? [...new Set(p.allowedPlayerIds.map((id: unknown, index: number) => intValue(id, `allowedPlayerIds[${index}]`, { min: 1 })))]
      : [];
    payload = { body: bodyText, maxSpins, allowedPlayerIds };
  }
  if (type === 'FOTORONDE') {
    // The subject list is editable while the round has not started; normalizeSubjects
    // falls back to the standard six and keeps each subject's key stable, so renaming
    // one never detaches the photos already filed under it.
    payload = { body: bodyText, subjects: normalizeSubjects(p.subjects) };
  }
  if (type === 'PAK_EEN_ZES') {
    // Nothing to configure but the instruction text: the deck is a fixed 52 cards, the
    // game ends on the fourth six, and everyone active takes part. The turn order is
    // frozen when the host starts, not authored here.
    payload = { body: bodyText };
  }

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed round content is read-only');

    if (type === 'SLOTMACHINE') {
      const allowed = payload.allowedPlayerIds as number[];
      if (allowed.length) {
        const known = await client.query('SELECT COUNT(*)::int AS n FROM players WHERE game_night_id=$1 AND id=ANY($2::bigint[])', [gameId, allowed]);
        if (Number(known.rows[0].n) !== allowed.length) throw new HttpError(400, 'allowedPlayerIds contains a player from another game');
      }
    }

    let id = blockId;
    if (blockId) {
      const existing = await client.query('SELECT id,type,interactive_status FROM round_blocks WHERE id=$1 AND round_id=$2 AND game_night_id=$3 FOR UPDATE', [blockId, roundId, gameId]);
      if (!existing.rows[0]) throw new HttpError(404, 'Round block not found');
      if (existing.rows[0].type === 'DUOLINGO_QUESTION' && existing.rows[0].interactive_status !== 'READY') throw new HttpError(409, 'A live question cannot be edited after it opens');
      if (existing.rows[0].type !== type) {
        if (Number(game.rows[0].current_round_block_id || 0) === blockId) throw new HttpError(409, 'Change to another content block before changing this block type');
        const questionHistory = await client.query('SELECT 1 FROM round_question_answers WHERE round_block_id=$1 LIMIT 1', [blockId]);
        if (questionHistory.rows[0]) throw new HttpError(409, 'A block with live-question history cannot change type');
        await client.query(
          `DELETE FROM roulette_games rg WHERE rg.round_block_id=$1
           AND (rg.status='DRAFT' OR (rg.status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM roulette_bets rb WHERE rb.roulette_game_id=rg.id)))`,
          [blockId],
        );
        const rouletteHistory = await client.query('SELECT id FROM roulette_games WHERE round_block_id=$1 LIMIT 1', [blockId]);
        if (rouletteHistory.rows[0]) throw new HttpError(409, 'A block with roulette history cannot change type');
        const slotHistory = await client.query('SELECT id FROM slot_series WHERE round_block_id=$1 LIMIT 1', [blockId]);
        if (slotHistory.rows[0]) throw new HttpError(409, 'A block with slotmachine history cannot change type');
        // An unplayed game holds nothing worth keeping; one with draws or predictions is
        // the record a later scoring pass reads, so that block cannot change type.
        await client.query(
          `DELETE FROM pak_een_zes_games g WHERE g.round_block_id=$1
           AND NOT EXISTS(SELECT 1 FROM pak_een_zes_draws d WHERE d.pak_een_zes_game_id=g.id)
           AND NOT EXISTS(SELECT 1 FROM pak_een_zes_predictions p WHERE p.pak_een_zes_game_id=g.id)`,
          [blockId],
        );
        const pakHistory = await client.query('SELECT id FROM pak_een_zes_games WHERE round_block_id=$1 LIMIT 1', [blockId]);
        if (pakHistory.rows[0]) throw new HttpError(409, 'A block with Pak een Zes history cannot change type');
        // An unopened Fotoronde holds nothing; one with photos is history, and those
        // photos may already have paid credits.
        await client.query(
          `DELETE FROM photo_rounds pr WHERE pr.round_block_id=$1
           AND NOT EXISTS(SELECT 1 FROM photo_submissions s WHERE s.photo_round_id=pr.id)`,
          [blockId],
        );
        const photoHistory = await client.query('SELECT id FROM photo_rounds WHERE round_block_id=$1 LIMIT 1', [blockId]);
        if (photoHistory.rows[0]) throw new HttpError(409, 'A block with Fotoronde photos cannot change type');
      }
      await client.query(
        `UPDATE round_blocks SET type=$2,title=$3,payload=$4::jsonb,
          interactive_status=CASE WHEN $2 IN ('DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER') THEN 'READY' ELSE NULL END,
          opened_at=NULL,closed_at=NULL,revealed_at=NULL,settled_at=NULL,updated_at=NOW() WHERE id=$1`,
        [blockId, type, title || null, JSON.stringify(payload)],
      );
    } else {
      const next = await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM round_blocks WHERE round_id=$1', [roundId]);
      const q = await client.query(
        `INSERT INTO round_blocks(game_night_id,round_id,type,sort_order,title,payload,interactive_status)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,CASE WHEN $3 IN ('DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER') THEN 'READY' ELSE NULL END) RETURNING id`,
        [gameId, roundId, type, Number(next.rows[0].n), title || null, JSON.stringify(payload)],
      );
      id = Number(q.rows[0].id);
    }
    await audit(client, gameId, admin.username, blockId ? 'edited round block' : 'created round block', 'round_block', id || undefined, { roundId, type });
    return { blockId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
