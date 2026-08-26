import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { orderRunOfShow, nextStep } from './run-of-show';

export const SCREEN_MODES = [
  'DASHBOARD',
  'ROUND_BLOCK',
  'PREDICTIONS_OPEN',
  'PREDICTION_LOCKED',
  'PREDICTION_RESULT',
  'ROULETTE',
] as const;
export type ScreenMode = typeof SCREEN_MODES[number];

export function screenModeValue(value: unknown): ScreenMode {
  if (typeof value !== 'string' || !SCREEN_MODES.includes(value as ScreenMode)) throw new HttpError(400, 'Invalid screen mode');
  return value as ScreenMode;
}

export async function incrementGameVersion(client: PoolClient, gameId: number) {
  const { rows } = await client.query<{ game_state_version: string }>(
    `UPDATE game_nights SET game_state_version=game_state_version+1,updated_at=NOW() WHERE id=$1 RETURNING game_state_version`,
    [gameId],
  );
  if (!rows[0]) throw new HttpError(404, 'Game not found');
  return Number(rows[0].game_state_version);
}

export async function setScreenMode(
  client: PoolClient,
  gameId: number,
  mode: ScreenMode,
  actor: string,
  options: { roundId?: number|null; blockId?: number|null; predictionId?: number|null; payload?: unknown; remember?: boolean } = {},
) {
  const game = await client.query('SELECT id,current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');

  // `remember` is for the deliberate "show standings for a moment" detour, so
  // BACK TO RUN OF SHOW can restore this exact presentation. It is opt-in because the
  // other route to DASHBOARD is clearScreenIfReferences, which fires when the thing on
  // screen was deleted — there is nothing there worth returning to.
  if (options.remember) {
    await client.query(
      `UPDATE screen_state
       SET previous_mode=mode,previous_round_id=round_id,previous_prediction_id=prediction_id,previous_payload=payload
       WHERE game_night_id=$1`,
      [gameId],
    );
  }

  let roundId = options.roundId ?? null;
  let predictionId = options.predictionId ?? null;
  const blockId = options.blockId ?? null;
  const payload = { ...(typeof options.payload === 'object' && options.payload ? options.payload as object : {}), blockId };



  if (mode === 'DASHBOARD') {
    roundId = null;
    predictionId = null;
  }
  if (mode === 'ROUND_BLOCK' || mode === 'ROULETTE') {
    if (!roundId || !blockId) throw new HttpError(400, 'roundId and blockId are required');
    if (Number(game.rows[0].current_round_id || 0) !== roundId) throw new HttpError(409, 'Only the active round can be presented');
    const block = await client.query(
      `SELECT b.type,r.status FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.round_id=$2 AND b.game_night_id=$3`,
      [blockId, roundId, gameId],
    );
    if (!block.rows[0]) throw new HttpError(404, 'Round block not found');
    if (block.rows[0].status !== 'ACTIVE') throw new HttpError(409, 'Only an active round can present content');
    if (mode === 'ROULETTE' && block.rows[0].type !== 'ROULETTE') throw new HttpError(409, 'ROULETTE mode requires a roulette block');
    if (mode === 'ROUND_BLOCK' && block.rows[0].type === 'ROULETTE') throw new HttpError(409, 'Roulette blocks must use ROULETTE mode');
    predictionId = null;
  }
  if (mode.startsWith('PREDICTION')) {
    if (!predictionId) throw new HttpError(400, 'predictionId is required');
    const p = await client.query('SELECT round_id,status,result,closes_at,(closes_at IS NOT NULL AND closes_at<=NOW()) AS expired FROM predictions WHERE id=$1 AND game_night_id=$2', [predictionId, gameId]);
    if (!p.rows[0]) throw new HttpError(404, 'Prediction not found');
    const allowed: Record<string,string[]> = {
      PREDICTIONS_OPEN: ['OPEN'],
      PREDICTION_LOCKED: ['LOCKED','RESULT'],
      PREDICTION_RESULT: ['RESULT','SETTLED'],
    };
    if (!allowed[mode]?.includes(p.rows[0].status)) throw new HttpError(409, `${mode} is not valid while prediction is ${p.rows[0].status}`);
    if (mode === 'PREDICTIONS_OPEN' && (!p.rows[0].closes_at || p.rows[0].expired)) throw new HttpError(409, 'Prediction timer has expired');
    roundId = p.rows[0].round_id ? Number(p.rows[0].round_id) : null;
  }

  await client.query(
    `INSERT INTO screen_state(game_night_id,mode,round_id,prediction_id,payload,updated_by)
     VALUES($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT(game_night_id) DO UPDATE SET mode=EXCLUDED.mode,round_id=EXCLUDED.round_id,prediction_id=EXCLUDED.prediction_id,payload=EXCLUDED.payload,updated_at=NOW(),updated_by=EXCLUDED.updated_by`,
    [gameId, mode, roundId, predictionId, JSON.stringify(payload), actor],
  );
  await client.query('UPDATE game_nights SET current_screen_mode=$2,updated_at=NOW() WHERE id=$1', [gameId, mode]);
}

export async function setActiveRoundBlock(client: PoolClient, gameId: number, roundId: number, blockId: number, actor: string) {
  const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');
  if (Number(game.rows[0].current_round_id || 0) !== roundId) throw new HttpError(409, 'Only the active round can present content');

  const block = await client.query('SELECT id,type FROM round_blocks WHERE id=$1 AND round_id=$2 AND game_night_id=$3', [blockId, roundId, gameId]);
  if (!block.rows[0]) throw new HttpError(404, 'Round block not found');

  const previousBlockId = Number(game.rows[0].current_round_block_id || 0) || null;
  if (previousBlockId && previousBlockId !== blockId) {
    const previousQuestion = await client.query(
      `SELECT interactive_status FROM round_blocks
       WHERE id=$1 AND game_night_id=$2 AND type='DUOLINGO_QUESTION' FOR UPDATE`,
      [previousBlockId, gameId],
    );
    if (previousQuestion.rows[0] && ['OPEN','CLOSED','REVEALED'].includes(previousQuestion.rows[0].interactive_status)) {
      throw new HttpError(409, 'Finish the current live question before changing content');
    }

    const previousRoulette = await client.query(
      `SELECT id,status FROM roulette_games
       WHERE game_night_id=$1 AND round_block_id=$2 AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [gameId, previousBlockId],
    );
    if (previousRoulette.rows[0] && ['OPEN','LOCKED','SPINNING','RESULT'].includes(previousRoulette.rows[0].status)) {
      throw new HttpError(409, 'Finish or cancel the current roulette game before changing content');
    }
    if (previousRoulette.rows[0]?.status === 'DRAFT') {
      await client.query("UPDATE roulette_games SET status='CANCELLED',settled_at=NOW(),updated_at=NOW() WHERE id=$1", [previousRoulette.rows[0].id]);
    }
  }

  await client.query('UPDATE game_nights SET current_round_block_id=$2,updated_at=NOW() WHERE id=$1', [gameId, blockId]);

  if (block.rows[0].type === 'ROULETTE') {
    const otherLive = await client.query(
      `SELECT id,round_block_id,status FROM roulette_games
       WHERE game_night_id=$1 AND round_block_id<>$2 AND status IN ('OPEN','LOCKED','SPINNING','RESULT')
       LIMIT 1 FOR UPDATE`,
      [gameId, blockId],
    );
    if (otherLive.rows[0]) throw new HttpError(409, 'Another roulette game must be settled or cancelled first');
    await client.query(
      `UPDATE roulette_games SET status='CANCELLED',settled_at=NOW(),updated_at=NOW()
       WHERE game_night_id=$1 AND round_block_id<>$2 AND status='DRAFT'`,
      [gameId, blockId],
    );
    await client.query(
      `INSERT INTO roulette_games(game_night_id,round_id,round_block_id,status)
       SELECT $1,$2,$3,'DRAFT'
       WHERE NOT EXISTS (SELECT 1 FROM roulette_games WHERE game_night_id=$1 AND round_block_id=$3 AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT'))`,
      [gameId, roundId, blockId],
    );
    const roulette = await client.query(
      `SELECT id FROM roulette_games WHERE game_night_id=$1 AND round_block_id=$2 AND status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT') ORDER BY id DESC LIMIT 1`,
      [gameId, blockId],
    );
    await setScreenMode(client, gameId, 'ROULETTE', actor, { roundId, blockId, payload: { rouletteGameId: roulette.rows[0] ? Number(roulette.rows[0].id) : null } });
  } else {
    await setScreenMode(client, gameId, 'ROUND_BLOCK', actor, { roundId, blockId });
  }
}

// ---------------------------------------------------------------------------
// Presenter model: stage a step, preview it, then push it live.
// ---------------------------------------------------------------------------

export type StagedItem =
  | { kind: 'dashboard' }
  | { kind: 'block'; roundId: number; blockId: number }
  | { kind: 'prediction'; predictionId: number };

/** Read the ordered run of show for the game's active round. */
async function loadRunOfShow(client: PoolClient, gameId: number) {
  const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1', [gameId]);
  const activeRoundId = Number(game.rows[0]?.current_round_id || 0) || null;
  if (!activeRoundId) return [];
  const [blocks, predictions] = await Promise.all([
    client.query('SELECT id,round_id,type,title,sort_order FROM round_blocks WHERE game_night_id=$1 AND round_id=$2', [gameId, activeRoundId]),
    client.query('SELECT id,round_id,status,question,display_number FROM predictions WHERE game_night_id=$1 AND round_id=$2', [gameId, activeRoundId]),
  ]);
  return orderRunOfShow(blocks.rows, predictions.rows, activeRoundId);
}

/**
 * Record what the host intends to show next.
 *
 * Deliberately almost side-effect free: it validates that the target exists and belongs
 * to this game, and nothing else. It does NOT require the round to be active, create a
 * roulette game, or touch game_nights — staging must never change what the audience is
 * looking at. All of that happens in promoteStaged, which reuses the existing guarded
 * live transitions.
 */
export async function setStagedItem(client: PoolClient, gameId: number, item: StagedItem, actor: string) {
  let mode: ScreenMode = 'DASHBOARD';
  let roundId: number | null = null;
  let predictionId: number | null = null;
  let blockId: number | null = null;

  if (item.kind === 'block') {
    const block = await client.query(
      'SELECT b.id,b.type FROM round_blocks b WHERE b.id=$1 AND b.round_id=$2 AND b.game_night_id=$3',
      [item.blockId, item.roundId, gameId],
    );
    if (!block.rows[0]) throw new HttpError(404, 'Round block not found');
    mode = block.rows[0].type === 'ROULETTE' ? 'ROULETTE' : 'ROUND_BLOCK';
    roundId = item.roundId;
    blockId = item.blockId;
  }

  if (item.kind === 'prediction') {
    const prediction = await client.query('SELECT id,round_id,status FROM predictions WHERE id=$1 AND game_night_id=$2', [item.predictionId, gameId]);
    if (!prediction.rows[0]) throw new HttpError(404, 'Prediction not found');
    const status = prediction.rows[0].status;
    // Staged mode is the mode this will go live as, so promoteStaged stays a dispatch.
    mode = status === 'OPEN' ? 'PREDICTIONS_OPEN' : ['RESULT', 'SETTLED'].includes(status) ? 'PREDICTION_RESULT' : 'PREDICTION_LOCKED';
    predictionId = item.predictionId;
    roundId = prediction.rows[0].round_id ? Number(prediction.rows[0].round_id) : null;
  }

  await client.query(
    `INSERT INTO screen_state(game_night_id,mode,staged_mode,staged_round_id,staged_prediction_id,staged_payload,updated_by)
     VALUES($1,'DASHBOARD',$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT(game_night_id) DO UPDATE
       SET staged_mode=EXCLUDED.staged_mode,staged_round_id=EXCLUDED.staged_round_id,
           staged_prediction_id=EXCLUDED.staged_prediction_id,staged_payload=EXCLUDED.staged_payload,
           updated_at=NOW(),updated_by=EXCLUDED.updated_by`,
    [gameId, mode, roundId, predictionId, JSON.stringify({ blockId }), actor],
  );
}

/**
 * Promote the staged step to live, then advance the staged pointer to the next step so
 * the preview pane is already showing what comes next — as the design's GO LIVE does.
 *
 * Blocks route through setActiveRoundBlock rather than setScreenMode so that all the
 * existing guards still apply: an unfinished live question or roulette blocks the move,
 * and a roulette block gets its game created.
 */
export async function promoteStaged(client: PoolClient, gameId: number, actor: string) {
  const state = await client.query(
    'SELECT staged_mode,staged_round_id,staged_prediction_id,staged_payload FROM screen_state WHERE game_night_id=$1 FOR UPDATE',
    [gameId],
  );
  const row = state.rows[0];
  if (!row?.staged_mode) throw new HttpError(409, 'Nothing is staged');

  const stagedBlockId = Number(row.staged_payload?.blockId || 0) || null;
  const stagedRoundId = Number(row.staged_round_id || 0) || null;
  const stagedPredictionId = Number(row.staged_prediction_id || 0) || null;

  if (row.staged_mode === 'DASHBOARD') {
    await setScreenMode(client, gameId, 'DASHBOARD', actor);
  } else if (stagedBlockId && stagedRoundId) {
    await setActiveRoundBlock(client, gameId, stagedRoundId, stagedBlockId, actor);
  } else if (stagedPredictionId) {
    await setScreenMode(client, gameId, row.staged_mode as ScreenMode, actor, { predictionId: stagedPredictionId });
  } else {
    throw new HttpError(409, 'Staged item is incomplete');
  }

  const steps = await loadRunOfShow(client, gameId);
  const liveKind = stagedBlockId ? 'block' : stagedPredictionId ? 'prediction' : null;
  const liveId = stagedBlockId || stagedPredictionId || null;
  const next = nextStep(steps, liveKind, liveId);
  if (next) {
    await setStagedItem(
      client,
      gameId,
      next.kind === 'block' ? { kind: 'block', roundId: next.roundId, blockId: next.id } : { kind: 'prediction', predictionId: next.id },
      actor,
    );
  }
  return { liveKind, liveId, stagedNext: next };
}

/** Return to the presentation saved by the last `remember` detour to the dashboard. */
export async function restorePreviousScreen(client: PoolClient, gameId: number, actor: string) {
  const state = await client.query(
    'SELECT previous_mode,previous_round_id,previous_prediction_id,previous_payload FROM screen_state WHERE game_night_id=$1 FOR UPDATE',
    [gameId],
  );
  const row = state.rows[0];
  if (!row?.previous_mode) throw new HttpError(409, 'There is no previous screen to return to');

  const blockId = Number(row.previous_payload?.blockId || 0) || null;
  const roundId = Number(row.previous_round_id || 0) || null;
  const predictionId = Number(row.previous_prediction_id || 0) || null;

  if (row.previous_mode === 'DASHBOARD') {
    await setScreenMode(client, gameId, 'DASHBOARD', actor);
  } else if (blockId && roundId) {
    await setActiveRoundBlock(client, gameId, roundId, blockId, actor);
  } else if (predictionId) {
    await setScreenMode(client, gameId, row.previous_mode as ScreenMode, actor, { predictionId });
  } else {
    throw new HttpError(409, 'The previous screen can no longer be restored');
  }

  await client.query(
    `UPDATE screen_state SET previous_mode=NULL,previous_round_id=NULL,previous_prediction_id=NULL,previous_payload='{}'::jsonb
     WHERE game_night_id=$1`,
    [gameId],
  );
}

export async function clearScreenIfReferences(client: PoolClient, gameId: number, actor: string, refs: { roundId?: number; blockId?: number; predictionId?: number }) {
  const state = await client.query('SELECT mode,round_id,prediction_id,payload FROM screen_state WHERE game_night_id=$1', [gameId]);
  const row = state.rows[0];
  if (!row) return;
  const currentBlockId = Number(row.payload?.blockId || 0) || null;
  const matches = (refs.roundId && Number(row.round_id) === refs.roundId)
    || (refs.predictionId && Number(row.prediction_id) === refs.predictionId)
    || (refs.blockId && currentBlockId === refs.blockId);
  if (matches) await setScreenMode(client, gameId, 'DASHBOARD', actor);
}
