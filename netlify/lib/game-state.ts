import type { PoolClient } from 'pg';

export async function incrementGameVersion(client: PoolClient, gameId: number) {
  const { rows } = await client.query<{ game_state_version: string }>(
    `UPDATE game_nights
     SET game_state_version = game_state_version + 1, updated_at = NOW()
     WHERE id = $1
     RETURNING game_state_version`, [gameId]
  );
  if (!rows[0]) throw new Error('Game not found');
  return Number(rows[0].game_state_version);
}

export async function setScreenMode(client: PoolClient, gameId: number, mode: string, actor: string, roundId?: number | null, predictionId?: number | null, payload: unknown = {}) {
  await client.query(
    `INSERT INTO screen_state (game_night_id, mode, round_id, prediction_id, payload, updated_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (game_night_id) DO UPDATE
       SET mode = EXCLUDED.mode, round_id = EXCLUDED.round_id, prediction_id = EXCLUDED.prediction_id,
           payload = EXCLUDED.payload, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [gameId, mode, roundId || null, predictionId || null, JSON.stringify(payload), actor]
  );
  await client.query(`UPDATE game_nights SET current_screen_mode = $2, updated_at = NOW() WHERE id = $1`, [gameId, mode]);
}
