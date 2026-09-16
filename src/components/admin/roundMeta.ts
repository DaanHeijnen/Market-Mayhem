// Round-type vocabulary shared by the create-round picker, the round list and the
// Control Center. Colours are class names rather than hex so the accent palette stays in
// tokens.css (design handbook 02 — COLOR).
//
// This mirrors ROUND_TYPES in netlify/lib/round-types.ts. The server is authoritative —
// it holds the CHECK constraint — and this file is what the host reads, so the two are
// kept deliberately in step.

export type RoundType = 'LIVE_QUIZ' | 'PRESENTATIE' | 'PUBQUIZ' | 'ROULETTE' | 'SLOTMACHINE' | 'PAK_EEN_ZES' | 'FOTORONDE';

export type RoundMeta = {
  label: string;
  description: string;
  accent: string;
  /** Round types whose content is an ordered list the host steps through. */
  stepped: boolean;
  /** What one item of this round's content is called, where it has items. */
  itemNoun: string | null;
  /** Whether the phones do anything during this round. */
  interactive: boolean;
};

export const ROUND_META: Record<RoundType, RoundMeta> = {
  LIVE_QUIZ: {
    label: 'Live quiz',
    description: 'Ordered questions. Phones show the answer buttons; correct answers earn the points you set per question.',
    accent: 'violet', stepped: true, itemNoun: 'question', interactive: true,
  },
  PRESENTATIE: {
    label: 'Presentatie',
    description: 'Ordered slides for the big screen — info, an image, a song, a question asked out loud. No phones, no scoring.',
    accent: 'cyan', stepped: true, itemNoun: 'slide', interactive: false,
  },
  PUBQUIZ: {
    label: 'Pubquiz',
    description: 'Ordered questions shown large on the big screen, one page at a time. Phones answer; the right answer earns the points you set.',
    accent: 'orange', stepped: true, itemNoun: 'question', interactive: true,
  },
  ROULETTE: {
    label: 'Roulette',
    description: 'Players place chips from their phones on a shared wheel.',
    accent: 'red', stepped: false, itemNoun: null, interactive: true,
  },
  SLOTMACHINE: {
    label: 'Slotmachine',
    description: 'Players lock a run of spins from their phones; the reels spin on the big screen.',
    accent: 'lime', stepped: false, itemNoun: null, interactive: true,
  },
  PAK_EEN_ZES: {
    label: 'Pak een Zes',
    description: 'Everyone predicts who draws a six, then players take turns pulling cards until all four sixes are out.',
    accent: 'ink', stepped: false, itemNoun: null, interactive: true,
  },
  FOTORONDE: {
    label: 'Fotoronde',
    description: 'Each team uploads one photo per subject from their phones; you award credits per photo.',
    accent: 'cyan-deep', stepped: false, itemNoun: 'subject', interactive: true,
  },
};

const FALLBACK: RoundMeta = { label: 'Round', description: '', accent: 'muted', stepped: false, itemNoun: null, interactive: false };

export function roundMeta(type: string): RoundMeta {
  return ROUND_META[type as RoundType] || FALLBACK;
}

/** Every type the Admin can create. */
export const ROUND_TYPES = Object.keys(ROUND_META) as RoundType[];

/** How many pieces of content a round holds, whatever kind of content that is. */
export function roundContentCount(round: any): number {
  if (!round) return 0;
  if (round.type === 'LIVE_QUIZ') return (round.questions || []).length;
  if (round.type === 'PRESENTATIE') return (round.slides || []).length;
  if (round.type === 'PUBQUIZ') return (round.pubquizQuestions || []).length;
  if (round.type === 'FOTORONDE') return (round.subjects || []).length;
  return 0;
}

/** The ordered items of a stepped round, or an empty list for the game types. */
export function roundItems(round: any): any[] {
  if (!round) return [];
  if (round.type === 'LIVE_QUIZ') return round.questions || [];
  if (round.type === 'PRESENTATIE') return round.slides || [];
  if (round.type === 'PUBQUIZ') return round.pubquizQuestions || [];
  return [];
}

/** What one item is called in the round list, without needing the round's type twice. */
export function describeContent(round: any): string {
  const meta = roundMeta(round?.type);
  if (!meta.itemNoun) return meta.label;
  const n = roundContentCount(round);
  return `${n} ${meta.itemNoun}${n === 1 ? '' : 's'}`;
}

/** The four emoji the quiz uses for its answer buttons, in option order. */
export const QUIZ_OPTION_EMOJIS = ['🍆', '🌽', '🍑', '😳', '🔥', '⭐'] as const;
