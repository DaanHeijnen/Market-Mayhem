import type { PoolClient } from 'pg';
import { HttpError } from './http';

export const SCREEN_MODES = [
  'DASHBOARD',
  'ROUND_STARTED',
  'PREDICTION_VOTING',
  'CROWD_REVEAL',
  'BETTING_OPEN',
  'PREDICTION_RESULT',
] as const;

export type ScreenMode = typeof SCREEN_MODES[number];

export function screenModeValue(value: unknown): ScreenMode {
  if (typeof value !== 'string' || !SCREEN_MODES.includes(value as ScreenMode)) {
    throw new HttpError(400, 'Invalid screen mode');
  }
  return value as ScreenMode;
}

export async function incrementGameVersion(client: PoolClient, gameId: number) {
  const { rows } = await client.query<{ game_state_version: string }>(
    `UPDATE game_nights
     SET game_state_version = game_state_version + 1, updated_at = NOW()
     WHERE id = $1
     RETURNING game_state_version`,
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
  roundId?: number | null,
  predictionId?: number | null,
  payload: unknown = {},
) {
  const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');

  let safeRoundId: number | null = roundId || null;
  let safePredictionId: number | null = predictionId || null;

  if (mode === 'DASHBOARD') {
    safeRoundId = null;
    safePredictionId = null;
  } else if (mode === 'ROUND_STARTED') {
    if (!safeRoundId) throw new HttpError(400, 'roundId is required for ROUND_STARTED');
    const round = await client.query('SELECT id,status FROM rounds WHERE id=$1 AND game_night_id=$2', [safeRoundId, gameId]);
    if (!round.rows[0]) throw new HttpError(404, 'Round not found for this game');
    if (round.rows[0].status !== 'ACTIVE') throw new HttpError(409, 'ROUND_STARTED requires an active round');
    safePredictionId = null;
  } else {
    if (!safePredictionId) throw new HttpError(400, 'predictionId is required for this screen mode');
    const prediction = await client.query(
      'SELECT round_id,status,result FROM predictions WHERE id=$1 AND game_night_id=$2',
      [safePredictionId, gameId],
    );
    if (!prediction.rows[0]) throw new HttpError(404, 'Prediction not found for this game');
    const allowedStatusByMode: Record<Exclude<ScreenMode, 'DASHBOARD' | 'ROUND_STARTED'>, string[]> = {
      PREDICTION_VOTING: ['VOTING'],
      CROWD_REVEAL: ['CALCULATING'],
      BETTING_OPEN: ['BETTING'],
      PREDICTION_RESULT: ['SETTLED'],
    };
    if (!allowedStatusByMode[mode].includes(prediction.rows[0].status)) {
      throw new HttpError(409, `${mode} is not valid while the prediction is ${prediction.rows[0].status}`);
    }
    if (mode === 'PREDICTION_RESULT' && !['YES', 'NO'].includes(prediction.rows[0].result)) {
      throw new HttpError(409, 'PREDICTION_RESULT requires a YES or NO settlement');
    }
    const predictionRoundId = prediction.rows[0].round_id ? Number(prediction.rows[0].round_id) : null;
    if (safeRoundId && safeRoundId !== predictionRoundId) {
      throw new HttpError(400, 'roundId does not match the prediction round');
    }
    safeRoundId = predictionRoundId;
  }

  await client.query(
    `INSERT INTO screen_state (game_night_id, mode, round_id, prediction_id, payload, updated_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (game_night_id) DO UPDATE
       SET mode = EXCLUDED.mode,
           round_id = EXCLUDED.round_id,
           prediction_id = EXCLUDED.prediction_id,
           payload = EXCLUDED.payload,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
    [gameId, mode, safeRoundId, safePredictionId, JSON.stringify(payload), actor],
  );
  await client.query(
    'UPDATE game_nights SET current_screen_mode=$2, updated_at=NOW() WHERE id=$1',
    [gameId, mode],
  );
}

export async function clearScreenForPrediction(
  client: PoolClient,
  gameId: number,
  predictionId: number,
  actor: string,
) {
  const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');
  const current = await client.query(
    'SELECT prediction_id FROM screen_state WHERE game_night_id=$1',
    [gameId],
  );
  if (Number(current.rows[0]?.prediction_id) === predictionId) {
    await setScreenMode(client, gameId, 'DASHBOARD', actor);
  }
}

export async function clearScreenForRound(
  client: PoolClient,
  gameId: number,
  roundId: number,
  actor: string,
) {
  const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');
  const current = await client.query(
    'SELECT round_id FROM screen_state WHERE game_night_id=$1',
    [gameId],
  );
  if (Number(current.rows[0]?.round_id) === roundId) {
    await setScreenMode(client, gameId, 'DASHBOARD', actor);
  }
}
