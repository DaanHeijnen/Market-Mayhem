/**
 * Turning what the host typed into something a room can read from ten metres away.
 *
 * Authored text is plain text — a `<textarea>` in the Admin — and it arrives with the
 * structure the host gave it: paragraphs separated by blank lines, list items on their own
 * lines, the odd indent. HTML collapses every one of those into a single run of words, so
 * a carefully laid-out set of instructions reached the projector as a wall.
 *
 * The fix is not to interpret the text. It is still plain text and is still rendered as
 * plain text — never as markup — so nothing a host types can become an element. What this
 * does is *preserve* the shape they already gave it:
 *
 *   - paragraphs become real paragraphs, which is what gives them space between them
 *   - line breaks inside a paragraph survive, so a list stays a list
 *   - indentation survives, because tabs become spaces and spaces are kept
 *
 * Pure and DOM-free, so the rules can be tested without rendering anything.
 */

/** A tab is a variable amount of nothing on a projector. Two spaces is predictable. */
const TAB_AS = '  ';

/** Beyond this, a line of spaces is a layout attempt that will overflow the screen. */
const MAX_INDENT = 8;

export function normalizeAuthoredText(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  return raw
    // One line ending, whatever the host's keyboard produced.
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const withoutTabs = line.replace(/\t/g, TAB_AS);
      // Indentation is kept but bounded: a deeply indented line would otherwise push the
      // text off the side of a screen nobody can scroll.
      const indent = withoutTabs.length - withoutTabs.trimStart().length;
      return ' '.repeat(Math.min(indent, MAX_INDENT)) + withoutTabs.trim();
    })
    .join('\n')
    // Any run of blank lines reads as one break. Three of them is a mistake, not emphasis.
    .replace(/\n{3,}/g, '\n\n')
    // Blank lines at either end are trimmed — but only the blank lines. A plain `trim()`
    // would also eat the indentation of the very first line, which is the one place the
    // host most obviously meant it.
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/**
 * The text as paragraphs, each a block of lines.
 *
 * Empty when there is nothing to show, so a caller can render nothing rather than an empty
 * element that still takes up space.
 */
export function toParagraphs(raw: unknown): string[] {
  const text = normalizeAuthoredText(raw);
  if (!text) return [];
  return text.split('\n\n').filter(paragraph => paragraph.length > 0);
}
