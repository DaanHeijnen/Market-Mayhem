import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';
import { requireGameResetPhrase } from '../lib/settings';

export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  if (typeof p.confirmation !== 'string' || p.confirmation.length > 40) throw new HttpError(400, 'confirmation must be the exact reset phrase');
  const confirmation = p.confirmation;
  requireGameResetPhrase(confirmation);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    // Keep the final destructive action in the audit trail itself. The audit table
    // is intentionally not part of the reset payload.
    await audit(client, gameId, admin.username, 'GAME_RESET', 'game', gameId, { confirmation: 'verified' });

    await client.query(
      `UPDATE game_nights
       SET current_round_id=NULL,current_round_block_id=NULL,current_screen_mode='DASHBOARD',
           name='Market Mayhem',date=CURRENT_DATE,status='ACTIVE',starting_balance=100,
           prediction_duration_seconds=90,minimum_prediction_stake=5,maximum_prediction_stake=500,
           maximum_wallet_percentage=NULL,updated_at=NOW()
       WHERE id=$1`,
      [gameId],
    );
    await client.query('DELETE FROM screen_state WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM ledger_entries WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM roulette_bets WHERE roulette_game_id IN (SELECT id FROM roulette_games WHERE game_night_id=$1)', [gameId]);
    await client.query('DELETE FROM bets WHERE prediction_id IN (SELECT id FROM predictions WHERE game_night_id=$1)', [gameId]);
    await client.query('DELETE FROM roulette_games WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM predictions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM round_blocks WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM rounds WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM player_sessions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM player_join_tokens WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM wallets WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM players WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM teams WHERE game_night_id=$1', [gameId]);
    await client.query(
      `INSERT INTO screen_state(game_night_id,mode,payload,updated_by)
       VALUES($1,'DASHBOARD','{}'::jsonb,$2)`,
      [gameId, admin.username],
    );
    return { ok: true, version: await incrementGameVersion(client, gameId) };
  }));
});
