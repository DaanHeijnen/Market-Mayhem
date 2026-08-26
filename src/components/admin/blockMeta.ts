// Block-type vocabulary shared by the content picker, the run-of-show strip and the
// block cards. Colours are class names rather than hex so the accent palette stays in
// tokens.css (design handbook 02 — COLOR).
//
// `available` marks the types the database accepts (round_blocks type CHECK). All
// eight are permitted as of migration 0007; the flag stays so a future type can be
// designed and described here before its migration lands.
//
// `interactive` marks the types with a phone-side flow and a live state machine.
// BUZZER and WAGER are authorable and presentable but not interactive: the redesign
// specifies no phone UI or live controls for them.

export type BlockType = 'TEXT' | 'QUESTION' | 'DUOLINGO_QUESTION' | 'ROULETTE' | 'PICTURE' | 'MUSIC' | 'BUZZER' | 'WAGER';

export type BlockMeta = { label: string; description: string; accent: string; available: boolean; interactive: boolean };

export const BLOCK_META: Record<BlockType, BlockMeta> = {
  TEXT: { label: 'Info card', description: 'A static message everyone sees. No interaction.', accent: 'muted', available: true, interactive: false },
  QUESTION: { label: 'Open question', description: 'Shown on screen for group discussion. No phones, no scoring.', accent: 'orange', available: true, interactive: false },
  DUOLINGO_QUESTION: { label: 'Live quiz', description: 'Phones switch to 4 big answer buttons. Correct answers earn coins.', accent: 'violet', available: true, interactive: true },
  ROULETTE: { label: 'Roulette', description: 'Players place chips from their phones on a shared wheel.', accent: 'red', available: true, interactive: true },
  PICTURE: { label: 'Picture round', description: 'Show an image or clue on screen — players guess out loud.', accent: 'cyan', available: true, interactive: false },
  MUSIC: { label: 'Music round', description: 'Play a song snippet — first to shout the right answer scores.', accent: 'magenta', available: true, interactive: false },
  BUZZER: { label: 'Buzzer round', description: 'Fastest phone tap wins the point — quickfire trivia.', accent: 'blue', available: true, interactive: false },
  WAGER: { label: 'Wager round', description: 'Players stake their own coins on how confident they are, then answer.', accent: 'green', available: true, interactive: false },
};

const FALLBACK: BlockMeta = { label: 'Content block', description: '', accent: 'muted', available: false, interactive: false };

export function blockMeta(type: string): BlockMeta {
  return BLOCK_META[type as BlockType] || FALLBACK;
}

export function blockLabel(block: { type: string; title?: string | null }) {
  return block.title?.trim() || blockMeta(block.type).label;
}

/** Types offered in the content picker — only what the backend can actually store. */
export const AUTHORABLE_BLOCK_TYPES = (Object.keys(BLOCK_META) as BlockType[]).filter(type => BLOCK_META[type].available);

/** Types with a payload field for an uploaded file, and the payload key holding its blob key. */
export const MEDIA_BLOCK_KEYS: Partial<Record<BlockType, 'imageKey' | 'audioKey'>> = {
  PICTURE: 'imageKey',
  MUSIC: 'audioKey',
};
