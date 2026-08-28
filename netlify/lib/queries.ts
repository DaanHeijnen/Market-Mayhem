import { database, withTransaction } from './db';
import { HttpError } from './http';
import { incrementGameVersion } from './game-state';
import { publicPredictionStatus } from './economy';
import { SLOT_SPIN_MS, slotLockedValue, slotOutcomeLabel } from './slot';
import { readSlotSettings, readSlotSymbolMeta, slotStatus } from './slot-store';

const ROULETTE_SPIN_MS = 5500;

export async function syncTimedState(gameId: number, knownDue = false) {
  if (!knownDue) {
    const due = await database().pool.query(
      `SELECT
        EXISTS(SELECT 1 FROM predictions WHERE game_night_id=$1 AND status='OPEN' AND closes_at IS NOT NULL AND closes_at<=NOW()) AS prediction_due,
        EXISTS(SELECT 1 FROM roulette_games WHERE game_night_id=$1 AND status='SPINNING' AND spun_at IS NOT NULL AND spun_at<=NOW()-($2::text||' milliseconds')::interval) AS roulette_due,
        EXISTS(SELECT 1 FROM slot_spins WHERE game_night_id=$1 AND status='SPINNING' AND created_at<=NOW()-($3::text||' milliseconds')::interval) AS slot_due`,
      [gameId, ROULETTE_SPIN_MS, SLOT_SPIN_MS],
    );
    if (!due.rows[0]?.prediction_due && !due.rows[0]?.roulette_due && !due.rows[0]?.slot_due) return false;
  }

  return withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    let changed = false;

    const expired = await client.query(
      `UPDATE predictions SET status='LOCKED',updated_at=NOW()
       WHERE game_night_id=$1 AND status='OPEN' AND closes_at IS NOT NULL AND closes_at<=NOW()
       RETURNING id`,
      [gameId],
    );
    if (expired.rowCount) {
      changed = true;
      const ids = expired.rows.map((r: any) => Number(r.id));
      await client.query(
        `UPDATE screen_state SET mode='PREDICTION_LOCKED',updated_at=NOW(),updated_by='timer'
         WHERE game_night_id=$1 AND prediction_id=ANY($2::bigint[])`,
        [gameId, ids],
      );
      await client.query(
        `UPDATE game_nights SET current_screen_mode='PREDICTION_LOCKED',updated_at=NOW()
         WHERE id=$1 AND EXISTS(SELECT 1 FROM screen_state WHERE game_night_id=$1 AND mode='PREDICTION_LOCKED')`,
        [gameId],
      );
    }

    const spun = await client.query(
      `UPDATE roulette_games SET status='RESULT',updated_at=NOW()
       WHERE game_night_id=$1 AND status='SPINNING' AND spun_at IS NOT NULL
         AND spun_at<=NOW()-($2::text||' milliseconds')::interval
       RETURNING id`,
      [gameId, ROULETTE_SPIN_MS],
    );
    if (spun.rowCount) changed = true;

    // A spin is drawn the moment the command arrives, but the reels have to be
    // seen turning. The stored outcome only becomes public after the animation
    // window, exactly like the roulette wheel.
    const revealed = await client.query(
      `UPDATE slot_spins SET status='RESULT',revealed_at=NOW()
       WHERE game_night_id=$1 AND status='SPINNING'
         AND created_at<=NOW()-($2::text||' milliseconds')::interval
       RETURNING id`,
      [gameId, SLOT_SPIN_MS],
    );
    if (revealed.rowCount) changed = true;
    if (changed) await incrementGameVersion(client, gameId);
    return changed;
  });
}

export const syncExpiredPredictions = syncTimedState;

export async function getGameVersion(gameId: number) {
  const result = await database().pool.query(
    `SELECT g.game_state_version,
      EXISTS(SELECT 1 FROM predictions p WHERE p.game_night_id=g.id AND p.status='OPEN' AND p.closes_at IS NOT NULL AND p.closes_at<=NOW()) AS prediction_due,
      EXISTS(SELECT 1 FROM roulette_games rg WHERE rg.game_night_id=g.id AND rg.status='SPINNING' AND rg.spun_at IS NOT NULL AND rg.spun_at<=NOW()-($2::text||' milliseconds')::interval) AS roulette_due,
      EXISTS(SELECT 1 FROM slot_spins ss WHERE ss.game_night_id=g.id AND ss.status='SPINNING' AND ss.created_at<=NOW()-($3::text||' milliseconds')::interval) AS slot_due
     FROM game_nights g WHERE g.id=$1`,
    [gameId, ROULETTE_SPIN_MS, SLOT_SPIN_MS],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'Game not found');
  if (!row.prediction_due && !row.roulette_due && !row.slot_due) return Number(row.game_state_version);
  await syncTimedState(gameId, true);
  const refreshed = await database().pool.query('SELECT game_state_version FROM game_nights WHERE id=$1', [gameId]);
  return Number(refreshed.rows[0].game_state_version);
}

function normalizeBlock(row: any, admin = true) {
  if (!row) return null;
  const payload = row.payload || {};
  const normalizedPayload = admin ? payload : (() => {
    if (row.type !== 'DUOLINGO_QUESTION') return payload;
    const safe: Record<string, unknown> = {
      answers: Array.isArray(payload.answers) ? payload.answers : [],
      rewardCoins: Number(payload.rewardCoins || 0),
    };
    if (['REVEALED','SETTLED'].includes(row.interactive_status) && Number.isInteger(Number(payload.correctAnswerIndex))) {
      safe.correctAnswerIndex = Number(payload.correctAnswerIndex);
    }
    return safe;
  })();
  return {
    ...row,
    id: Number(row.id),
    round_id: Number(row.round_id),
    sort_order: Number(row.sort_order),
    answer_count: Number(row.answer_count || 0),
    payload: normalizedPayload,
  };
}

function normalizePrediction(p: any) {
  const status = p.status;
  return {
    ...p,
    id: Number(p.id),
    round_id: p.round_id ? Number(p.round_id) : null,
    display_number: Number(p.display_number),
    probability_yes: Number(p.probability_yes),
    yes_odds: Number(p.yes_odds),
    no_odds: Number(p.no_odds),
    prediction_time_seconds: Number(p.prediction_time_seconds),
    minimum_stake: Number(p.minimum_stake),
    maximum_stake: Number(p.maximum_stake),
    bet_count: Number(p.bet_count || 0),
    participation_count: Number(p.participation_count || p.bet_count || 0),
    deposited_coins: Number(p.deposited_coins || 0),
    public_status: publicPredictionStatus(status, p.result),
  };
}

const SLOT_SPIN_SELECT = `s.id,s.slot_session_id,s.player_id,s.spin_number,s.stake,s.reel1_position,s.reel2_position,
        s.reel3_position,s.payout_multiplier,s.payout_amount,s.status,s.created_at,s.revealed_at`;

/**
 * `hideUntilRevealed` is what keeps the outcome off the phone while the reels
 * are still turning. The Big Screen receives it unmasked because it has to
 * animate towards the stored result.
 */
function normalizeSlotSpin(row: any, hideUntilRevealed: boolean) {
  if (!row) return null;
  const positions = [Number(row.reel1_position), Number(row.reel2_position), Number(row.reel3_position)];
  const masked = hideUntilRevealed && row.status !== 'RESULT';
  return {
    id: Number(row.id),
    sessionId: Number(row.slot_session_id),
    playerId: Number(row.player_id),
    playerName: row.display_name ?? null,
    playerColor: row.public_color ?? null,
    spinNumber: Number(row.spin_number),
    stake: Number(row.stake),
    status: row.status,
    createdAt: row.created_at,
    revealAt: new Date(new Date(row.created_at).getTime() + SLOT_SPIN_MS).toISOString(),
    positions: masked ? null : positions,
    label: masked ? null : slotOutcomeLabel(positions[0], positions[1], positions[2]),
    payoutMultiplier: masked ? null : Number(row.payout_multiplier),
    payoutAmount: masked ? null : Number(row.payout_amount),
  };
}

function normalizeSlotSession(row: any) {
  if (!row) return null;
  const stakePerSpin = Number(row.stake_per_spin);
  const remainingSpins = Number(row.remaining_spins);
  const totalSpins = Number(row.total_spins);
  return {
    id: Number(row.id),
    playerId: Number(row.player_id),
    playerName: row.display_name ?? null,
    playerColor: row.public_color ?? null,
    stakePerSpin,
    totalSpins,
    remainingSpins,
    currentSpin: Math.min(totalSpins, totalSpins - remainingSpins + (remainingSpins > 0 ? 1 : 0)),
    usedSpins: totalSpins - remainingSpins,
    totalStake: Number(row.total_stake),
    lockedValue: slotLockedValue(remainingSpins, stakePerSpin),
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function getAdminState(gameId: number) {
  await syncTimedState(gameId);
  const pool = database().pool;
  const gameResult = await pool.query('SELECT * FROM game_nights WHERE id=$1', [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');

  const [rounds, blocks, groups, players, predictions, recent, roulette, slotSession, slotSpins, slotConfig] = await Promise.all([
    pool.query('SELECT * FROM rounds WHERE game_night_id=$1 ORDER BY round_number,id', [gameId]),
    pool.query(
      `SELECT b.*,COUNT(a.id)::int AS answer_count
       FROM round_blocks b LEFT JOIN round_question_answers a ON a.round_block_id=b.id
       WHERE b.game_night_id=$1 GROUP BY b.id ORDER BY b.round_id,b.sort_order,b.id`, [gameId],
    ),
    pool.query(
      `SELECT g.id,g.round_id,g.name,g.created_at,
              COALESCE(json_agg(json_build_object('id',p.id,'display_name',p.display_name,'public_color',p.public_color,'active',p.active) ORDER BY p.display_name)
                FILTER (WHERE p.id IS NOT NULL),'[]') AS members
       FROM round_groups g LEFT JOIN round_group_members gm ON gm.group_id=g.id LEFT JOIN players p ON p.id=gm.player_id
       WHERE g.game_night_id=$1 GROUP BY g.id ORDER BY g.round_id,g.id`, [gameId],
    ),
    pool.query(
      `WITH ranked AS (
         SELECT p.id,DENSE_RANK() OVER (ORDER BY w.current_balance DESC) AS rank
         FROM players p JOIN wallets w ON w.player_id=p.id WHERE p.game_night_id=$1 AND p.active=TRUE
       )
       SELECT p.id,p.display_name,p.public_color,p.active,p.created_at,w.current_balance,r.rank,
              EXISTS(SELECT 1 FROM player_sessions s WHERE s.player_id=p.id AND s.revoked_at IS NULL AND s.expires_at>NOW()) AS joined,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions pr ON pr.id=b.prediction_id WHERE b.player_id=p.id AND b.status='ACTIVE' AND pr.status IN ('OPEN','LOCKED','RESULT')),0)::int AS locked_prediction,
              COALESCE((SELECT SUM(ss.remaining_spins*ss.stake_per_spin) FROM slot_sessions ss WHERE ss.player_id=p.id AND ss.status='ACTIVE'),0)::int AS locked_slot
       FROM players p JOIN wallets w ON w.player_id=p.id LEFT JOIN ranked r ON r.id=p.id
       WHERE p.game_night_id=$1 ORDER BY p.active DESC,p.display_name`, [gameId],
    ),
    pool.query(
      `SELECT p.*,COUNT(b.id)::int AS bet_count,COUNT(b.id)::int AS participation_count,
              COALESCE(SUM(b.stake) FILTER (WHERE b.status='ACTIVE'),0)::int AS deposited_coins,
              r.round_number,r.title AS round_title
       FROM predictions p LEFT JOIN rounds r ON r.id=p.round_id LEFT JOIN bets b ON b.prediction_id=p.id
       WHERE p.game_night_id=$1 GROUP BY p.id,r.round_number,r.title ORDER BY p.display_number,p.id`, [gameId],
    ),
    pool.query(
      `SELECT l.id,l.amount,l.description,l.transaction_type,l.created_at,p.display_name,
              r.round_number,pr.display_number AS prediction_number,l.roulette_game_id,g.name AS group_name
       FROM ledger_entries l JOIN players p ON p.id=l.player_id
       LEFT JOIN rounds r ON r.id=l.attributed_round_id LEFT JOIN predictions pr ON pr.id=l.prediction_id
       LEFT JOIN round_groups g ON g.id=l.round_group_id
       WHERE l.game_night_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 12`, [gameId],
    ),
    pool.query(
      `SELECT rg.*,COUNT(rb.id) FILTER (WHERE rb.status='ACTIVE')::int AS bet_count,
              COALESCE(SUM(rb.stake) FILTER (WHERE rb.status='ACTIVE'),0)::int AS total_stake
       FROM roulette_games rg LEFT JOIN roulette_bets rb ON rb.roulette_game_id=rg.id
       WHERE rg.game_night_id=$1 AND rg.round_block_id=$2 AND rg.status IN ('DRAFT','OPEN','LOCKED','SPINNING','RESULT')
       GROUP BY rg.id ORDER BY rg.id DESC LIMIT 1`, [gameId, game.current_round_block_id],
    ),
    pool.query(
      `SELECT ss.*,p.display_name,p.public_color FROM slot_sessions ss JOIN players p ON p.id=ss.player_id
       WHERE ss.game_night_id=$1 AND ss.status='ACTIVE' LIMIT 1`, [gameId],
    ),
    pool.query(
      `SELECT ${SLOT_SPIN_SELECT},p.display_name,p.public_color FROM slot_spins s JOIN players p ON p.id=s.player_id
       WHERE s.game_night_id=$1 ORDER BY s.id DESC LIMIT 6`, [gameId],
    ),
    slotStatus(pool, gameId),
  ]);

  const normalizedBlocks = blocks.rows.map((b: any) => normalizeBlock(b, true));
  const groupRows = groups.rows.map((g: any) => ({ ...g, id: Number(g.id), round_id: Number(g.round_id), members: (g.members || []).map((m: any) => ({ ...m, id: Number(m.id), active: Boolean(m.active) })) }));
  const normalizedPredictions = predictions.rows.map(normalizePrediction);
  return {
    version: Number(game.game_state_version),
    game: {
      id: Number(game.id), name: game.name, starting_balance: Number(game.starting_balance),
      maximum_wallet_percentage: game.maximum_wallet_percentage == null ? null : Number(game.maximum_wallet_percentage),
      current_round_id: game.current_round_id ? Number(game.current_round_id) : null,
      current_round_block_id: game.current_round_block_id ? Number(game.current_round_block_id) : null,
      current_screen_mode: game.current_screen_mode,
      game_state_version: Number(game.game_state_version),
    },
    rounds: rounds.rows.map((r: any) => ({
      ...r, id: Number(r.id), round_number: Number(r.round_number),
      blocks: normalizedBlocks.filter((b: any) => b.round_id === Number(r.id)),
      groups: groupRows.filter((g: any) => g.round_id === Number(r.id)),
    })),
    currentBlock: normalizedBlocks.find((b: any) => b.id === Number(game.current_round_block_id)) || null,
    players: players.rows.map((p: any) => ({ ...p, id: Number(p.id), current_balance: Number(p.current_balance), locked_prediction: Number(p.locked_prediction), locked_slot: Number(p.locked_slot), rank: p.rank ? Number(p.rank) : null, active: Boolean(p.active), joined: Boolean(p.joined) })),
    predictions: normalizedPredictions,
    activePredictions: normalizedPredictions.filter((p: any) => ['OPEN','LOCKED','RESULT'].includes(p.status)),
    recentTransactions: recent.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
    activeRoulette: (() => { const r = roulette.rows[0]; return r ? { ...r, id: Number(r.id), round_id: r.round_id ? Number(r.round_id) : null, round_block_id: r.round_block_id ? Number(r.round_block_id) : null, result_number: r.status === 'SPINNING' || r.result_number == null ? null : Number(r.result_number), bet_count: Number(r.bet_count), total_stake: Number(r.total_stake) } : null; })(),
    slot: {
      settings: slotConfig.settings,
      status: slotConfig.status,
      weightedOutcomeCount: slotConfig.weightedOutcomeCount,
      activeSession: normalizeSlotSession(slotSession.rows[0]),
      recentSpins: slotSpins.rows.map((row: any) => normalizeSlotSpin(row, false)),
    },
  };
}

export async function getPlayerState(gameId: number, playerId: number) {
  await syncTimedState(gameId);
  const pool = database().pool;
  const playerResult = await pool.query(
    `WITH values AS (
       SELECT p.id,p.display_name,p.public_color,w.current_balance,g.game_state_version,g.maximum_wallet_percentage,
              p.starting_balance_snapshot::int AS starting_balance,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions pr ON pr.id=b.prediction_id WHERE b.player_id=p.id AND b.status='ACTIVE' AND pr.status IN ('OPEN','LOCKED','RESULT')),0)::int AS prediction_locked,
              COALESCE((SELECT SUM(rb.stake) FROM roulette_bets rb JOIN roulette_games rg ON rg.id=rb.roulette_game_id WHERE rb.player_id=p.id AND rb.status='ACTIVE' AND rg.status IN ('OPEN','LOCKED','SPINNING','RESULT')),0)::int AS roulette_locked,
              COALESCE((SELECT SUM(ss.remaining_spins*ss.stake_per_spin) FROM slot_sessions ss WHERE ss.player_id=p.id AND ss.status='ACTIVE'),0)::int AS slot_locked
       FROM players p JOIN wallets w ON w.player_id=p.id JOIN game_nights g ON g.id=p.game_night_id
       WHERE p.game_night_id=$1 AND p.active=TRUE
     ), ranked AS (
       SELECT *,DENSE_RANK() OVER (ORDER BY current_balance+prediction_locked+roulette_locked+slot_locked DESC) AS rank FROM values
     ) SELECT * FROM ranked WHERE id=$2`, [gameId, playerId],
  );
  const player = playerResult.rows[0];
  if (!player) throw new HttpError(404, 'Player not found');

  const [ledger, predictions, roulette, interactive, slotSession, slotSpin, slotConfig] = await Promise.all([
    pool.query('SELECT id,amount,transaction_type,description,created_at,attributed_round_id,prediction_id,roulette_game_id,round_block_id FROM ledger_entries WHERE game_night_id=$1 AND player_id=$2 ORDER BY created_at DESC,id DESC LIMIT 12', [gameId, playerId]),
    pool.query(
      `SELECT p.id,p.display_number,p.question,p.status,p.probability_yes,p.yes_odds,p.no_odds,p.prediction_time_seconds,p.minimum_stake,p.maximum_stake,p.opened_at,p.closes_at,p.result,p.round_id,r.round_number,
              b.id AS own_bet_id,b.side AS own_bet_side,b.stake AS own_bet_stake,b.odds_snapshot AS own_bet_odds,b.potential_return AS own_bet_return,b.status AS own_bet_status
       FROM predictions p LEFT JOIN rounds r ON r.id=p.round_id LEFT JOIN bets b ON b.prediction_id=p.id AND b.player_id=$2
       WHERE p.game_night_id=$1 AND p.status NOT IN ('DRAFT','SCHEDULED')
       ORDER BY CASE p.status WHEN 'OPEN' THEN 0 WHEN 'LOCKED' THEN 1 WHEN 'RESULT' THEN 2 ELSE 3 END,p.updated_at DESC,p.id DESC LIMIT 30`, [gameId, playerId],
    ),
    pool.query(
      `SELECT rg.id,rg.status,rg.result_number,rg.spun_at,rg.round_id,rg.round_block_id,rb.title AS block_title,
              COALESCE(json_agg(json_build_object('id',b.id,'bet_type',b.bet_type,'selection',b.selection,'stake',b.stake,'payout_multiplier',b.payout_multiplier,'potential_return',b.potential_return,'status',b.status) ORDER BY b.id)
                FILTER (WHERE b.id IS NOT NULL),'[]') AS own_bets
       FROM roulette_games rg LEFT JOIN round_blocks rb ON rb.id=rg.round_block_id LEFT JOIN roulette_bets b ON b.roulette_game_id=rg.id AND b.player_id=$2
       WHERE rg.id=(SELECT rg2.id FROM roulette_games rg2 WHERE rg2.game_night_id=$1 AND rg2.round_block_id=(SELECT current_round_block_id FROM game_nights WHERE id=$1) ORDER BY rg2.id DESC LIMIT 1)
       GROUP BY rg.id,rb.title`, [gameId, playerId],
    ),
    pool.query(
      `SELECT b.id,b.round_id,b.title,b.interactive_status,b.payload,
              a.selected_answer,
              CASE WHEN b.interactive_status IN ('REVEALED','SETTLED') AND a.id IS NOT NULL
                   THEN a.selected_answer=(b.payload->>'correctAnswerIndex')::int ELSE NULL END AS is_correct
       FROM game_nights g JOIN round_blocks b ON b.id=g.current_round_block_id
       LEFT JOIN round_question_answers a ON a.round_block_id=b.id AND a.player_id=$2
       JOIN rounds r ON r.id=b.round_id
       WHERE g.id=$1 AND b.type='DUOLINGO_QUESTION' AND r.status='ACTIVE'`, [gameId, playerId],
    ),
    pool.query(
      `SELECT ss.*,p.display_name,p.public_color FROM slot_sessions ss JOIN players p ON p.id=ss.player_id
       WHERE ss.game_night_id=$1 AND ss.status='ACTIVE' LIMIT 1`, [gameId],
    ),
    pool.query(
      `SELECT ${SLOT_SPIN_SELECT} FROM slot_spins s
       WHERE s.game_night_id=$1 AND s.player_id=$2 ORDER BY s.id DESC LIMIT 1`, [gameId, playerId],
    ),
    slotStatus(pool, gameId),
  ]);

  const normalizedPredictions = predictions.rows.map((p: any) => ({
    id: Number(p.id), number: Number(p.display_number), question: p.question, status: p.status,
    publicStatus: publicPredictionStatus(p.status, p.result), probabilityYes: Number(p.probability_yes),
    yesOdds: Number(p.yes_odds), noOdds: Number(p.no_odds), predictionTimeSeconds: Number(p.prediction_time_seconds),
    minimumStake: Number(p.minimum_stake), maximumStake: Number(p.maximum_stake), openedAt: p.opened_at, closesAt: p.closes_at, result: p.result,
    roundId: p.round_id ? Number(p.round_id) : null, roundNumber: p.round_number ? Number(p.round_number) : null,
    ownBet: p.own_bet_id ? { id: Number(p.own_bet_id), side: p.own_bet_side, stake: Number(p.own_bet_stake), odds: Number(p.own_bet_odds), potentialReturn: Number(p.own_bet_return), status: p.own_bet_status } : null,
  }));
  const rouletteRow = roulette.rows[0];
  const currentRoulette = rouletteRow && rouletteRow.status !== 'DRAFT' ? {
    ...rouletteRow, id: Number(rouletteRow.id), round_id: rouletteRow.round_id ? Number(rouletteRow.round_id) : null,
    round_block_id: rouletteRow.round_block_id ? Number(rouletteRow.round_block_id) : null,
    result_number: rouletteRow.status === 'SPINNING' || rouletteRow.result_number == null ? null : Number(rouletteRow.result_number), own_bets: rouletteRow.own_bets || [],
  } : null;
  const interactiveRow = interactive.rows[0];
  const interactiveBlock = interactiveRow ? {
    id: Number(interactiveRow.id), roundId: Number(interactiveRow.round_id),
    status: interactiveRow.interactive_status, rewardCoins: Number(interactiveRow.payload?.rewardCoins || 0),
    selectedAnswer: interactiveRow.selected_answer == null ? null : Number(interactiveRow.selected_answer),
    isCorrect: interactiveRow.is_correct == null ? null : Boolean(interactiveRow.is_correct),
  } : null;
  const predictionLocked = Number(player.prediction_locked || 0);
  const rouletteLocked = Number(player.roulette_locked || 0);
  const slotLocked = Number(player.slot_locked || 0);

  // The phone is input and control only: it never receives reel artwork and it
  // never learns an outcome before the Big Screen has shown it.
  const liveSlotSession = normalizeSlotSession(slotSession.rows[0]);
  const ownSlotSession = liveSlotSession && liveSlotSession.playerId === playerId ? liveSlotSession : null;
  const slotBlockedBy = liveSlotSession && liveSlotSession.playerId !== playerId ? liveSlotSession.playerName : null;
  const latestSlotSpin = normalizeSlotSpin(slotSpin.rows[0], true);
  const slotSpinnable = Boolean(ownSlotSession && ownSlotSession.remainingSpins > 0 && latestSlotSpin?.status !== 'SPINNING');

  return {
    version: Number(player.game_state_version),
    player: {
      id: Number(player.id), name: player.display_name, color: player.public_color, balance: Number(player.current_balance), startingBalance: Number(player.starting_balance), rank: Number(player.rank),
      lockedPrediction: predictionLocked, lockedRoulette: rouletteLocked, lockedSlot: slotLocked,
      totalValue: Number(player.current_balance) + predictionLocked + rouletteLocked + slotLocked,
    },
    settings: { maximumWalletPercentage: player.maximum_wallet_percentage == null ? null : Number(player.maximum_wallet_percentage) },
    predictions: normalizedPredictions,
    predictionAvailable: normalizedPredictions.some((p: any) => p.status === 'OPEN'),
    roulette: currentRoulette,
    rouletteAvailable: currentRoulette?.status === 'OPEN',
    interactiveBlock,
    slot: {
      configured: slotConfig.status.valid,
      configurationMessage: slotConfig.status.message,
      maximumSpins: slotConfig.settings.maximumSpins,
      minimumStake: slotConfig.settings.minimumStake,
      maximumStake: slotConfig.settings.maximumStake,
      session: ownSlotSession,
      blockedBy: slotBlockedBy,
      latestSpin: latestSlotSpin,
      canSpin: slotSpinnable,
      available: slotConfig.status.valid && !slotBlockedBy,
    },
    actionable: normalizedPredictions.some((p: any) => p.status === 'OPEN') || currentRoulette?.status === 'OPEN' || interactiveBlock?.status === 'OPEN' || Boolean(ownSlotSession),
    recentLedger: ledger.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
  };
}

function eventTimestamp(value: unknown) {
  return value ? new Date(String(value)).getTime() : 0;
}

export async function getScreenState(gameId: number) {
  await syncTimedState(gameId);
  const pool = database().pool;
  const gameResult = await pool.query('SELECT g.*,s.mode,s.round_id AS screen_round_id,s.prediction_id,s.payload FROM game_nights g LEFT JOIN screen_state s ON s.game_night_id=g.id WHERE g.id=$1', [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');
  const screenMode = game.mode || game.current_screen_mode || 'DASHBOARD';
  const blockId = ['ROUND_BLOCK','ROULETTE'].includes(screenMode) ? (Number(game.payload?.blockId || game.current_round_block_id || 0) || null) : null;
  const rouletteGameId = screenMode === 'ROULETTE' ? (Number(game.payload?.rouletteGameId || 0) || null) : null;

  const [round, block, prediction, players, ledgerEvents, predictionEvents, rouletteEvents, ticker, totals, roulette, recentResults, slotSession, slotSpin, slotEvents, slotSymbols, slotConfig] = await Promise.all([
    pool.query('SELECT id,round_number,title,status FROM rounds WHERE id=COALESCE($1::bigint,$2::bigint) AND game_night_id=$3', [game.screen_round_id, game.current_round_id, gameId]),
    blockId ? pool.query(
      `SELECT b.*,COUNT(a.id)::int AS answer_count FROM round_blocks b LEFT JOIN round_question_answers a ON a.round_block_id=b.id
       WHERE b.id=$1 AND b.game_night_id=$2 GROUP BY b.id`, [blockId, gameId],
    ) : Promise.resolve({ rows: [] } as any),
    game.prediction_id ? pool.query('SELECT id,display_number,question,status,probability_yes,yes_odds,no_odds,result,opened_at,closes_at FROM predictions WHERE id=$1 AND game_night_id=$2', [game.prediction_id, gameId]) : Promise.resolve({ rows: [] } as any),
    pool.query(
      `SELECT p.id,p.display_name,p.public_color,w.current_balance,
              p.starting_balance_snapshot::int AS starting_balance,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions pr ON pr.id=b.prediction_id WHERE b.player_id=p.id AND b.status='ACTIVE' AND pr.status IN ('OPEN','LOCKED','RESULT')),0)::int AS prediction_locked,
              COALESCE((SELECT SUM(rb.stake) FROM roulette_bets rb JOIN roulette_games rg ON rg.id=rb.roulette_game_id WHERE rb.player_id=p.id AND rb.status='ACTIVE' AND rg.status IN ('OPEN','LOCKED','SPINNING','RESULT')),0)::int AS roulette_locked,
              COALESCE((SELECT SUM(ss.remaining_spins*ss.stake_per_spin) FROM slot_sessions ss WHERE ss.player_id=p.id AND ss.status='ACTIVE'),0)::int AS slot_locked
       FROM players p JOIN wallets w ON w.player_id=p.id WHERE p.game_night_id=$1 AND p.active=TRUE ORDER BY w.current_balance DESC,p.display_name`, [gameId],
    ),
    pool.query(
      `SELECT l.id,l.player_id,l.amount,l.transaction_type,l.created_at
       FROM ledger_entries l JOIN players p ON p.id=l.player_id
       WHERE l.game_night_id=$1 AND p.active=TRUE AND l.transaction_type NOT IN (
         'STARTING_BALANCE','PREDICTION_DEPOSIT','BET_STAKE','BET_PAYOUT','BET_REFUND','ROULETTE_STAKE','ROULETTE_PAYOUT','ROULETTE_REFUND',
         'SLOT_DEPOSIT','SLOT_PAYOUT','SLOT_REFUND'
       ) ORDER BY l.created_at,l.id`, [gameId],
    ),
    pool.query(
      `SELECT b.id,b.player_id,b.stake,b.potential_return,b.status,b.settled_at
       FROM bets b JOIN predictions p ON p.id=b.prediction_id JOIN players pl ON pl.id=b.player_id
       WHERE p.game_night_id=$1 AND pl.active=TRUE AND b.status IN ('WON','LOST') AND b.settled_at IS NOT NULL ORDER BY b.settled_at,b.id`, [gameId],
    ),
    pool.query(
      `SELECT b.id,b.player_id,b.stake,b.potential_return,b.status,b.settled_at
       FROM roulette_bets b JOIN roulette_games rg ON rg.id=b.roulette_game_id JOIN players pl ON pl.id=b.player_id
       WHERE rg.game_night_id=$1 AND pl.active=TRUE AND b.status IN ('WON','LOST') AND b.settled_at IS NOT NULL ORDER BY b.settled_at,b.id`, [gameId],
    ),
    pool.query(
      `SELECT l.id,p.display_name,l.amount,l.transaction_type,l.description,r.round_number,pr.display_number AS prediction_number,l.roulette_game_id
       FROM ledger_entries l JOIN players p ON p.id=l.player_id LEFT JOIN rounds r ON r.id=l.attributed_round_id LEFT JOIN predictions pr ON pr.id=l.prediction_id
       WHERE l.game_night_id=$1 AND p.active=TRUE AND l.public_visible=TRUE ORDER BY l.created_at DESC,l.id DESC LIMIT 14`, [gameId],
    ),
    pool.query(
      `SELECT COALESCE((SELECT SUM(w.current_balance) FROM wallets w JOIN players p ON p.id=w.player_id WHERE w.game_night_id=$1 AND p.active=TRUE),0)::int AS wallets,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions p ON p.id=b.prediction_id WHERE p.game_night_id=$1 AND b.status='ACTIVE' AND p.status IN ('OPEN','LOCKED','RESULT')),0)::int AS prediction_stakes,
              COALESCE((SELECT SUM(rb.stake) FROM roulette_bets rb JOIN roulette_games rg ON rg.id=rb.roulette_game_id WHERE rg.game_night_id=$1 AND rb.status='ACTIVE' AND rg.status IN ('OPEN','LOCKED','SPINNING','RESULT')),0)::int AS roulette_stakes,
              COALESCE((SELECT SUM(ss.remaining_spins*ss.stake_per_spin) FROM slot_sessions ss WHERE ss.game_night_id=$1 AND ss.status='ACTIVE'),0)::int AS slot_stakes,
              (SELECT COUNT(*) FROM predictions WHERE game_night_id=$1 AND status='OPEN')::int + (SELECT COUNT(*) FROM roulette_games WHERE game_night_id=$1 AND status='OPEN')::int
                + (SELECT COUNT(*) FROM slot_sessions WHERE game_night_id=$1 AND status='ACTIVE')::int AS markets_open`, [gameId],
    ),
    screenMode === 'ROULETTE'
      ? pool.query(
        `SELECT rg.*,
                COALESCE(json_agg(json_build_object('id',rb.id,'displayName',p.display_name,'color',p.public_color,'betType',rb.bet_type,'selection',rb.selection,'stake',rb.stake) ORDER BY rb.id)
                  FILTER (WHERE rb.id IS NOT NULL),'[]') AS public_bets
         FROM roulette_games rg LEFT JOIN roulette_bets rb ON rb.roulette_game_id=rg.id LEFT JOIN players p ON p.id=rb.player_id
         WHERE rg.id=COALESCE($1::bigint,(SELECT id FROM roulette_games WHERE game_night_id=$2 AND round_block_id=$3 ORDER BY id DESC LIMIT 1)) AND rg.game_night_id=$2
         GROUP BY rg.id`, [rouletteGameId, gameId, blockId])
      : Promise.resolve({ rows: [] } as any),
    pool.query(
      `SELECT id,display_number,question,result,yes_odds,no_odds,settled_at
       FROM predictions WHERE game_night_id=$1 AND status='SETTLED' AND result IN ('YES','NO')
       ORDER BY settled_at DESC NULLS LAST,id DESC LIMIT 6`, [gameId],
    ),
    pool.query(
      `SELECT ss.*,p.display_name,p.public_color FROM slot_sessions ss JOIN players p ON p.id=ss.player_id
       WHERE ss.game_night_id=$1 AND ss.status IN ('ACTIVE','COMPLETED')
       ORDER BY CASE ss.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,ss.id DESC LIMIT 1`, [gameId],
    ),
    pool.query(
      `SELECT ${SLOT_SPIN_SELECT},p.display_name,p.public_color FROM slot_spins s JOIN players p ON p.id=s.player_id
       WHERE s.game_night_id=$1 ORDER BY s.id DESC LIMIT 1`, [gameId],
    ),
    pool.query(
      `SELECT s.id,s.player_id,s.stake,s.payout_amount,s.revealed_at
       FROM slot_spins s JOIN players p ON p.id=s.player_id
       WHERE s.game_night_id=$1 AND p.active=TRUE AND s.status='RESULT' AND s.revealed_at IS NOT NULL
       ORDER BY s.revealed_at,s.id`, [gameId],
    ),
    readSlotSymbolMeta(pool, gameId),
    slotStatus(pool, gameId),
  ]);

  type EconEvent = { playerId: number; delta: number; time: number; key: string };
  const events: EconEvent[] = [];
  ledgerEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: Number(e.amount), time: eventTimestamp(e.created_at), key: `l${e.id}` }));
  predictionEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: e.status === 'WON' ? Number(e.potential_return) - Number(e.stake) : -Number(e.stake), time: eventTimestamp(e.settled_at), key: `p${e.id}` }));
  rouletteEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: e.status === 'WON' ? Number(e.potential_return) - Number(e.stake) : -Number(e.stake), time: eventTimestamp(e.settled_at), key: `r${e.id}` }));
  slotEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: Number(e.payout_amount) - Number(e.stake), time: eventTimestamp(e.revealed_at), key: `s${e.id}` }));
  events.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));

  const balances = new Map<number, number>();
  const series = new Map<number, Array<{ x: number; balance: number }>>();
  players.rows.forEach((p: any) => {
    const id = Number(p.id);
    const start = Number(p.starting_balance);
    balances.set(id, start);
    series.set(id, [{ x: 0, balance: start }]);
  });
  events.forEach((event, index) => {
    if (!balances.has(event.playerId)) return;
    const next = (balances.get(event.playerId) || 0) + event.delta;
    balances.set(event.playerId, next);
    series.get(event.playerId)!.push({ x: index + 1, balance: next });
  });
  const currentX = Math.max(1, events.length + 1);
  players.rows.forEach((p: any) => {
    const id = Number(p.id);
    const currentValue = Number(p.current_balance) + Number(p.prediction_locked) + Number(p.roulette_locked) + Number(p.slot_locked);
    const points = series.get(id)!;
    const last = points[points.length - 1];
    if (last.x < currentX || last.balance !== currentValue) points.push({ x: currentX, balance: currentValue });
  });

  // The exchange summary should be ordered by economic value, not merely by
  // spendable coins. Locked deposits remain part of a player's value.
  players.rows.sort((a: any, b: any) => {
    const aValue = Number(a.current_balance) + Number(a.prediction_locked) + Number(a.roulette_locked) + Number(a.slot_locked);
    const bValue = Number(b.current_balance) + Number(b.prediction_locked) + Number(b.roulette_locked) + Number(b.slot_locked);
    return bValue - aValue || String(a.display_name).localeCompare(String(b.display_name));
  });

  const total = totals.rows[0];
  const pred = prediction.rows[0];
  const rouletteRow = roulette.rows[0];
  return {
    version: Number(game.game_state_version),
    game: { id: Number(game.id), name: game.name }, mode: screenMode,
    round: round.rows[0] ? { id: Number(round.rows[0].id), number: Number(round.rows[0].round_number), title: round.rows[0].title, status: round.rows[0].status } : null,
    block: normalizeBlock(block.rows[0], false),
    prediction: pred ? { id: Number(pred.id), number: Number(pred.display_number), question: pred.question, status: pred.status, publicStatus: publicPredictionStatus(pred.status, pred.result), probabilityYes: Number(pred.probability_yes), yesOdds: Number(pred.yes_odds), noOdds: Number(pred.no_odds), result: pred.result, openedAt: pred.opened_at, closesAt: pred.closes_at } : null,
    leaderboard: players.rows.map((p: any) => ({
      id: Number(p.id), display_name: p.display_name, public_color: p.public_color,
      current_balance: Number(p.current_balance) + Number(p.prediction_locked) + Number(p.roulette_locked) + Number(p.slot_locked),
      available_balance: Number(p.current_balance), starting_balance: Number(p.starting_balance), series: series.get(Number(p.id)) || [],
    })),
    ticker: ticker.rows.map((t: any) => ({ ...t, id: Number(t.id), amount: Number(t.amount) })),
    marketsOpen: Number(total.markets_open),
    totalCoinsInPlay: Number(total.wallets) + Number(total.prediction_stakes) + Number(total.roulette_stakes) + Number(total.slot_stakes),
    roulette: rouletteRow ? { ...rouletteRow, id: Number(rouletteRow.id), round_id: rouletteRow.round_id ? Number(rouletteRow.round_id) : null, round_block_id: rouletteRow.round_block_id ? Number(rouletteRow.round_block_id) : null, result_number: rouletteRow.result_number == null ? null : Number(rouletteRow.result_number), public_bets: rouletteRow.public_bets || [] } : null,
    recentPredictionResults: recentResults.rows.map((r: any) => ({ id: Number(r.id), number: Number(r.display_number), question: r.question, result: r.result, yesOdds: Number(r.yes_odds), noOdds: Number(r.no_odds), settledAt: r.settled_at })),
    slot: {
      configured: slotConfig.status.valid,
      configurationMessage: slotConfig.status.message,
      symbols: slotSymbols.map(symbol => ({ reel: symbol.reel, position: symbol.position, checksum: symbol.checksum })),
      session: normalizeSlotSession(slotSession.rows[0]),
      latestSpin: normalizeSlotSpin(slotSpin.rows[0], false),
    },
  };
}

export async function getLedgerState(gameId: number, roundFilter: 'all'|'general'|number) {
  const pool = database().pool;
  const game = await pool.query('SELECT id FROM game_nights WHERE id=$1', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');
  const params: any[] = [gameId];
  let where = 'l.game_night_id=$1';
  if (roundFilter === 'general') where += ' AND l.attributed_round_id IS NULL';
  else if (typeof roundFilter === 'number') { params.push(roundFilter); where += ' AND l.attributed_round_id=$2'; }
  const [entries, summary] = await Promise.all([
    pool.query(
      `SELECT l.id,l.created_at,l.amount,l.description,l.transaction_type,l.attributed_round_id,l.prediction_id,l.roulette_game_id,l.round_group_id,l.round_block_id,
              p.display_name,r.round_number,r.title AS round_title,pr.display_number AS prediction_number,g.name AS group_name,rb.title AS block_title
       FROM ledger_entries l JOIN players p ON p.id=l.player_id LEFT JOIN rounds r ON r.id=l.attributed_round_id
       LEFT JOIN predictions pr ON pr.id=l.prediction_id LEFT JOIN round_groups g ON g.id=l.round_group_id LEFT JOIN round_blocks rb ON rb.id=l.round_block_id
       WHERE ${where} ORDER BY l.created_at DESC,l.id DESC`, params,
    ),
    pool.query(
      `SELECT p.id,p.display_name,
              COALESCE(SUM(CASE WHEN l.amount>0 THEN l.amount ELSE 0 END),0)::int AS earned,
              COALESCE(SUM(CASE WHEN l.amount<0 THEN -l.amount ELSE 0 END),0)::int AS lost,
              COALESCE(SUM(l.amount),0)::int AS net
       FROM players p LEFT JOIN ledger_entries l ON l.player_id=p.id AND ${where}
       WHERE p.game_night_id=$1 GROUP BY p.id,p.display_name HAVING COUNT(l.id)>0 ORDER BY net DESC,p.display_name`, params,
    ),
  ]);
  return {
    entries: entries.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount), attributed_round_id: r.attributed_round_id ? Number(r.attributed_round_id) : null, prediction_id: r.prediction_id ? Number(r.prediction_id) : null, roulette_game_id: r.roulette_game_id ? Number(r.roulette_game_id) : null, round_group_id: r.round_group_id ? Number(r.round_group_id) : null, round_block_id: r.round_block_id ? Number(r.round_block_id) : null })),
    summary: summary.rows.map((r: any) => ({ ...r, id: Number(r.id), earned: Number(r.earned), lost: Number(r.lost), net: Number(r.net) })),
  };
}
