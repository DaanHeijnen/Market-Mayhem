import type { PoolClient } from 'pg';
import { HttpError } from './http';

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
  options: { roundId?: number|null; blockId?: number|null; predictionId?: number|null; payload?: unknown } = {},
) {
  const game = await client.query('SELECT id,current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');

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
