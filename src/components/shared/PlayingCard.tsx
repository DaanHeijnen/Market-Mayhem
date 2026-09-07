const SUIT_SYMBOLS: Record<string, string> = {
  HEARTS: '♥',
  DIAMONDS: '♦',
  CLUBS: '♣',
  SPADES: '♠',
};

/** Mirrors RED_SUITS in netlify/lib/pak-een-zes.ts — a face-only concern, no rule. */
const isRed = (suit: string) => suit === 'HEARTS' || suit === 'DIAMONDS';

export function suitSymbol(suit: string) {
  return SUIT_SYMBOLS[suit] || '?';
}

/**
 * One card face.
 *
 * The rank and suit come from the server; nothing here decides what a card is. `six`
 * marks the card the whole game is looking for, so the reveal can celebrate it without
 * the caller re-deriving the rule.
 */
export function PlayingCard({ rank, suit, size = 'large', six = false }: {
  rank: string;
  suit: string;
  size?: 'large' | 'small';
  six?: boolean;
}) {
  return <div className={`playing-card playing-card-${size} ${isRed(suit) ? 'is-red' : 'is-black'} ${six ? 'is-six' : ''}`}>
    <span className="playing-card-corner">{rank}</span>
    <span className="playing-card-pip">{suitSymbol(suit)}</span>
    <span className="playing-card-corner playing-card-corner-flip">{rank}</span>
  </div>;
}

/**
 * The deck, face down, thinning as cards come out.
 *
 * Purely decorative: the stack height is derived from how many cards are left so the
 * pile visibly shrinks over the game, which is the only feedback the room gets that the
 * deck is finite. Capped at a handful of layers because more than that reads as noise
 * from the back of the room.
 */
export function CardDeck({ cardsRemaining, drawing = false }: { cardsRemaining: number; drawing?: boolean }) {
  const layers = Math.max(1, Math.min(6, Math.ceil(cardsRemaining / 9)));
  return <div className={`card-deck ${drawing ? 'is-drawing' : ''}`} aria-hidden="true">
    {Array.from({ length: layers }, (_, index) => (
      <div className="card-deck-layer" key={index} style={{ transform: `translate(${index * -3}px, ${index * -3}px)` }} />
    ))}
    <div className="card-deck-count">{cardsRemaining}</div>
  </div>;
}
