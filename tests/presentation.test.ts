import { describe, expect, it } from 'vitest';
import { isSlideMediaKind, slideIsRevealed, slideTitleIsPublic, visibleNeighbours } from '../netlify/lib/presentation';
import { screenSlide, adminSlide } from '../netlify/lib/dto';

const slide = (extra: Record<string, unknown> = {}) => ({
  id: 5, round_id: 2, sort_order: 0,
  title: 'De Eiffeltoren', body: 'Welk gebouw?',
  media_key: 'pic-1', media_kind: 'IMAGE', media_name: null,
  reveal_text: 'Parijs, 1889', hide_title_until_reveal: true,
  revealed_at: null, revision: 0,
  ...extra,
});

describe('slide media', () => {
  it('accepts only the two kinds a slide can carry', () => {
    expect(isSlideMediaKind('IMAGE')).toBe(true);
    expect(isSlideMediaKind('AUDIO')).toBe(true);
    expect(isSlideMediaKind('VIDEO')).toBe(false);
    expect(isSlideMediaKind(null)).toBe(false);
  });
});

describe('when a slide gives up its secret', () => {
  it('is revealed exactly when it has a reveal timestamp', () => {
    expect(slideIsRevealed(null)).toBe(false);
    expect(slideIsRevealed(undefined)).toBe(false);
    expect(slideIsRevealed(new Date())).toBe(true);
  });

  // A picture or music slide's title IS the answer, which is the whole reason the flag
  // exists. A slide without the flag has a title that was never secret.
  it('hides a title that is the answer until the reveal', () => {
    expect(slideTitleIsPublic(true, null)).toBe(false);
    expect(slideTitleIsPublic(true, new Date())).toBe(true);
    expect(slideTitleIsPublic(false, null)).toBe(true);
  });
});

describe('what leaves the server', () => {
  // Not sent as null-with-a-flag: a value that is not on the wire cannot be read off it.
  it('sends no title and no reveal line before the host reveals', () => {
    const payload = screenSlide(slide());
    expect(payload.title).toBeNull();
    expect(payload.titleHidden).toBe(true);
    expect(payload).not.toHaveProperty('revealText');
  });

  it('sends both once revealed', () => {
    const payload = screenSlide(slide({ revealed_at: new Date() }));
    expect(payload.title).toBe('De Eiffeltoren');
    expect(payload.titleHidden).toBe(false);
    expect((payload as any).revealText).toBe('Parijs, 1889');
  });

  it('sends a plain slide its title from the start', () => {
    const payload = screenSlide(slide({ hide_title_until_reveal: false, reveal_text: null }));
    expect(payload.title).toBe('De Eiffeltoren');
    expect(payload.titleHidden).toBe(false);
  });

  it('sends the projector only the fields it was built with', () => {
    const payload = screenSlide(slide());
    expect(Object.keys(payload).sort()).toEqual([
      'body', 'id', 'mediaKey', 'mediaKind', 'revealed', 'sortOrder', 'title', 'titleHidden',
    ]);
  });

  it('gives the Admin the reveal line at every phase', () => {
    const payload = adminSlide(slide());
    expect(payload.revealText).toBe('Parijs, 1889');
    expect(payload.title).toBe('De Eiffeltoren');
    expect(payload.hideTitleUntilReveal).toBe(true);
  });
});

/* --- the projector's roulette payload ------------------------------------ */
import { screenRoulette } from '../netlify/lib/dto';

describe('what the projector receives about the roulette', () => {
  const table = (status: string, resultNumber: number | null = 17) => ({
    id: 4, round_id: 3, status, result_number: resultNumber, spun_at: null,
    public_bets: [{ id: 1, displayName: 'Daan', color: '#f00', betType: 'COLOR', selection: 'RED', stake: 10 }],
  });

  // The wheel spins seven turns and lands on the pocket the server already chose, so it
  // needs the number while the wheel is still turning. Withholding it would make the
  // wheel jump to the answer rather than land on it.
  it('sends the winning number while the wheel is still spinning', () => {
    expect(screenRoulette(table('SPINNING'))!.resultNumber).toBe(17);
    expect(screenRoulette(table('RESULT'))!.resultNumber).toBe(17);
  });

  it('sends no number before one has been chosen', () => {
    expect(screenRoulette(table('OPEN', null))!.resultNumber).toBeNull();
  });

  // Built, not spread: the row it replaced was a SELECT rg.* going onto a public snapshot.
  it('sends only the fields it was built with', () => {
    expect(Object.keys(screenRoulette(table('OPEN'))!).sort())
      .toEqual(['id', 'publicBets', 'resultNumber', 'roundId', 'runNumber', 'spunAt', 'status']);
  });

  // A run's financial summary is the one thing that must not arrive early: before the
  // wheel has paid out, the key is absent rather than zero.
  it('sends no settlement summary until the run has paid out', () => {
    for (const status of ['OPEN', 'LOCKED', 'SPINNING', 'RESULT']) {
      expect(screenRoulette(table(status)), status).not.toHaveProperty('settlement');
    }
  });

  it('sends the three totals once the run is settled, with net already subtracted', () => {
    const settled = screenRoulette({
      ...table('SETTLED'), total_staked: 1200, total_payout: 900,
      participant_count: 8, eligible_players: 10,
    })!;
    expect(settled.settlement).toEqual({
      staked: 1200,
      payout: 900,
      // Players are 300 down over the run. Sent computed so the projector cannot render
      // gross payout and net result the wrong way round.
      net: -300,
      participants: 8,
      eligiblePlayers: 10,
      participationPercentage: 80,
    });
  });

  // The room is meant to see whose chips these are; it has no use for a player id.
  it('names the player on a chip but never their id', () => {
    const [chip] = screenRoulette(table('OPEN'))!.publicBets;
    expect(chip.displayName).toBe('Daan');
    expect(chip).not.toHaveProperty('playerId');
  });

  it('is null when there is no table', () => {
    expect(screenRoulette(null)).toBeNull();
  });
});

/**
 * Which page previous/next land on.
 *
 * The brief's own example, written out: with page 2 held back, stepping forward from
 * page 1 reaches page 3, and making page 2 visible again restores 1 → 2 → 3 without
 * anything being renumbered.
 */
describe('stepping through a presentation', () => {
  const pages = (...hidden: number[]) =>
    [1, 2, 3].map(id => ({ id, hidden: hidden.includes(id) }));

  it('skips a held-back page going forward', () => {
    expect(visibleNeighbours(pages(2), 1).next).toEqual({ id: 3, hidden: false });
  });

  it('skips it going back as well', () => {
    expect(visibleNeighbours(pages(2), 3).previous).toEqual({ id: 1, hidden: false });
  });

  it('restores the plain order once the page is visible again', () => {
    expect(visibleNeighbours(pages(), 1).next).toEqual({ id: 2, hidden: false });
    expect(visibleNeighbours(pages(), 3).previous).toEqual({ id: 2, hidden: false });
  });

  it('skips a run of held-back pages rather than only one', () => {
    expect(visibleNeighbours([...pages(2, 3), { id: 4, hidden: false }], 1).next).toEqual({ id: 4, hidden: false });
  });

  it('has nowhere to go past the last visible page', () => {
    expect(visibleNeighbours(pages(3), 2).next).toBeNull();
    expect(visibleNeighbours(pages(1), 2).previous).toBeNull();
  });

  // The case a filtered list gets wrong: the host holds back the page that is currently
  // up, so the cursor stands on a page that is no longer in the run. Stepping still has
  // to mean the nearest visible page in that direction.
  it('still steps sensibly from a page that was just held back', () => {
    const around = visibleNeighbours(pages(2), 2);
    expect(around.currentIsHidden).toBe(true);
    expect(around.previous).toEqual({ id: 1, hidden: false });
    expect(around.next).toEqual({ id: 3, hidden: false });
    // and it is nowhere in the run, so the counter cannot claim a position
    expect(around.visibleIndex).toBe(-1);
    expect(around.visibleCount).toBe(2);
  });

  it('starts at the first visible page when the cursor is nowhere', () => {
    expect(visibleNeighbours(pages(1), null).first).toEqual({ id: 2, hidden: false });
    expect(visibleNeighbours(pages(1), null).at).toBe(-1);
  });

  it('counts the run, not the authored list', () => {
    expect(visibleNeighbours(pages(2), 1).visibleCount).toBe(2);
    expect(visibleNeighbours(pages(), 1).visibleCount).toBe(3);
    expect(visibleNeighbours(pages(1, 2, 3), 1).visibleCount).toBe(0);
  });
});

describe('what each audience is told about a page', () => {
  it('tells the Admin whether a page is in the run', () => {
    expect(adminSlide(slide({ hidden: true })).hidden).toBe(true);
    expect(adminSlide(slide({ hidden: false })).hidden).toBe(false);
    // absent on the row entirely — an older query, or the projector's — reads as visible
    expect(adminSlide(slide()).hidden).toBe(false);
  });

  // The projector is only ever pointed at a page in the run, so the flag would always say
  // the same thing — and which pages a host is holding back is planning, not something
  // the room is entitled to.
  it('tells the projector nothing about held-back pages', () => {
    const shown = screenSlide(slide({ hidden: false, revealed_at: new Date() }));
    expect(shown).not.toHaveProperty('hidden');
    expect(Object.keys(shown)).toEqual(
      expect.not.arrayContaining(['hidden', 'hideTitleUntilReveal', 'mediaName', 'roundId', 'revision']),
    );
  });
});

/**
 * The round's title card, on the projector.
 *
 * Not a row of its own: it is the round the host already authored, given a moment on
 * screen. This is the shape the scene renders, and the reason there is no intro table.
 */
describe('what the projector is told about a round intro', () => {
  it('carries the round\'s own words and nothing invented', () => {
    const intro = {
      type: 'PUBQUIZ', sortOrder: 3, title: 'Algemene kennis',
      description: 'Tien vragen.', instructions: 'Antwoord op je telefoon.', itemCount: 10,
    };
    expect(Object.keys(intro).sort())
      .toEqual(['description', 'instructions', 'itemCount', 'sortOrder', 'title', 'type']);
  });
});
