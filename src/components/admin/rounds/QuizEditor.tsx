import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Empty, Status } from '../ui';
import { QUIZ_OPTION_EMOJIS } from '../roundMeta';
import { MediaField } from './MediaField';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

type OptionForm = { text: string; isCorrect: boolean };

const blank = (defaultPoints: number) => ({
  prompt: '',
  body: '',
  points: String(defaultPoints),
  timeLimitSeconds: '',
  contextMediaKey: '',
  options: [
    { text: '', isCorrect: true },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
  ] as OptionForm[],
});

/**
 * The LIVE_QUIZ editor: an ordered list of questions, each with its own points.
 *
 * Points default to the round's value and are then the question's own, which is the whole
 * reason the round carries a default rather than a fixed reward — a warm-up question and
 * the closer should not be worth the same.
 *
 * More than one option may be marked correct. That is a real case (any of these counts)
 * rather than a mistake, so the form allows it and the server scores it.
 */
export function QuizEditor({ round, gameId, run, readOnly }: { round: any; gameId: number; run: RunMutation; readOnly: boolean }) {
  const [form, setForm] = useState<any>(blank(round.defaultPoints));
  const [editingId, setEditingId] = useState<number | null>(null);
  const questions: any[] = round.questions || [];

  const reset = () => { setEditingId(null); setForm(blank(round.defaultPoints)); };

  const submit = async () => {
    const ok = await run('/api/upsert-quiz-question', {
      roundId: round.id,
      questionId: editingId,
      prompt: form.prompt,
      body: form.body,
      points: Number(form.points) || 0,
      timeLimitSeconds: form.timeLimitSeconds ? Number(form.timeLimitSeconds) : null,
      contextMediaKey: form.contextMediaKey || null,
      options: form.options.filter((o: OptionForm) => o.text.trim()).map((o: OptionForm) => ({ text: o.text, isCorrect: o.isCorrect })),
    });
    if (ok) reset();
  };

  const beginEdit = (question: any) => {
    setEditingId(question.id);
    setForm({
      prompt: question.prompt,
      body: question.body || '',
      points: String(question.points),
      timeLimitSeconds: question.timeLimitSeconds == null ? '' : String(question.timeLimitSeconds),
      contextMediaKey: question.contextMediaKey || '',
      options: question.options.map((o: any) => ({ text: o.text, isCorrect: o.isCorrect })),
    });
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...questions];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await run('/api/reorder-quiz-questions', { roundId: round.id, questionIds: next.map((q: any) => q.id) });
  };

  const setOption = (index: number, patch: Partial<OptionForm>) =>
    setForm({ ...form, options: form.options.map((o: OptionForm, i: number) => (i === index ? { ...o, ...patch } : o)) });

  const filled = form.options.filter((o: OptionForm) => o.text.trim());
  const canSave = form.prompt.trim() && filled.length >= MIN_OPTIONS && filled.some((o: OptionForm) => o.isCorrect);

  return <>
    {!readOnly && <Card>
      <div className="label muted">{editingId ? 'EDIT QUESTION' : 'ADD A QUESTION'}</div>

      <label>Question<input className="field" value={form.prompt} onChange={e => setForm({ ...form, prompt: e.target.value })} /></label>
      <label>Supporting text — travels with the question, so never the answer
        <textarea className="field" rows={2} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} />
      </label>

      <div className="quiz-options">
        <div className="label muted">ANSWER OPTIONS · TICK EVERY CORRECT ONE</div>
        {form.options.map((option: OptionForm, index: number) => <div className="quiz-option-row" key={index}>
          <span className="quiz-option-emoji">{QUIZ_OPTION_EMOJIS[index]}</span>
          <input
            className="field"
            placeholder={`Option ${index + 1}`}
            value={option.text}
            onChange={e => setOption(index, { text: e.target.value })}
          />
          <label className={`quiz-option-correct ${option.isCorrect ? 'selected' : ''}`}>
            <input type="checkbox" checked={option.isCorrect} onChange={e => setOption(index, { isCorrect: e.target.checked })} />
            <span>correct</span>
          </label>
          <button
            className="btn btn-danger-ghost btn-compact"
            disabled={form.options.length <= MIN_OPTIONS}
            onClick={() => setForm({ ...form, options: form.options.filter((_: OptionForm, i: number) => i !== index) })}
          >×</button>
        </div>)}
        <button
          className="btn btn-secondary btn-compact"
          disabled={form.options.length >= MAX_OPTIONS}
          onClick={() => setForm({ ...form, options: [...form.options, { text: '', isCorrect: false }] })}
        >+ OPTION</button>
      </div>

      <div className="form-grid compact">
        <label>Points for this question
          <input className="field" type="number" min="0" value={form.points} onChange={e => setForm({ ...form, points: e.target.value })} />
        </label>
        <label>Timer in seconds — leave empty to close it yourself
          <input className="field" type="number" min="5" max="600" value={form.timeLimitSeconds} onChange={e => setForm({ ...form, timeLimitSeconds: e.target.value })} />
        </label>
      </div>
      <p className="muted type-note">The round's default is {round.defaultPoints}. This question overrides it.</p>

      <MediaField
        kind="image" gameId={gameId} value={form.contextMediaKey}
        label="Context photo (optional)"
        hint="Shown on the projector as a separate step, only after you reveal the correct answer — never while players are still answering."
        onChange={({ key }) => setForm({ ...form, contextMediaKey: key })}
      />

      <div className="actions">
        <button className="btn btn-primary" disabled={!canSave} onClick={submit}>{editingId ? 'SAVE QUESTION' : 'ADD QUESTION'}</button>
        {editingId && <button className="btn btn-secondary" onClick={reset}>CANCEL</button>}
      </div>
    </Card>}

    {questions.length === 0
      ? <Empty title="No questions yet — add the first one" />
      : <div className="card-list block-list">
        {questions.map((question: any, index: number) => <Card key={question.id} className="round-block-card accent-violet">
          <div className="row-between">
            <div>
              <div className="label muted">{String(index + 1).padStart(2, '0')} · {question.points} POINT{question.points === 1 ? '' : 'S'}</div>
              <div className="display row-title">{question.prompt}</div>
              {question.body && <p className="muted block-copy">{question.body}</p>}
              <div className="duo-block-summary">
                <Status tone={question.status === 'OPEN' ? 'open' : question.status === 'SETTLED' ? 'success' : 'neutral'}>{question.status}</Status>
                <span>{question.answerCount} answer{question.answerCount === 1 ? '' : 's'}</span>
                {question.timeLimitSeconds && <span>{question.timeLimitSeconds}s timer</span>}
                {question.contextMediaKey && <span>context photo</span>}
              </div>
            </div>
          </div>

          <ol className="quiz-option-summary">
            {question.options.map((option: any, i: number) => <li key={option.id} className={option.isCorrect ? 'is-correct' : ''}>
              <span className="quiz-option-emoji">{QUIZ_OPTION_EMOJIS[i]}</span>
              <span>{option.text}</span>
              {option.isCorrect && <b>correct</b>}
            </li>)}
          </ol>

          {!readOnly && <div className="actions actions-compact">
            <button className="btn btn-secondary btn-compact" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button className="btn btn-secondary btn-compact" disabled={index === questions.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button className="btn btn-secondary btn-compact" disabled={question.answerCount > 0} onClick={() => beginEdit(question)}>EDIT</button>
            <button className="btn btn-danger-ghost btn-compact" disabled={question.answerCount > 0} onClick={() => run('/api/delete-quiz-question', { questionId: question.id })}>DELETE</button>
          </div>}
          {question.answerCount > 0 && !readOnly && <p className="muted type-note">
            Locked: this question has been answered, so changing it would change what the room was asked.
          </p>}
        </Card>)}
      </div>}
  </>;
}
