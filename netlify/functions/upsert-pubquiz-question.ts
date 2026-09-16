import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { lockRound, assertRoundType, assertRoundEditable } from '../lib/rounds';
import { MAX_QUIZ_OPTIONS, MIN_QUIZ_OPTIONS, MAX_PUBQUIZ_QUESTIONS } from '../lib/round-types';
import { wrap } from './_wrap';

type OptionInput = { text: string; isCorrect: boolean };

/**
 * Exactly one correct option, checked here and again by the database.
 *
 * This is where PUBQUIZ parts company with LIVE_QUIZ, which allows several correct
 * options. A pub quiz announces *the* answer, and a question with two of them makes both
 * the projector's reveal and the player's "you were right" ambiguous.
 */
function readOptions(raw: unknown): OptionInput[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'options is required');
  const options = raw.slice(0, MAX_QUIZ_OPTIONS).map((entry: any, index: number) => ({
    text: textValue(entry?.text, `options[${index}].text`, 200),
    isCorrect: Boolean(entry?.isCorrect),
  }));
  if (options.length < MIN_QUIZ_OPTIONS) throw new HttpError(400, `A question needs at least ${MIN_QUIZ_OPTIONS} answers`);
  const correct = options.filter(o => o.isCorrect).length;
  if (correct === 0) throw new HttpError(400, 'Mark the correct answer');
  if (correct > 1) throw new HttpError(400, 'A pubquiz question has exactly one correct answer');
  return options;
}

/**
 * Create or update one pubquiz question.
 *
 * Points default to the round's `default_points` only when the client says nothing — an
 * explicit 0 is a real answer and is kept, which is why this checks for null rather than
 * falsiness.
 *
 * Editing is refused once the round is no longer editable, which is the same rule the
 * other authoring endpoints follow: changing a question the room has already answered
 * would rewrite what they were asked.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const questionId = p.questionId == null ? null : intValue(p.questionId, 'questionId', { min: 1 });
  const question = textValue(p.question, 'question', 500);
  const bodyText = typeof p.body === 'string' ? p.body.trim().slice(0, 2000) : '';
  const mediaKey = typeof p.mediaKey === 'string' && p.mediaKey.trim() ? p.mediaKey.trim() : null;
  const mediaName = typeof p.mediaName === 'string' && p.mediaName.trim() ? p.mediaName.trim().slice(0, 200) : null;
  const timeLimit = p.timeLimitSeconds == null ? null : intValue(p.timeLimitSeconds, 'timeLimitSeconds', { min: 5, max: 600 });
  const options = readOptions(p.options);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const round = await lockRound(client, gameId, roundId);
    assertRoundType(round, 'PUBQUIZ');
    assertRoundEditable(round);

    const points = p.points == null ? round.defaultPoints : intValue(p.points, 'points', { min: 0, max: 100000 });

    let id = questionId;
    if (id) {
      const existing = await client.query(
        'SELECT id FROM pubquiz_questions WHERE id=$1 AND round_id=$2 FOR UPDATE',
        [id, roundId],
      );
      if (!existing.rows[0]) throw new HttpError(404, 'Question not found in this round');

      // Answers already given were given to the question as it was. Rewriting it beneath
      // them would make the stored rows answers to something nobody was asked.
      const answered = await client.query('SELECT 1 FROM pubquiz_answers WHERE question_id=$1 LIMIT 1', [id]);
      if (answered.rows[0]) throw new HttpError(409, 'This question has already been answered and can no longer be edited');

      await client.query(
        `UPDATE pubquiz_questions
         SET question=$2,body=$3,points=$4,media_key=$5,media_name=$6,time_limit_seconds=$7,updated_at=NOW()
         WHERE id=$1`,
        [id, question, bodyText, points, mediaKey, mediaName, timeLimit],
      );
      // Replaced wholesale rather than diffed: an option's identity is its position in
      // this question, and a diff would have to invent one to preserve.
      await client.query('DELETE FROM pubquiz_question_options WHERE question_id=$1', [id]);
    } else {
      const count = await client.query('SELECT COUNT(*)::int count FROM pubquiz_questions WHERE round_id=$1', [roundId]);
      if (Number(count.rows[0].count) >= MAX_PUBQUIZ_QUESTIONS) {
        throw new HttpError(409, `A pubquiz round holds at most ${MAX_PUBQUIZ_QUESTIONS} questions`);
      }
      const next = await client.query(
        'SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM pubquiz_questions WHERE round_id=$1',
        [roundId],
      );
      const inserted = await client.query(
        `INSERT INTO pubquiz_questions(game_night_id,round_id,sort_order,question,body,points,media_key,media_name,time_limit_seconds)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [gameId, roundId, Number(next.rows[0].next), question, bodyText, points, mediaKey, mediaName, timeLimit],
      );
      id = Number(inserted.rows[0].id);
      await client.query(
        'INSERT INTO pubquiz_question_state(question_id,game_night_id,round_id) VALUES($1,$2,$3)',
        [id, gameId, roundId],
      );
    }

    for (let index = 0; index < options.length; index += 1) {
      await client.query(
        `INSERT INTO pubquiz_question_options(question_id,game_night_id,sort_order,text,is_correct)
         VALUES($1,$2,$3,$4,$5)`,
        [id, gameId, index, options[index].text, options[index].isCorrect],
      );
    }

    await audit(client, gameId, admin.username, questionId ? 'edited pubquiz question' : 'added pubquiz question', 'round', roundId, { questionId: id });
    return { questionId: id, version: await incrementGameVersion(client, gameId) };
  }));
});
