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
export function visibleNeighbours(pages: PresentationPage[], currentId: number | null) {
  const at = pages.findIndex(page => page.id === currentId);
  const visible = pages.filter(page => !page.hidden);

  let previous: PresentationPage | null = null;
  let next: PresentationPage | null = null;
  if (at >= 0) {
    for (let i = at - 1; i >= 0; i -= 1) if (!pages[i].hidden) { previous = pages[i]; break; }
    for (let i = at + 1; i < pages.length; i += 1) if (!pages[i].hidden) { next = pages[i]; break; }
  }

  const currentPage = at >= 0 ? pages[at] : null;
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
