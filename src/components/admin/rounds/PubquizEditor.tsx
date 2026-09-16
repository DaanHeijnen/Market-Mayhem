import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Empty, Status } from '../ui';
import { QUIZ_OPTION_EMOJIS } from '../roundMeta';
import { MediaField } from './MediaField';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

type OptionForm = { text: string; isCorrect: boolean };

const blank = (defaultPoints: number) => ({
  question: '',
  body: '',
  points: String(defaultPoints),
  timeLimitSeconds: '',
  mediaKey: '',
  mediaName: '',
  options: [
    { text: '', isCorrect: true },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
  ] as OptionForm[],
});

/**
 * The PUBQUIZ editor: an ordered run of questions, each one a page on the big screen.
 *
 * Laid out like the presentation editor because that is what a pubquiz question is — a
 * page the host steps onto — and scored like the quiz editor because that is what it
 * asks. Two differences from the LIVE_QUIZ form are deliberate and both are visible here:
 *
 *   exactly one correct answer   a pub quiz announces *the* answer, so the options are
 *                                radio buttons rather than checkboxes
 *   the image is the question    shown from the moment the question goes up, not held
 *                                back as evidence after the reveal
 */
export function PubquizEditor({ state: s, round, gameId, run, readOnly }: { state: any; round: any; gameId: number; run: RunMutation; readOnly: boolean }) {
  const [form, setForm] = useState<any>(blank(round.defaultPoints));
  const [editingId, setEditingId] = useState<number | null>(null);
  const questions: any[] = round.pubquizQuestions || [];
  const visibleCount = questions.filter(q => !q.hidden).length;
  const hiddenCount = questions.length - visibleCount;

  const liveId = s?.screen?.mode === 'PUBQUIZ_QUESTION' ? (s.screen.pubquizQuestionId ?? null) : null;
  const roundIsActive = round.status === 'ACTIVE';

  const reset = () => { setEditingId(null); setForm(blank(round.defaultPoints)); };

  const submit = async () => {
    const ok = await run('/api/upsert-pubquiz-question', {
      roundId: round.id,
      questionId: editingId,
      question: form.question,
      body: form.body,
      points: Number(form.points) || 0,
      timeLimitSeconds: form.timeLimitSeconds ? Number(form.timeLimitSeconds) : null,
      mediaKey: form.mediaKey || null,
      mediaName: form.mediaName || null,
      options: form.options.filter((o: OptionForm) => o.text.trim()).map((o: OptionForm) => ({ text: o.text, isCorrect: o.isCorrect })),
    });
    if (ok) reset();
  };

  const beginEdit = (question: any) => {
    setEditingId(question.id);
    setForm({
      question: question.question,
      body: question.body || '',
      points: String(question.points),
      timeLimitSeconds: question.timeLimitSeconds == null ? '' : String(question.timeLimitSeconds),
      mediaKey: question.mediaKey || '',
      mediaName: question.mediaName || '',
      options: question.options.map((o: any) => ({ text: o.text, isCorrect: o.isCorrect })),
    });
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...questions];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await run('/api/reorder-pubquiz-questions', { roundId: round.id, questionIds: next.map((q: any) => q.id) });
  };

  const setVisibility = (question: any, hidden: boolean) =>
    run('/api/set-pubquiz-question-visibility', { questionId: question.id, hidden });
  const showOnScreen = (question: any) =>
    run('/api/show-on-screen', { kind: 'pubquizQuestion', roundId: round.id, questionId: question.id });

  const filled = form.options.filter((o: OptionForm) => o.text.trim());
  const canSave = form.question.trim() && filled.length >= MIN_OPTIONS && filled.some((o: OptionForm) => o.isCorrect);

  const setOption = (index: number, changes: Partial<OptionForm>) =>
    setForm((current: any) => ({
      ...current,
      options: current.options.map((o: OptionForm, i: number) => (i === index ? { ...o, ...changes } : o)),
    }));

  // Exactly one correct answer, so choosing one unchooses the others. Enforced again by
  // the endpoint and again by a unique index — this is only the part the host can see.
  const markCorrect = (index: number) =>
    setForm((current: any) => ({
      ...current,
      options: current.options.map((o: OptionForm, i: number) => ({ ...o, isCorrect: i === index })),
    }));

  return <>
    {!readOnly && <Card>
      <div className="label muted">{editingId ? 'EDIT QUESTION' : 'ADD A QUESTION'}</div>

      <label>Question<input className="field" value={form.question} onChange={e => setForm({ ...form, question: e.target.value })} /></label>
      <label>Extra text — optional, shown with the question
        <textarea className="field" rows={2} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} />
      </label>

      <MediaField
        kind="image" gameId={gameId} value={form.mediaKey}
        label="Question image — optional"
        hint="Part of the question: on screen from the moment it goes up, not held back until the reveal."
        onChange={({ key, name }) => setForm({ ...form, mediaKey: key, mediaName: name })}
      />

      <div className="form-grid compact">
        <label>Points for the right answer
          <input className="field" type="number" min="0" value={form.points} onChange={e => setForm({ ...form, points: e.target.value })} />
        </label>
        <label>Timer in seconds — optional
          <input className="field" type="number" min="5" max="600" placeholder="No timer" value={form.timeLimitSeconds} onChange={e => setForm({ ...form, timeLimitSeconds: e.target.value })} />
        </label>
      </div>

      <div className="quiz-options">
        <div className="label muted">ANSWERS — PICK THE CORRECT ONE</div>
        {form.options.map((option: OptionForm, index: number) => <div className="quiz-option-row" key={index}>
          <span className="quiz-option-emoji">{QUIZ_OPTION_EMOJIS[index]}</span>
          <input className="field" placeholder={`Answer ${index + 1}`} value={option.text} onChange={e => setOption(index, { text: e.target.value })} />
          <label className={`quiz-option-correct ${option.isCorrect ? 'selected' : ''}`}>
            <input type="radio" name="pubquiz-correct" checked={option.isCorrect} onChange={() => markCorrect(index)} />
            <span>Correct</span>
          </label>
        </div>)}
        {form.options.length < MAX_OPTIONS && <button className="text-button" onClick={() => setForm({ ...form, options: [...form.options, { text: '', isCorrect: false }] })}>+ ANOTHER ANSWER</button>}
      </div>

      <div className="actions">
        <button className="btn btn-primary" disabled={!canSave} onClick={submit}>{editingId ? 'SAVE QUESTION' : 'ADD QUESTION'}</button>
        {editingId && <button className="btn btn-secondary" onClick={reset}>CANCEL</button>}
      </div>
    </Card>}

    {questions.length > 0 && <div className="explainer">
      {visibleCount} question{visibleCount === 1 ? '' : 's'} in the run{hiddenCount > 0 ? `, ${hiddenCount} held back` : ''}.
      {' '}VOLGENDE puts the next one straight on the big screen and opens it for answers.
      {!roundIsActive && !readOnly && ' Start the round to put a question on the big screen.'}
    </div>}

    {questions.length === 0
      ? <Empty title="No questions yet — add the first one" />
      : <div className="card-list block-list">
        {questions.map((question: any, index: number) => <Card key={question.id} className={`round-block-card accent-orange ${question.hidden ? 'is-muted-card' : ''} ${liveId === question.id ? 'is-live-card' : ''}`}>
          <div className="row-between">
            <div>
              <div className="label muted">{String(index + 1).padStart(2, '0')} · QUESTION · {question.points}P{question.hidden ? ' · NOT IN THE RUN' : ''}</div>
              <div className="display row-title">{question.question}</div>
              {question.body && <p className="muted block-copy">{question.body}</p>}
            </div>
            <div className="block-status-stack">
              {liveId === question.id && <Status tone="open">ON SCREEN</Status>}
              <Status tone={question.hidden ? 'neutral' : 'success'}>{question.hidden ? 'HIDDEN' : 'VISIBLE'}</Status>
              <Status tone={question.status === 'REVEALED' ? 'success' : question.status === 'OPEN' ? 'open' : 'neutral'}>{question.status}</Status>
            </div>
          </div>

          {question.mediaKey && <img className="block-thumb" src={`/api/block-media?key=${encodeURIComponent(question.mediaKey)}`} alt="" />}

          <div className="quiz-answer-list">
            {question.options.map((option: any, i: number) => <span key={option.id} className={`quiz-answer ${option.isCorrect ? 'is-correct' : ''}`}>
              {QUIZ_OPTION_EMOJIS[i]} {option.text}
            </span>)}
          </div>

          {!readOnly && <div className="actions actions-compact">
            <button className="btn btn-secondary btn-compact" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button className="btn btn-secondary btn-compact" disabled={index === questions.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button className="btn btn-secondary btn-compact" onClick={() => beginEdit(question)}>EDIT</button>
            {question.hidden
              ? <button className="btn btn-success btn-compact" onClick={() => setVisibility(question, false)}>MAKE VISIBLE</button>
              : <button className="btn btn-secondary btn-compact" onClick={() => setVisibility(question, true)}>HIDE</button>}
            {!question.hidden && <button
              className="btn btn-blue btn-compact"
              disabled={!roundIsActive || liveId === question.id}
              title={roundIsActive ? undefined : 'Start this round first'}
              onClick={() => showOnScreen(question)}
            >{liveId === question.id ? 'ON SCREEN' : 'SHOW ON SCREEN'}</button>}
            <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-pubquiz-question', { questionId: question.id })}>DELETE</button>
          </div>}
        </Card>)}
      </div>}
  </>;
}
