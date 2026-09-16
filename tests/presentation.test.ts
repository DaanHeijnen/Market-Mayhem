import { describe, expect, it } from 'vitest';
import { isSlideMediaKind, slideIsRevealed, slideTitleIsPublic } from '../netlify/lib/presentation';
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
      .toEqual(['id', 'publicBets', 'resultNumber', 'roundId', 'spunAt', 'status']);
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
