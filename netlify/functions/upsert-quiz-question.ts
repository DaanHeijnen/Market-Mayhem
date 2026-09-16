import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable } from '../lib/rounds';
import { MAX_QUIZ_OPTIONS, MIN_QUIZ_OPTIONS, MAX_QUIZ_QUESTIONS } from '../lib/round-types';
import { wrap } from './_wrap';

type OptionInput = { text: string; isCorrect: boolean };

function readOptions(raw: unknown): OptionInput[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'options is required');
  const options = raw.slice(0, MAX_QUIZ_OPTIONS).map((entry: any, index: number) => ({
    text: textValue(entry?.text, `options[${index}].text`, 200),
    isCorrect: Boolean(entry?.isCorrect),
  }));
  if (options.length < MIN_QUIZ_OPTIONS) throw new HttpError(400, `A question needs at least ${MIN_QUIZ_OPTIONS} options`);
  // At least one, but deliberately not exactly one: a question may have several correct
  // answers, which is why correctness is a flag per option rather than an index.
  if (!options.some(o => o.isCorrect)) throw new HttpError(400, 'Mark at least one option as correct');
  return options;
}

/**
 * Create or update one quiz question.
 *
 * Points are per question and default to the round's `default_points` only when the client
 * says nothing — an explicit 0 is a real answer and is kept, which is why this checks for
 * null rather than falsiness.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const questionId = p.questionId == null ? null : intValue(p.questionId, 'questionId', { min: 1 });
  const prompt = textValue(p.prompt, 'prompt', 500);
  const bodyText = typeof p.body === 'string' ? p.body.trim().slice(0, 2000) : '';
  const contextMediaKey = typeof p.contextMediaKey === 'string' && p.contextMediaKey.trim() ? p.contextMediaKey.trim() : null;
  const timeLimit = p.timeLimitSeconds == null ? null : intValue(p.timeLimitSeconds, 'timeLimitSeconds', { min: 5, max: 600 });
  const options = readOptions(p.options);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'LIVE_QUIZ');
    assertRoundEditable(round);

    const points = p.points == null ? round.defaultPoints : intValue(p.points, 'points', { min: 0, max: 100000 });

    let id = questionId;
    if (id) {
      const existing = await client.query(
        'SELECT q.id FROM live_quiz_questions q WHERE q.id=$1 AND q.round_id=$2 FOR UPDATE',
        [id, roundId],
      );
      if (!existing.rows[0]) throw new HttpError(404, 'Question not found in this round');

      // Editing a question that has already been answered would change what the room was
      // asked after they answered it.
      const answered = await client.query('SELECT COUNT(*)::int count FROM quiz_answers WHERE question_id=$1', [id]);
      if (Number(answered.rows[0].count) > 0) throw new HttpError(409, 'This question already has answers and can no longer be edited');

      await client.query(
        `UPDATE live_quiz_questions
         SET prompt=$2,body=$3,points=$4,time_limit_seconds=$5,context_media_key=$6,updated_at=NOW()
         WHERE id=$1`,
        [id, prompt, bodyText, points, timeLimit, contextMediaKey],
      );
      await client.query('DELETE FROM live_quiz_question_options WHERE question_id=$1', [id]);
    } else {
      const count = await client.query('SELECT COUNT(*)::int count FROM live_quiz_questions WHERE round_id=$1', [roundId]);
      if (Number(count.rows[0].count) >= MAX_QUIZ_QUESTIONS) {
        throw new HttpError(409, `A quiz round holds at most ${MAX_QUIZ_QUESTIONS} questions`);
      }
      const next = await client.query(
        'SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM live_quiz_questions WHERE round_id=$1',
        [roundId],
      );
      const inserted = await client.query(
        `INSERT INTO live_quiz_questions(game_night_id,round_id,sort_order,prompt,body,points,time_limit_seconds,context_media_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [gameId, roundId, Number(next.rows[0].next), prompt, bodyText, points, timeLimit, contextMediaKey],
      );
      id = Number(inserted.rows[0].id);
      await client.query(
        'INSERT INTO live_quiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)',
        [id, gameId, roundId],
      );
    }

    for (const [index, option] of options.entries()) {
      await client.query(
        'INSERT INTO live_quiz_question_options(question_id,game_night_id,sort_order,text,is_correct) VALUES($1,$2,$3,$4,$5)',
        [id, gameId, index, option.text, option.isCorrect],
      );
    }

    await audit(client, gameId, admin.username, questionId ? 'edited quiz question' : 'added quiz question', 'round', roundId);
    return { questionId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
