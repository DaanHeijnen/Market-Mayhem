/**
 * Fotoronde rules: the subject list, the phase machine and the credit split.
 *
 * Every team gets the same list of photo subjects. One player uploads on behalf of their
 * team, one photo per team per subject, and the Admin then awards credits per photo which
 * are split across that team's active members.
 *
 * Everything here is pure so the parts that decide money can be tested without a
 * database. The endpoints own locking and persistence; this file owns the rules.
 */

export type PhotoSubject = { key: string; label: string };

/**
 * The six subjects a Fotoronde starts with.
 *
 * `key` is what a submission is filed under, so it must stay stable: renaming a subject
 * keeps the photos attached to it, which is why the label is not the identity.
 */
export const DEFAULT_PHOTO_SUBJECTS: PhotoSubject[] = [
  { key: 'kunstigs', label: 'Iets kunstigs' },
  { key: 'lelijks', label: 'Iets lelijks' },
  { key: 'moois', label: 'Iets moois' },
  { key: 'opwindends', label: 'Iets opwindends' },
  { key: 'geloof', label: 'Iets wat met het geloof heeft te maken' },
  { key: 'kinderlijks', label: 'Iets kinderlijks' },
];

export const MAX_PHOTO_SUBJECTS = 20;
export const SUBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A label turned into a stable key. Used when the Admin adds a subject. */
export function subjectKeyFromLabel(label: string, taken: string[] = []): string {
  const base = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'onderwerp';
  if (!taken.includes(base)) return base;
  // Suffix rather than overwrite: two subjects may legitimately read alike, and a
  // collision must never make one inherit the other's photos.
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 40);
    if (!taken.includes(candidate)) return candidate;
  }
  throw new Error('Could not derive a unique subject key');
}

export function normalizeSubjects(raw: unknown): PhotoSubject[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_PHOTO_SUBJECTS;
  const seen: string[] = [];
  const subjects: PhotoSubject[] = [];
  for (const entry of raw.slice(0, MAX_PHOTO_SUBJECTS)) {
    const label = typeof (entry as any)?.label === 'string' ? (entry as any).label.trim() : '';
    if (!label) continue;
    const proposed = typeof (entry as any)?.key === 'string' && SUBJECT_KEY_PATTERN.test((entry as any).key)
      ? (entry as any).key
      : subjectKeyFromLabel(label, seen);
    const key = seen.includes(proposed) ? subjectKeyFromLabel(label, seen) : proposed;
    seen.push(key);
    subjects.push({ key, label: label.slice(0, 200) });
  }
  return subjects.length ? subjects : DEFAULT_PHOTO_SUBJECTS;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export const PHOTO_ROUND_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'COMPLETED'] as const;
export type PhotoRoundStatus = typeof PHOTO_ROUND_STATUSES[number];

export const PHOTO_ROUND_LABELS: Record<PhotoRoundStatus, string> = {
  DRAFT: 'Nog niet open',
  OPEN: 'Inzenden open',
  CLOSED: 'Inzenden gesloten',
  COMPLETED: 'Afgerond',
};

/**
 * Forward-only, and uploads live in exactly one phase.
 *
 * Closing is what makes judging meaningful: a photo cannot be swapped after the Admin has
 * started looking at it. There is no route back to OPEN for the same reason.
 */
const ALLOWED: Record<PhotoRoundStatus, PhotoRoundStatus[]> = {
  DRAFT: ['OPEN', 'CLOSED'],
  OPEN: ['CLOSED'],
  CLOSED: ['COMPLETED'],
  COMPLETED: [],
};

export function canTransition(from: PhotoRoundStatus, to: PhotoRoundStatus) {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function isPhotoRoundStatus(value: unknown): value is PhotoRoundStatus {
  return typeof value === 'string' && (PHOTO_ROUND_STATUSES as readonly string[]).includes(value);
}

/** Uploading and replacing are allowed in exactly one phase. */
export function acceptsUploads(status: PhotoRoundStatus) {
  return status === 'OPEN';
}

/** Judging is allowed once uploads have stopped, and stays allowed afterwards. */
export function acceptsAwards(status: PhotoRoundStatus) {
  return status === 'CLOSED' || status === 'COMPLETED';
}

// ---------------------------------------------------------------------------
// Credit distribution
// ---------------------------------------------------------------------------

export type CreditShare = { playerId: number; amount: number };

/**
 * Split a photo's credits across a team's members.
 *
 * One consistent rule: everyone gets `floor(credits / members)`, and the remainder is
 * handed out one credit at a time down the member order. So 25 credits across 4 players
 * pays 7, 6, 6, 6 — the total is always exactly what the Admin awarded, which is what
 * stops credits being lost to rounding or invented by rounding up.
 *
 * `memberIds` must arrive in a stable order (the callers sort by display name, then id),
 * because that order decides who receives the extra credit. Same input, same split, every
 * time — including on a retry.
 */
export function distributeCredits(credits: number, memberIds: number[]): CreditShare[] {
  if (!memberIds.length) return [];
  if (credits <= 0) return memberIds.map(playerId => ({ playerId, amount: 0 }));

  const base = Math.floor(credits / memberIds.length);
  const remainder = credits % memberIds.length;
  return memberIds.map((playerId, index) => ({
    playerId,
    amount: base + (index < remainder ? 1 : 0),
  }));
}

/** How the split reads in the Admin interface, e.g. "7 + 6 + 6 + 6". */
export function describeDistribution(credits: number, memberCount: number): string {
  if (memberCount <= 0) return 'no players in this team';
  if (credits <= 0) return 'no credits';
  const base = Math.floor(credits / memberCount);
  const remainder = credits % memberCount;
  if (remainder === 0) return `${memberCount} × ${base}`;
  return `${remainder} × ${base + 1} + ${memberCount - remainder} × ${base}`;
}
