import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeAuthoredText, toParagraphs } from '../src/lib/authored-text';
import { AuthoredText } from '../src/components/shared/AuthoredText';
import { ScreenRender } from '../src/components/broadcast/BigScreen';

/**
 * What the host typed, as the room sees it.
 *
 * The complaint this answers: a carefully laid out set of instructions — paragraphs, a
 * blank line, a short list — arrived on the projector as one unbroken block, because HTML
 * collapses every newline it is given. So the tests are about structure surviving, and
 * about it surviving *as text*: nothing here may turn into markup.
 */

const INSTRUCTIONS = [
  'Welkom bij deze ronde.',
  '',
  'Jullie krijgen 15 minuten de tijd.',
  '',
  'Let op:',
  '- Maak per onderwerp één foto.',
  '- Overleg binnen je team.',
  '- Je kunt een foto vervangen zolang de timer loopt.',
  '',
  'Succes!',
].join('\n');

describe('authored text', () => {
  it('splits on blank lines into paragraphs', () => {
    expect(toParagraphs(INSTRUCTIONS)).toEqual([
      'Welkom bij deze ronde.',
      'Jullie krijgen 15 minuten de tijd.',
      'Let op:\n- Maak per onderwerp één foto.\n- Overleg binnen je team.\n- Je kunt een foto vervangen zolang de timer loopt.',
      'Succes!',
    ]);
  });

  it('keeps the line breaks inside a paragraph', () => {
    const [list] = toParagraphs('Let op:\n- Een\n- Twee');
    expect(list.split('\n')).toHaveLength(3);
  });

  it('reads one break out of any run of blank lines', () => {
    expect(toParagraphs('Een\n\n\n\n\nTwee')).toEqual(['Een', 'Twee']);
  });

  it('accepts whatever line ending the host’s keyboard produced', () => {
    expect(toParagraphs('Een\r\n\r\nTwee')).toEqual(['Een', 'Twee']);
    expect(toParagraphs('Een\r\rTwee')).toEqual(['Een', 'Twee']);
  });

  it('turns tabs into spaces, because a tab is nothing in particular on a projector', () => {
    expect(normalizeAuthoredText('\tIngesprongen')).toBe('  Ingesprongen');
  });

  it('keeps indentation, but not enough of it to push text off the screen', () => {
    expect(normalizeAuthoredText(' '.repeat(40) + 'Ver weg')).toBe(' '.repeat(8) + 'Ver weg');
  });

  it('drops trailing whitespace a host cannot see anyway', () => {
    expect(normalizeAuthoredText('Een   \nTwee\t\n\n')).toBe('Een\nTwee');
  });

  it('has nothing to say about nothing', () => {
    expect(toParagraphs('')).toEqual([]);
    expect(toParagraphs('   \n\n  ')).toEqual([]);
    expect(toParagraphs(null)).toEqual([]);
    expect(toParagraphs(undefined)).toEqual([]);
    expect(toParagraphs(42)).toEqual([]);
  });
});

describe('authored text, rendered', () => {
  const render = (text: unknown) => renderToStaticMarkup(createElement(AuthoredText, { text }));

  it('gives each paragraph its own element, which is where the spacing comes from', () => {
    const html = render(INSTRUCTIONS);
    expect(html.match(/<p>/g)).toHaveLength(4);
    expect(html).toContain('Maak per onderwerp één foto.');
  });

  it('renders nothing at all when there is nothing to show', () => {
    expect(render('')).toBe('');
    expect(render(null)).toBe('');
  });

  // Plain text in, plain text out. The structure comes from real elements, never from
  // anything the host typed being interpreted.
  it('never lets authored text become markup', () => {
    const html = render('<script>alert(1)</script>\n\n<b>vet</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>vet</b>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('a round’s instructions on the projector', () => {
  const intro = (instructions: string) => renderToStaticMarkup(createElement(ScreenRender, {
    s: {
      mode: 'ROUND_INTRO',
      game: { id: 1, name: 'Market Mayhem' },
      round: { id: 3, sortOrder: 3, title: 'Fotoronde', type: 'FOTORONDE' },
      roundIntro: {
        type: 'FOTORONDE', sortOrder: 3, title: 'Fotoronde',
        description: '', instructions, itemCount: 6,
      },
      leaderboard: [], ticker: [], marketsOpen: 0, totalCoinsInPlay: 0, recentPredictionResults: [],
    },
    error: '',
  }));

  it('keeps the shape the host gave it', () => {
    const html = intro(INSTRUCTIONS);
    // Four paragraphs, and the list still on four lines inside its own.
    expect(html.match(/<p>/g)).toHaveLength(4);
    expect(html).toContain('Let op:\n- Maak per onderwerp één foto.');
    expect(html).toContain('authored-text');
  });

  it('does not collapse it into one run of words', () => {
    const html = intro(INSTRUCTIONS);
    expect(html).not.toContain('Welkom bij deze ronde. Jullie krijgen');
  });
});
