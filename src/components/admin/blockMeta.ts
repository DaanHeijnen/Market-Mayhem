// Block-type vocabulary shared by the content picker, the run-of-show strip and the
// block cards. Colours are class names rather than hex so the accent palette stays in
// tokens.css (design handbook 02 — COLOR).
//
// `available` marks the four types the database currently accepts
// (round_blocks type CHECK, migration 0006). The other four are authored in the design
// and land with their own migration; they stay listed so the vocabulary is complete.

export type BlockType = 'TEXT' | 'QUESTION' | 'DUOLINGO_QUESTION' | 'ROULETTE' | 'PICTURE' | 'MUSIC' | 'BUZZER' | 'WAGER';

export type BlockMeta = { label: string; description: string; accent: string; available: boolean };

export const BLOCK_META: Record<BlockType, BlockMeta> = {
  TEXT: { label: 'Info card', description: 'A static message everyone sees. No interaction.', accent: 'muted', available: true },
  QUESTION: { label: 'Open question', description: 'Shown on screen for group discussion. No phones, no scoring.', accent: 'orange', available: true },
  DUOLINGO_QUESTION: { label: 'Live quiz', description: 'Phones switch to 4 big answer buttons. Correct answers earn coins.', accent: 'violet', available: true },
  ROULETTE: { label: 'Roulette', description: 'Players place chips from their phones on a shared wheel.', accent: 'red', available: true },
  PICTURE: { label: 'Picture round', description: 'Show an image or clue on screen — players guess out loud.', accent: 'cyan', available: false },
  MUSIC: { label: 'Music round', description: 'Play a song snippet — first to shout the right answer scores.', accent: 'magenta', available: false },
  BUZZER: { label: 'Buzzer round', description: 'Fastest phone tap wins the point — quickfire trivia.', accent: 'blue', available: false },
  WAGER: { label: 'Wager round', description: 'Players stake their own coins on how confident they are, then answer.', accent: 'green', available: false },
};

const FALLBACK: BlockMeta = { label: 'Content block', description: '', accent: 'muted', available: false };

export function blockMeta(type: string): BlockMeta {
  return BLOCK_META[type as BlockType] || FALLBACK;
}

export function blockLabel(block: { type: string; title?: string | null }) {
  return block.title?.trim() || blockMeta(block.type).label;
}

/** Types offered in the content picker — only what the backend can currently store. */
export const AUTHORABLE_BLOCK_TYPES = (Object.keys(BLOCK_META) as BlockType[]).filter(type => BLOCK_META[type].available);
