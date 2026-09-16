import { useState } from 'react';
import type { RunMutation } from '../types';
import { Card, Empty, Status } from '../ui';
import { MediaField } from './MediaField';

const blank = {
  title: '', body: '', mediaKey: '', mediaKind: '' as '' | 'IMAGE' | 'AUDIO', mediaName: '',
  revealText: '', hideTitleUntilReveal: false,
};

/**
 * The PRESENTATIE editor: an ordered list of slides for the big screen.
 *
 * One slide model rather than six types, because what distinguished an info card from a
 * picture round from a wager was never a state machine — only which fields they filled in
 * and whether their answer stayed hidden. Both of those are fields here:
 *
 *   `revealText`             the answer line, withheld until the host reveals it
 *   `hideTitleUntilReveal`   for the picture and music rounds, where the title IS the answer
 *
 * A third, separate thing is whether the page takes part at all. `hidden` holds a page back
 * from the run: normal previous/next steps over it and the projector refuses to show it,
 * while it stays here in full, in its own place, editable. The two are easy to confuse, so
 * this screen keeps them apart — REVEALED is about a secret on a page, HIDDEN is about the
 * page itself.
 */
export function PresentationEditor({ state: s, round, gameId, run, readOnly }: { state: any; round: any; gameId: number; run: RunMutation; readOnly: boolean }) {
  const [form, setForm] = useState<any>({ ...blank });
  const [editingId, setEditingId] = useState<number | null>(null);
  const slides: any[] = round.slides || [];
  const visibleCount = slides.filter((slide: any) => !slide.hidden).length;
  const hiddenCount = slides.length - visibleCount;

  // What the projector is actually pointed at, straight from the polled screen state —
  // not something this component works out for itself, so it cannot disagree with the
  // Control Center or with the big screen.
  const liveSlideId = s?.screen?.mode === 'SLIDE' ? (s.screen.slideId ?? null) : null;
  const roundIsActive = round.status === 'ACTIVE';

  const setVisibility = (slide: any, hidden: boolean) => run('/api/set-slide-visibility', { slideId: slide.id, hidden });
  const showOnScreen = (slide: any) => run('/api/show-on-screen', { kind: 'slide', roundId: round.id, slideId: slide.id });

  const reset = () => { setEditingId(null); setForm({ ...blank }); };

  const submit = async () => {
    const ok = await run('/api/upsert-slide', {
      roundId: round.id,
      slideId: editingId,
      title: form.title,
      body: form.body,
      mediaKey: form.mediaKey || null,
      mediaKind: form.mediaKey ? (form.mediaKind || 'IMAGE') : null,
      mediaName: form.mediaName || null,
      revealText: form.revealText || null,
      hideTitleUntilReveal: form.hideTitleUntilReveal,
    });
    if (ok) reset();
  };

  const beginEdit = (slide: any) => {
    setEditingId(slide.id);
    setForm({
      title: slide.title || '',
      body: slide.body || '',
      mediaKey: slide.mediaKey || '',
      mediaKind: slide.mediaKind || '',
      mediaName: slide.mediaName || '',
      revealText: slide.revealText || '',
      hideTitleUntilReveal: Boolean(slide.hideTitleUntilReveal),
    });
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...slides];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await run('/api/reorder-slides', { roundId: round.id, slideIds: next.map((s: any) => s.id) });
  };

  return <>
    {!readOnly && <Card>
      <div className="label muted">{editingId ? 'EDIT PAGE' : 'ADD A PAGE'}</div>

      <label>Title<input className="field" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
      <label>Body
        <textarea className="field" rows={3} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} />
      </label>

      <div className="slide-media-choice">
        <div className="label muted">MEDIA — OPTIONAL</div>
        <div className="actions actions-compact">
          {(['', 'IMAGE', 'AUDIO'] as const).map(kind => <button
            key={kind || 'none'}
            className={`btn btn-compact ${form.mediaKind === kind ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setForm({ ...form, mediaKind: kind, mediaKey: kind ? form.mediaKey : '', mediaName: kind ? form.mediaName : '' })}
          >{kind === '' ? 'NONE' : kind === 'IMAGE' ? 'IMAGE' : 'AUDIO'}</button>)}
        </div>
      </div>

      {form.mediaKind === 'IMAGE' && <MediaField
        kind="image" gameId={gameId} value={form.mediaKey}
        label="Slide image" hint="Filled to the projector."
        onChange={({ key, name }) => setForm({ ...form, mediaKey: key, mediaName: name })}
      />}
      {form.mediaKind === 'AUDIO' && <MediaField
        kind="audio" gameId={gameId} value={form.mediaKey} name={form.mediaName}
        label="Slide audio" hint="Players hear this. Use the reveal fields below if the song title is the answer."
        onChange={({ key, name }) => setForm({ ...form, mediaKey: key, mediaName: name })}
      />}

      <div className="slide-secret">
        <div className="label muted">THE SECRET — WHAT STAYS OFF THE PROJECTOR UNTIL YOU REVEAL</div>
        <label>Reveal line
          <input className="field" placeholder="The answer, shown only after you press REVEAL" value={form.revealText} onChange={e => setForm({ ...form, revealText: e.target.value })} />
        </label>
        <label className={`quiz-option-correct ${form.hideTitleUntilReveal ? 'selected' : ''}`}>
          <input type="checkbox" checked={form.hideTitleUntilReveal} onChange={e => setForm({ ...form, hideTitleUntilReveal: e.target.checked })} />
          <span>The title is the answer — hide it until I reveal</span>
        </label>
        <p className="muted type-note">
          Neither is sent to the projector before the reveal, so there is nothing on the wire for a curious viewer to
          read early.
        </p>
      </div>

      <div className="actions">
        <button className="btn btn-primary" disabled={!form.title.trim() && !form.body.trim() && !form.mediaKey} onClick={submit}>
          {editingId ? 'SAVE PAGE' : 'ADD PAGE'}
        </button>
        {editingId && <button className="btn btn-secondary" onClick={reset}>CANCEL</button>}
      </div>
    </Card>}

    {slides.length > 0 && <div className="explainer">
      {visibleCount} page{visibleCount === 1 ? '' : 's'} in the run{hiddenCount > 0 ? `, ${hiddenCount} held back` : ''}.
      {' '}Previous and next step over a hidden page; MAKE VISIBLE puts it back in the sequence.
      {!roundIsActive && !readOnly && ' Start the round to put a page on the big screen.'}
    </div>}

    {slides.length === 0
      ? <Empty title="No pages yet — add the first one" />
      : <div className="card-list block-list">
        {slides.map((slide: any, index: number) => <Card key={slide.id} className={`round-block-card accent-cyan ${slide.hidden ? 'is-muted-card' : ''} ${liveSlideId === slide.id ? 'is-live-card' : ''}`}>
          <div className="row-between">
            <div>
              <div className="label muted">{String(index + 1).padStart(2, '0')} · PAGE{slide.hidden ? ' · NOT IN THE RUN' : ''}</div>
              <div className="display row-title">{slide.title || '(no title)'}</div>
              {slide.body && <p className="muted block-copy">{slide.body}</p>}
            </div>
            {/* Three different facts, so three different pills rather than one badge that
                has to mean all of them. */}
            <div className="block-status-stack">
              {liveSlideId === slide.id && <Status tone="open">ON SCREEN</Status>}
              <Status tone={slide.hidden ? 'neutral' : 'success'}>{slide.hidden ? 'HIDDEN' : 'VISIBLE'}</Status>
              {slide.revealedAt && <Status tone="success">REVEALED</Status>}
            </div>
          </div>

          {slide.mediaKind === 'IMAGE' && slide.mediaKey && <img className="block-thumb" src={`/api/block-media?key=${encodeURIComponent(slide.mediaKey)}`} alt="" />}
          {slide.mediaKind === 'AUDIO' && slide.mediaKey && <div className="media-audio">
            <audio controls preload="none" src={`/api/block-media?key=${encodeURIComponent(slide.mediaKey)}`} />
            <span className="muted">{slide.mediaName || 'Audio'}</span>
          </div>}

          {(slide.revealText || slide.hideTitleUntilReveal) && <p className="muted block-copy">
            {slide.hideTitleUntilReveal && <>Title hidden until reveal. </>}
            {slide.revealText && <>Reveal: <b>{slide.revealText}</b></>}
          </p>}

          {!readOnly && <div className="actions actions-compact">
            <button className="btn btn-secondary btn-compact" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button className="btn btn-secondary btn-compact" disabled={index === slides.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button className="btn btn-secondary btn-compact" onClick={() => beginEdit(slide)}>EDIT</button>
            {slide.hidden
              ? <button className="btn btn-success btn-compact" onClick={() => setVisibility(slide, false)}>MAKE VISIBLE</button>
              : <button className="btn btn-secondary btn-compact" onClick={() => setVisibility(slide, true)}>HIDE</button>}
            {/* Only offered for a page that can actually be shown. A hidden page has
                MAKE VISIBLE right beside it, which is the one step needed first. */}
            {!slide.hidden && <button
              className="btn btn-blue btn-compact"
              disabled={!roundIsActive || liveSlideId === slide.id}
              title={roundIsActive ? undefined : 'Start this round first'}
              onClick={() => showOnScreen(slide)}
            >{liveSlideId === slide.id ? 'ON SCREEN' : 'SHOW ON SCREEN'}</button>}
            <button className="btn btn-danger-ghost btn-compact" onClick={() => run('/api/delete-slide', { slideId: slide.id })}>DELETE</button>
          </div>}
        </Card>)}
      </div>}
  </>;
}
