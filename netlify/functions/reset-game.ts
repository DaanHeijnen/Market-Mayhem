import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { resetPlayersToDefaults } from '../lib/default-players';
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
       SET current_round_id=NULL,current_screen_mode='DASHBOARD',
           name='Market Mayhem',date=CURRENT_DATE,status='ACTIVE',starting_balance=100,
           prediction_duration_seconds=90,minimum_prediction_stake=5,maximum_prediction_stake=500,
           maximum_wallet_percentage=NULL,updated_at=NOW()
       WHERE id=$1`,
      [gameId],
    );
    await client.query('DELETE FROM screen_state WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM ledger_entries WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM quiz_answers WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM prediction_requests WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM round_group_members WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM photo_submissions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM photo_rounds WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM pak_een_zes_draws WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM pak_een_zes_predictions WHERE pak_een_zes_game_id IN (SELECT id FROM pak_een_zes_games WHERE game_night_id=$1)', [gameId]);
    await client.query('DELETE FROM pak_een_zes_participants WHERE pak_een_zes_game_id IN (SELECT id FROM pak_een_zes_games WHERE game_night_id=$1)', [gameId]);
    await client.query('DELETE FROM pak_een_zes_games WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM slot_spins WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM slot_series WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM slot_outcome_types WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM slot_reel_symbols WHERE game_night_id=$1', [gameId]);
    await client.query('UPDATE slot_configs SET total_weight=100,updated_at=NOW(),updated_by=$2 WHERE game_night_id=$1', [gameId, admin.username]);
    await client.query('DELETE FROM roulette_bets WHERE roulette_game_id IN (SELECT id FROM roulette_games WHERE game_night_id=$1)', [gameId]);
    await client.query('DELETE FROM bets WHERE prediction_id IN (SELECT id FROM predictions WHERE game_night_id=$1)', [gameId]);
    await client.query('DELETE FROM roulette_games WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM predictions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM live_quiz_questions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM pubquiz_answers WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM pubquiz_questions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM presentation_slides WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM fotoronde_subjects WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM slotmachine_round_participants WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM slotmachine_rounds WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM round_runtime WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM round_groups WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM rounds WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM player_sessions WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM player_join_tokens WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM wallets WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM players WHERE game_night_id=$1', [gameId]);
    await client.query('DELETE FROM teams WHERE game_night_id=$1', [gameId]);
    // Everything the night held is gone, including its players — so the last step is to
    // put back the roster a night starts from. Without it the Admin would be left staring
    // at an empty player list with no way to get the standard ten back, which is not what
    // "reset to the beginning" means. Same domain function the Full Reset uses, so the
    // two destructive actions cannot drift into disagreeing about who is playing.
    const roster = await resetPlayersToDefaults(client, gameId, admin.username);
    await client.query(
      `INSERT INTO screen_state(game_night_id,mode,payload,updated_by)
       VALUES($1,'DASHBOARD','{}'::jsonb,$2)`,
      [gameId, admin.username],
    );
    return {
      ok: true,
      playersCreated: roster.created,
      startingBalanceEntries: roster.startingBalanceEntries,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
