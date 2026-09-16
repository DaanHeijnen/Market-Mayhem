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
