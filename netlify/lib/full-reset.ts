import type { PoolClient } from 'pg';
import { HttpError } from './http';
import { incrementGameVersion } from './game-state';

/**
 * Full Reset: wipe the *played* night, keep the *prepared* night.
 *
 * The Admin builds the evening once, tests it end to end, then resets and runs it for
 * real — without re-entering a single round, block, question or symbol. So every table
 * and every column has to be classified as either configuration or runtime, and the two
 * lists below are that classification, written down.
 *
 * This is deliberately not the same action as Delete Game Save, which removes the whole
 * game including its configuration. Full Reset removes only what playing produced.
 */

/**
 * Runtime tables, wiped entirely for the one game night.
 *
 * Ordered children before parents. `ledger_entries` references several of these with
 * ON DELETE SET NULL, so either order would work — but deleting the rows that point
 * *into* it first keeps the intent obvious rather than relying on that.
 */
export const RUNTIME_TABLES = [
  // Live quiz answers. The questions and their options are authored content and stay.
  'quiz_answers',
  // Fotoronde: the photos and their judgements. The subject list is authored content in
  // fotoronde_subjects, which is untouched.
  'photo_submissions',
  'photo_rounds',
  // Pak een Zes: predictions, turn order, draws
  'pak_een_zes_draws',
  'pak_een_zes_predictions',
  'pak_een_zes_participants',
  'pak_een_zes_games',
  // Slotmachine play. Its symbols, odds and payouts are configuration and stay.
  'slot_spins',
  'slot_series',
  // Roulette play
  'roulette_bets',
  'roulette_games',
  // Prediction participation. The markets themselves are prepared content and stay.
  'bets',
  // Player-proposed markets are something the test run produced, not something the
  // Admin prepared.
  'prediction_requests',
  // Money last: every table above that attributes into it is already gone.
  'ledger_entries',
  // Legacy runtime tables. Unused by current features, cleared so a Full Reset means
  // what it says even if something starts writing to them again.
  'player_timers',
  'player_codewords',
] as const;

/**
 * Tables Full Reset never deletes from, and why.
 *
 * Kept as a list rather than a comment because it is the half that is easy to get wrong:
 * a table missing from both lists is a table nobody decided about.
 */
export const PRESERVED_TABLES = [
  'game_nights',           // the night itself; runtime columns are reset in place
  'rounds',                    // prepared structure; status is reset in place
  'live_quiz_questions',       // authored questions, points and media
  'live_quiz_question_options',// the answer options and which are correct
  'live_quiz_question_state',  // 1:1 with a question; reset in place, never deleted
  'presentation_slides',       // authored slides
  'presentation_slide_state',  // 1:1 with a slide; reset in place
  'fotoronde_subjects',        // the subject list and its points
  'slotmachine_rounds',        // per-round spin limit
  'slotmachine_round_participants', // the allowlist
  'round_runtime',             // the per-round cursor; reset in place
  'round_groups',          // teams
  'round_group_members',   // team assignment
  'predictions',           // prepared markets; their live state is reset in place
  'slot_configs',          // slotmachine total
  'slot_reel_symbols',     // uploaded symbols
  'slot_outcome_types',    // chances and payouts
  'players',               // so the Admin need not re-create everyone
  'wallets',               // kept, but set back to each player's starting balance
  'player_join_tokens',    // so issued join links keep working into the real night
  'player_sessions',       // so testers stay signed in
  'screen_state',          // kept, but reset to the dashboard in place
  'admin_sessions',        // the Admin stays signed in
  'admin_audit_log',       // operational history, never game state
  'teams',                     // legacy, unread by any current feature
  // The record of the move to typed rounds. Never deleted by any reset: an archive that
  // a reset can wipe is not an archive.
  'round_blocks_archive',      // every pre-0016 block and payload, verbatim
  'migration_notes',           // what each migration decided, and why
] as const;

export type FullResetSummary = {
  deleted: Record<string, number>;
  playersReset: number;
  roundsReset: number;
  questionsReset: number;
  slidesReset: number;
  predictionsReset: number;
  startingBalanceEntries: number;
  version: number;
};

/**
 * Reset one game night's play, in a single transaction.
 *
 * The caller must already hold the `game_nights` row. Everything happens inside one
 * transaction so the reset cannot half-succeed and leave, say, wiped wallets against a
 * live round.
 */
export async function performFullReset(client: PoolClient, gameId: number, actor: string): Promise<FullResetSummary> {
  const game = await client.query(
    'SELECT id FROM game_nights WHERE id=$1 FOR UPDATE',
    [gameId],
  );
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');

  const deleted: Record<string, number> = {};

  // Every delete is scoped to this game night. The two tables without a game_night_id
  // of their own are reached through their parent, so another game is never touched.
  for (const table of RUNTIME_TABLES) {
    let result;
    if (table === 'pak_een_zes_predictions' || table === 'pak_een_zes_participants') {
      result = await client.query(
        `DELETE FROM ${table} WHERE pak_een_zes_game_id IN (SELECT id FROM pak_een_zes_games WHERE game_night_id=$1)`,
        [gameId],
      );
    } else if (table === 'roulette_bets') {
      result = await client.query(
        'DELETE FROM roulette_bets WHERE roulette_game_id IN (SELECT id FROM roulette_games WHERE game_night_id=$1)',
        [gameId],
      );
    } else if (table === 'bets') {
      result = await client.query(
        'DELETE FROM bets WHERE prediction_id IN (SELECT id FROM predictions WHERE game_night_id=$1)',
        [gameId],
      );
    } else if (table === 'player_timers' || table === 'player_codewords') {
      result = await client.query(
        `DELETE FROM ${table} WHERE player_id IN (SELECT id FROM players WHERE game_night_id=$1)`,
        [gameId],
      );
    } else {
      result = await client.query(`DELETE FROM ${table} WHERE game_night_id=$1`, [gameId]);
    }
    deleted[table] = result.rowCount ?? 0;
  }

  // Wallets go back to each player's own immutable starting snapshot, not to today's
  // Settings value — that snapshot is what the player was created with, and the
  // exchange graph is drawn from it.
  const wallets = await client.query(
    `UPDATE wallets w
     SET current_balance=p.starting_balance_snapshot,updated_at=NOW()
     FROM players p
     WHERE p.id=w.player_id AND w.game_night_id=$1
     RETURNING w.player_id,p.starting_balance_snapshot AS amount`,
    [gameId],
  );

  // One fresh STARTING_BALANCE entry per player, so the ledger sums to the wallet again.
  //
  // Deliberately not a correcting transaction against the test run: the brief asks for a
  // functionally clean slate, and a compensating entry would leave the test night visible
  // in the history as though it had really happened. The old rows are gone, so this pair
  // is the whole story — which is also what keeps wallet and ledger from drifting apart.
  let startingBalanceEntries = 0;
  for (const row of wallets.rows) {
    const amount = Number(row.amount);
    // A zero starting balance is legitimate, and ledger_entries forbids a zero amount —
    // so those players simply get no opening entry, and their wallet is already correct.
    // create-player skips it for the same reason.
    if (amount === 0) continue;
    await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,created_by)
       VALUES($1,$2,$3,'STARTING_BALANCE','Starting balance',$4)`,
      [gameId, row.player_id, amount, actor],
    );
    startingBalanceEntries += 1;
  }

  // Rounds keep their number, title, description and content — only their progress goes.
  const rounds = await client.query(
    `UPDATE rounds SET status='UPCOMING',started_at=NULL,completed_at=NULL,updated_at=NOW()
     WHERE game_night_id=$1 RETURNING id`,
    [gameId],
  );

  // Authored content is untouched; only the runtime rows beside it are set back, and
  // back to exactly the value authoring gives a new one — so a reset question behaves
  // like a freshly created one.
  const questions = await client.query(
    `UPDATE live_quiz_question_state
     SET status='READY',opened_at=NULL,closed_at=NULL,revealed_at=NULL,settled_at=NULL,
         context_photo_shown=FALSE,revision=0,updated_at=NOW()
     WHERE game_night_id=$1 RETURNING question_id`,
    [gameId],
  );

  const slides = await client.query(
    `UPDATE presentation_slide_state
     SET revealed_at=NULL,revision=0,updated_at=NOW()
     WHERE game_night_id=$1 RETURNING slide_id`,
    [gameId],
  );

  // The round cursor goes back to each round's first item, which is where enterRound
  // would put it.
  await client.query(
    `UPDATE round_runtime rt SET
       current_quiz_question_id=(SELECT id FROM live_quiz_questions WHERE round_id=rt.round_id ORDER BY sort_order,id LIMIT 1),
       current_slide_id=(SELECT id FROM presentation_slides WHERE round_id=rt.round_id ORDER BY sort_order,id LIMIT 1),
       revision=0,updated_at=NOW()
     WHERE game_night_id=$1`,
    [gameId],
  );

  // Markets keep their question, odds, timing and stake limits — all prepared content.
  // A market scheduled to a round returns to SCHEDULED so that preparation survives;
  // an unscheduled one returns to DRAFT.
  const predictions = await client.query(
    `UPDATE predictions
     SET status=CASE WHEN round_id IS NULL THEN 'DRAFT' ELSE 'SCHEDULED' END,
         result=NULL,opened_at=NULL,closes_at=NULL,settled_at=NULL,updated_at=NOW()
     WHERE game_night_id=$1 RETURNING id`,
    [gameId],
  );

  // No active round, projector back to the dashboard.
  await client.query(
    `UPDATE game_nights
     SET current_round_id=NULL,current_screen_mode='DASHBOARD',updated_at=NOW()
     WHERE id=$1`,
    [gameId],
  );

  // The staged and previous slots go too, or BACK TO RUN OF SHOW would try to restore a
  // step from the test run.
  await client.query(
    `INSERT INTO screen_state(game_night_id,mode,round_id,prediction_id,payload,updated_by)
     VALUES($1,'DASHBOARD',NULL,NULL,'{}'::jsonb,$2)
     ON CONFLICT(game_night_id) DO UPDATE
       SET mode='DASHBOARD',round_id=NULL,prediction_id=NULL,quiz_question_id=NULL,slide_id=NULL,payload='{}'::jsonb,
           staged_mode=NULL,staged_round_id=NULL,staged_prediction_id=NULL,
           staged_quiz_question_id=NULL,staged_slide_id=NULL,staged_payload='{}'::jsonb,
           previous_mode=NULL,previous_round_id=NULL,previous_prediction_id=NULL,
           previous_quiz_question_id=NULL,previous_slide_id=NULL,previous_payload='{}'::jsonb,
           updated_at=NOW(),updated_by=$2`,
    [gameId, actor],
  );

  // Bumped rather than zeroed: every client polls this version for changes, so it has to
  // keep moving forward. Raising it is what pulls Admin, phones and the projector onto the
  // fresh state within one poll instead of leaving them on stale runtime.
  const version = await incrementGameVersion(client, gameId);

  return {
    deleted,
    playersReset: wallets.rowCount ?? 0,
    roundsReset: rounds.rowCount ?? 0,
    questionsReset: questions.rowCount ?? 0,
    slidesReset: slides.rowCount ?? 0,
    predictionsReset: predictions.rowCount ?? 0,
    startingBalanceEntries,
    version,
  };
}
