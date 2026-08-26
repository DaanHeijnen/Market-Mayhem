import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { mediaKeyValue } from '../lib/media';
import { wrap } from './_wrap';

// Must stay in step with round_blocks_type_check (migration 0007) and with
// blockMeta.ts on the client, which generates the content picker from the same set.
const TYPES = ['TEXT','QUESTION','ROULETTE','DUOLINGO_QUESTION','PICTURE','MUSIC','BUZZER','WAGER'] as const;
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
    payload = { answers, correctAnswerIndex, rewardCoins };
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

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await client.query('SELECT status FROM rounds WHERE id=$1 AND game_night_id=$2 FOR UPDATE', [roundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found');
    if (round.rows[0].status === 'COMPLETED') throw new HttpError(409, 'Completed round content is read-only');

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
