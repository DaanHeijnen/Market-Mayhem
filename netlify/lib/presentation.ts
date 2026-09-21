/**
 * Rules for a PRESENTATIE round.
 *
 * An ordered list of slides the host steps through on the projector. There is no phone
 * flow and no scoring — a slide is something the room looks at. What a slide does have is
 * a secret: its answer line, and for a picture or music slide its title, which stay off
 * every non-admin surface until the host reveals them.
 *
 * That is the whole state machine: revealed, or not.
 */

export type SlideMediaKind = 'IMAGE' | 'AUDIO';

export const SLIDE_MEDIA_KINDS: SlideMediaKind[] = ['IMAGE', 'AUDIO'];

export function isSlideMediaKind(value: unknown): value is SlideMediaKind {
  return value === 'IMAGE' || value === 'AUDIO';
}

export function slideIsRevealed(revealedAt: unknown) {
  return revealedAt != null;
}

/**
 * Whether this slide's title may leave the server.
 *
 * A picture round's title is the thing being guessed and a music round's title is the song,
 * so both are authored with `hide_title_until_reveal`. Answering the question here rather
 * than in the UI is what makes it structural: a hidden title is never serialised, so there
 * is nothing on the wire for a curious viewer to read.
 */
export function slideTitleIsPublic(hideUntilReveal: boolean, revealedAt: unknown) {
  return !hideUntilReveal || slideIsRevealed(revealedAt);
}

/**
 * Whether a page takes part in the run of the presentation.
 *
 * Authored, not runtime. A hidden page keeps its content, its order and its place in the
 * editor — it is simply skipped by previous/next and refused by the projector, so a spare
 * or unfinished page cannot arrive on the big screen by stepping one too far.
 *
 * Distinct from the two secrets a page can hold. `reveal_text` and `hide_title_until_reveal`
 * decide what is withheld *on* a page being shown; `hidden` decides whether it is shown.
 */
export type PresentationPage = { id: number; hidden: boolean };

/**
 * The previous and next *visible* page, relative to where the cursor is standing.
 *
 * Positional rather than index-into-the-visible-list, because the cursor can legitimately
 * be standing on a hidden page: the host hides the page that is currently up. Stepping
 * from there still has to mean "the nearest visible page in that direction" rather than
 * "nowhere", which is what a lookup by identity in the filtered list would give.
 *
 * `first` is where NEXT starts from when the cursor is nowhere at all — a round that has
 * just been entered.
 */
export function visibleNeighbours<T extends PresentationPage>(pages: T[], currentId: number | null) {
  const at = pages.findIndex(page => page.id === currentId);
  const visible = pages.filter(page => !page.hidden);

  let previous: T | null = null;
  let next: T | null = null;
  if (at >= 0) {
    for (let i = at - 1; i >= 0; i -= 1) if (!pages[i].hidden) { previous = pages[i]; break; }
    for (let i = at + 1; i < pages.length; i += 1) if (!pages[i].hidden) { next = pages[i]; break; }
  }

  const currentPage: T | null = at >= 0 ? pages[at] : null;
  return {
    /** Where the cursor stands in the full authored list, or -1 when it stands nowhere. */
    at,
    current: currentPage,
    /** True when the cursor is standing on a page that is no longer part of the run. */
    currentIsHidden: Boolean(currentPage?.hidden),
    previous,
    next,
    first: visible[0] ?? null,
    visibleCount: visible.length,
    /** The cursor's position among the visible pages, or -1 when it is on a hidden one. */
    visibleIndex: currentPage && !currentPage.hidden ? visible.findIndex(page => page.id === currentPage.id) : -1,
  };
}

/**
 * The display-state machine of a presentation.
 *
 * A presentation is not a list of pages the host walks; it is a list of *display states*.
 * A page with something held back is two of them — the page, then the page with its answer
 * — and a page with nothing held back is one. Laid end to end that is a single linear
 * sequence, and VOLGENDE and VORIGE are one step along it in either direction:
 *
 *     page 1            page 2            page 2 + answer   page 3
 *     ├───────────────► ├───────────────► ├───────────────► │
 *                     ◄─┤               ◄─┤               ◄─┤
 *
 * Writing it out this way is the point. The alternative — asking "does this page have an
 * answer, has it been given yet, is there a page after this one" at each call site — is
 * the same rule scattered over branches that can disagree, and forward and back written
 * twice. Here there is one sequence and one index, so the two directions are the same
 * function with the step in opposite signs, and an edge case is a missing neighbour rather
 * than a combination nobody thought of.
 *
 * Hidden pages stay *in* the sequence and are stepped over. The cursor can legitimately be
 * standing on one — the host hides the page that is currently up — and from there the next
 * step still has to mean "the nearest visible state that way" rather than nothing at all.
 */

/** One position in the walk: a page, and whether what it holds back is being shown. */
export type PresentationDisplayState = { slideId: number; revealed: boolean };

/** What the sequence is built from: the page as authored, plus where its reveal stands. */
export type PresentationPageState = PresentationPage & {
  /** Does this page hold anything back — an answer line, or a title that is the answer. */
  hasAnswer: boolean;
  /** Has the host given it, right now. */
  revealed: boolean;
};

export type PresentationSequenceEntry = PresentationDisplayState & { hidden: boolean; index: number };

/**
 * Every display state of a round, in order.
 *
 * Built from what the host authored (`hasAnswer`) and not from what has happened so far
 * (`revealed`), so the sequence is the same whichever direction it is walked and whatever
 * the host has already given away. Where the round *is* in it is `displayStateOf`.
 */
export function presentationSequence(pages: PresentationPageState[]): PresentationSequenceEntry[] {
  const states: PresentationSequenceEntry[] = [];
  for (const page of pages) {
    states.push({ slideId: page.id, revealed: false, hidden: page.hidden, index: states.length });
    if (page.hasAnswer) states.push({ slideId: page.id, revealed: true, hidden: page.hidden, index: states.length });
  }
  return states;
}

/**
 * Which display state a page is in right now.
 *
 * A page is standing on its answer only if it has one and has given it, so a reveal flag
 * left over from an answer line the host has since deleted cannot put the walk on a state
 * that is no longer in the sequence.
 */
export function displayStateOf(page: PresentationPageState): PresentationDisplayState {
  return { slideId: page.id, revealed: page.hasAnswer && page.revealed };
}

/**
 * One step along the sequence.
 *
 * `from` is where the projector is standing, or null when it is not on a page at all —
 * the round's title card, or a page that has since been deleted. Both ends are named
 * rather than returning null: 'start' is the intro, 'end' is the end of the round, and
 * they mean different things to the caller.
 */
export function presentationStep(
  pages: PresentationPageState[],
  from: PresentationDisplayState | null,
  direction: 'NEXT' | 'PREVIOUS',
): { kind: 'state'; state: PresentationDisplayState } | { kind: 'start' } | { kind: 'end' } {
  const sequence = presentationSequence(pages);
  const visible = (entry: PresentationSequenceEntry) => !entry.hidden;

  if (!sequence.some(visible)) return direction === 'NEXT' ? { kind: 'end' } : { kind: 'start' };

  // Not on a page: forward is the first visible state, back is the intro. Entering a round
  // and stepping into it is the same movement as stepping from one page to the next.
  const at = from
    ? sequence.findIndex(entry => entry.slideId === from.slideId && entry.revealed === from.revealed)
    : -1;
  if (at < 0) {
    if (direction === 'PREVIOUS') return { kind: 'start' };
    const first = sequence.find(visible)!;
    return { kind: 'state', state: { slideId: first.slideId, revealed: first.revealed } };
  }

  const stride = direction === 'NEXT' ? 1 : -1;
  for (let i = at + stride; i >= 0 && i < sequence.length; i += stride) {
    if (!visible(sequence[i])) continue;
    return { kind: 'state', state: { slideId: sequence[i].slideId, revealed: sequence[i].revealed } };
  }
  return direction === 'NEXT' ? { kind: 'end' } : { kind: 'start' };
}
