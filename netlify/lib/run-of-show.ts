/**
 * The run of show: the host's single ordered timeline for the active round.
 *
 * Content blocks in their configured order, then the markets attached to that round
 * that have not been resolved yet. The Admin stages a step from this list, and GO LIVE
 * advances to the next one.
 *
 * This ordering is deliberately one pure function with two callers — `getAdminState`,
 * which renders the strip, and `promoteStaged`, which advances the staged pointer after
 * going live. If they disagreed by even one position, GO LIVE would skip or repeat a
 * step relative to what the host can see.
 */

export type RunOfShowStep =
  | { kind: 'block'; id: number; roundId: number; type: string; label: string }
  | { kind: 'prediction'; id: number; roundId: number; type: 'PREDICTION'; label: string };

type BlockRow = { id: number | string; round_id: number | string; type: string; title?: string | null; sort_order?: number | string };
type PredictionRow = { id: number | string; round_id?: number | string | null; status: string; question: string; display_number?: number | string };

const RESOLVED = ['SETTLED', 'CANCELLED'];

export function orderRunOfShow(blocks: BlockRow[], predictions: PredictionRow[], activeRoundId: number | null): RunOfShowStep[] {
  if (!activeRoundId) return [];

  const blockSteps: RunOfShowStep[] = blocks
    .filter(b => Number(b.round_id) === activeRoundId)
    .slice()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || Number(a.id) - Number(b.id))
    .map(b => ({ kind: 'block', id: Number(b.id), roundId: activeRoundId, type: b.type, label: b.title?.trim() || b.type }));

  const predictionSteps: RunOfShowStep[] = predictions
    .filter(p => p.round_id != null && Number(p.round_id) === activeRoundId && !RESOLVED.includes(p.status))
    .slice()
    .sort((a, b) => Number(a.display_number ?? 0) - Number(b.display_number ?? 0) || Number(a.id) - Number(b.id))
    .map(p => ({ kind: 'prediction', id: Number(p.id), roundId: activeRoundId, type: 'PREDICTION', label: p.question }));

  return [...blockSteps, ...predictionSteps];
}

export function indexOfStep(steps: RunOfShowStep[], kind: string | null, id: number | null) {
  if (!kind || !id) return -1;
  return steps.findIndex(step => step.kind === kind && step.id === id);
}

/** The step after `current`, or null at the end of the round. Never wraps — the host decides what follows. */
export function nextStep(steps: RunOfShowStep[], kind: string | null, id: number | null): RunOfShowStep | null {
  if (!steps.length) return null;
  const index = indexOfStep(steps, kind, id);
  if (index < 0) return steps[0];
  return steps[index + 1] ?? null;
}
