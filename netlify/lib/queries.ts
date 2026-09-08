import { database, withTransaction } from './db';
import { HttpError } from './http';
import { incrementGameVersion } from './game-state';
import { publicPredictionStatus } from './economy';
import { orderRunOfShow } from './run-of-show';
import { cooldownMinutesLeft, describeRequestStatus, requestsRemaining } from './prediction-requests';
import { loadSlotConfig, loadSlotTurn, slotBlockSettings } from './slot-state';
import { loadPakEenZesGame, pakEenZesBlockSettings } from './pak-een-zes-state';
import { loadPhotoRound, photoRoundInstructions, photoRoundSubjects, playerTeamForRound } from './photo-round-state';
import { countCorrectPredictions, playerAtTurn, predictionPoints } from './pak-een-zes';
import { describeSlotConfig, maySpin, symbolLetter, SLOT_OUTCOME_LABELS, SLOT_SPIN_MS, type SlotOutcomeType } from './slotmachine';

const ROULETTE_SPIN_MS = 5500;

export async function syncTimedState(gameId: number, knownDue = false) {
  if (!knownDue) {
    const due = await database().pool.query(
      `SELECT
        EXISTS(SELECT 1 FROM predictions WHERE game_night_id=$1 AND status='OPEN' AND closes_at IS NOT NULL AND closes_at<=NOW()) AS prediction_due,
        EXISTS(SELECT 1 FROM roulette_games WHERE game_night_id=$1 AND status='SPINNING' AND spun_at IS NOT NULL AND spun_at<=NOW()-($2::text||' milliseconds')::interval) AS roulette_due,
        EXISTS(SELECT 1 FROM slot_spins WHERE game_night_id=$1 AND status='SPINNING' AND spun_at<=NOW()-($3::text||' milliseconds')::interval) AS slot_due`,
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

    // A slot spin's outcome was already final when it was written; this only ends the
    // presentational SPINNING window so every surface can show the result together.
    const slotRevealed = await client.query(
      `UPDATE slot_spins SET status='RESULT'
       WHERE game_night_id=$1 AND status='SPINNING' AND spun_at<=NOW()-($2::text||' milliseconds')::interval
       RETURNING id`,
      [gameId, SLOT_SPIN_MS],
    );
    if (slotRevealed.rowCount) changed = true;

    if (changed) await incrementGameVersion(client, gameId);
    return changed;
  });
}

export const syncExpiredPredictions = syncTimedState;

export type GameVersion = { version: number; idle: boolean };

// This is the single hottest query in the product: every client polls it on an
// interval, so it is also what keeps the database compute from suspending. A very
// short per-container cache collapses the bursts that happen when the Admin, the
// projector and several phones all land inside the same moment.
const VERSION_CACHE_MS = 500;
const versionCache = new Map<number, { value: GameVersion; at: number }>();

export async function getGameVersion(gameId: number): Promise<GameVersion> {
  const cached = versionCache.get(gameId);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.value;

  // One round trip. `idle` is derived from columns this query already had to read,
  // so telling clients they may back off costs nothing.
  const result = await database().pool.query(
    `SELECT g.game_state_version,
      g.current_round_id,
      EXISTS(SELECT 1 FROM predictions p WHERE p.game_night_id=g.id AND p.status='OPEN' AND p.closes_at IS NOT NULL AND p.closes_at<=NOW()) AS prediction_due,
      EXISTS(SELECT 1 FROM roulette_games rg WHERE rg.game_night_id=g.id AND rg.status='SPINNING' AND rg.spun_at IS NOT NULL AND rg.spun_at<=NOW()-($2::text||' milliseconds')::interval) AS roulette_due,
      EXISTS(SELECT 1 FROM predictions p WHERE p.game_night_id=g.id AND p.status IN ('OPEN','LOCKED','RESULT')) AS market_live,
      EXISTS(SELECT 1 FROM roulette_games rg WHERE rg.game_night_id=g.id AND rg.status IN ('OPEN','LOCKED','SPINNING','RESULT')) AS roulette_live,
      EXISTS(SELECT 1 FROM slot_spins ss WHERE ss.game_night_id=g.id AND ss.status='SPINNING' AND ss.spun_at<=NOW()-($3::text||' milliseconds')::interval) AS slot_due,
      EXISTS(SELECT 1 FROM slot_series sr WHERE sr.game_night_id=g.id AND sr.status='ACTIVE') AS slot_live,
      EXISTS(SELECT 1 FROM pak_een_zes_games pz WHERE pz.game_night_id=g.id AND pz.status IN ('PREDICTING','LOCKED','DRAWING')) AS pak_live,
      EXISTS(SELECT 1 FROM photo_rounds fr WHERE fr.game_night_id=g.id AND fr.status IN ('DRAFT','OPEN','CLOSED')) AS photo_live
     FROM game_nights g WHERE g.id=$1`,
    [gameId, ROULETTE_SPIN_MS, SLOT_SPIN_MS],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'Game not found');

  const idle = !row.current_round_id && !row.market_live && !row.roulette_live && !row.slot_live && !row.pak_live && !row.photo_live;
  let version = Number(row.game_state_version);
  if (row.prediction_due || row.roulette_due || row.slot_due) {
    await syncTimedState(gameId, true);
    const refreshed = await database().pool.query('SELECT game_state_version FROM game_nights WHERE id=$1', [gameId]);
    version = Number(refreshed.rows[0].game_state_version);
  }

  const value: GameVersion = { version, idle };
  versionCache.set(gameId, { value, at: Date.now() });
  return value;
}

function normalizeBlock(row: any, admin = true) {
  if (!row) return null;
  const payload = row.payload || {};
  const revealed = ['REVEALED', 'SETTLED'].includes(row.interactive_status);

  const normalizedPayload = admin ? payload : (() => {
    if (row.type === 'DUOLINGO_QUESTION') {
      const safe: Record<string, unknown> = {
        answers: Array.isArray(payload.answers) ? payload.answers : [],
        rewardCoins: Number(payload.rewardCoins || 0),
      };
      if (revealed && Number.isInteger(Number(payload.correctAnswerIndex))) {
        safe.correctAnswerIndex = Number(payload.correctAnswerIndex);
      }
      return safe;
    }
    // A wager round's correct answer is the thing being guessed; it must not leave the
    // server before the host reveals it.
    if (row.type === 'WAGER') {
      const { correctAnswer, ...rest } = payload;
      return revealed ? payload : rest;
    }
    return payload;
  })();

  // A music round's title IS the song title and a picture round's title is the answer,
  // so both are withheld from non-admin surfaces until reveal. Stripped here rather
  // than in the UI so the secret never crosses the wire.
  const hideTitle = !admin && ['MUSIC', 'PICTURE'].includes(row.type) && !revealed;

  return {
    ...row,
    id: Number(row.id),
    round_id: Number(row.round_id),
    sort_order: Number(row.sort_order),
    answer_count: Number(row.answer_count || 0),
    title: hideTitle ? null : row.title,
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

export async function getAdminState(gameId: number) {
  // Timer reconciliation is owned by getGameVersion, which every client polls before
  // it ever asks for a snapshot. Repeating the due-check here cost an extra query on
  // every snapshot for no new information. If a timer falls due while nobody is
  // polling, the next version poll reconciles it and bumps the version, which pulls a
  // fresh snapshot — so this self-heals within one poll interval.
  const pool = database().pool;
  const gameResult = await pool.query('SELECT * FROM game_nights WHERE id=$1', [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');

  const [rounds, blocks, groups, players, predictions, recent, roulette, screen, requests, slotConfig, slotSeries, slotSpins, pakEenZes, slotTurn, photoRound] = await Promise.all([
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
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions pr ON pr.id=b.prediction_id WHERE b.player_id=p.id AND b.status='ACTIVE' AND pr.status IN ('OPEN','LOCKED','RESULT')),0)::int AS locked_prediction
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
      `SELECT mode,round_id,prediction_id,payload,
              staged_mode,staged_round_id,staged_prediction_id,staged_payload,
              previous_mode,previous_round_id,previous_prediction_id,previous_payload
       FROM screen_state WHERE game_night_id=$1`, [gameId],
    ),
    pool.query(
      `SELECT r.id,r.player_id,r.question,r.status,r.reason,r.created_at,p.display_name
       FROM prediction_requests r JOIN players p ON p.id=r.player_id
       WHERE r.game_night_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 20`, [gameId],
    ),
    // The slotmachine's game-wide configuration travels in every Admin snapshot: the
    // Settings page edits it, and the Control Center needs its validity to tell the host
    // whether the machine can be used at all.
    loadSlotConfig(pool, gameId),
    pool.query(
      `SELECT sr.id,sr.player_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.total_stake,sr.status,sr.created_at,
              p.display_name,p.public_color
       FROM slot_series sr JOIN players p ON p.id=sr.player_id
       WHERE sr.game_night_id=$1 AND sr.round_block_id=$2
       ORDER BY CASE sr.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,sr.id DESC LIMIT 20`,
      [gameId, game.current_round_block_id],
    ),
    pool.query(
      `SELECT ss.id,ss.player_id,ss.spin_number,ss.outcome_type,
              ss.stake,ss.payout_multiplier,ss.payout,ss.status,ss.spun_at,p.display_name
       FROM slot_spins ss JOIN players p ON p.id=ss.player_id
       WHERE ss.game_night_id=$1 AND ss.round_block_id=$2
       ORDER BY ss.spun_at DESC,ss.id DESC LIMIT 8`,
      [gameId, game.current_round_block_id],
    ),
    // Null unless the current block is a Pak een Zes, so the Control Center can key off
    // the block type the same way it does for roulette and the slotmachine.
    game.current_round_block_id
      ? loadPakEenZesGame(pool, gameId, Number(game.current_round_block_id))
      : Promise.resolve(null),
    game.current_round_block_id
      ? loadSlotTurn(pool, gameId, Number(game.current_round_block_id))
      : Promise.resolve(null),
    // Loaded from the block's own payload, so the subject list the Admin is judging
    // against is the one authored on the block.
    game.current_round_block_id
      ? pool.query('SELECT payload FROM round_blocks WHERE id=$1 AND game_night_id=$2', [game.current_round_block_id, gameId])
        .then(r => (r.rows[0]
          ? loadPhotoRound(pool, gameId, Number(game.current_round_block_id), r.rows[0].payload)
          : null))
      : Promise.resolve(null),
  ]);

  const normalizedBlocks = blocks.rows.map((b: any) => normalizeBlock(b, true));
  const groupRows = groups.rows.map((g: any) => ({ ...g, id: Number(g.id), round_id: Number(g.round_id), members: (g.members || []).map((m: any) => ({ ...m, id: Number(m.id), active: Boolean(m.active) })) }));
  const normalizedPredictions = predictions.rows.map(normalizePrediction);
  return {
    version: Number(game.game_state_version),
    game: {
      id: Number(game.id), name: game.name, starting_balance: Number(game.starting_balance),
      maximum_wallet_percentage: game.maximum_wallet_percentage == null ? null : Number(game.maximum_wallet_percentage),
      pak_een_zes_points_per_correct: Number(game.pak_een_zes_points_per_correct ?? 0),
      current_round_id: game.current_round_id ? Number(game.current_round_id) : null,
      current_round_block_id: game.current_round_block_id ? Number(game.current_round_block_id) : null,
      current_screen_mode: game.current_screen_mode,
      game_state_version: Number(game.game_state_version),
    },
    // Live, staged and previous presentation pointers, all from the one screen_state
    // row. `staged` is what GO LIVE will promote; `previous` is what BACK TO RUN OF SHOW
    // restores after a detour to the dashboard.
    screen: (() => {
      const row = screen.rows[0];
      const slot = (mode: any, roundId: any, predictionId: any, payload: any) => ({
        mode: mode || null,
        roundId: Number(roundId || 0) || null,
        predictionId: Number(predictionId || 0) || null,
        blockId: Number(payload?.blockId || 0) || null,
      });
      return {
        ...slot(row?.mode || game.current_screen_mode, row?.round_id, row?.prediction_id, row?.payload),
        staged: slot(row?.staged_mode, row?.staged_round_id, row?.staged_prediction_id, row?.staged_payload),
        previous: slot(row?.previous_mode, row?.previous_round_id, row?.previous_prediction_id, row?.previous_payload),
      };
    })(),
    // Server-ordered so the strip the host sees and the pointer GO LIVE advances can
    // never disagree. Computed from rows already fetched above — no extra query.
    runOfShow: orderRunOfShow(blocks.rows, predictions.rows, game.current_round_id ? Number(game.current_round_id) : null),
    predictionRequests: requests.rows.map((r: any) => ({
      id: Number(r.id), playerId: Number(r.player_id), playerName: r.display_name,
      question: r.question, status: r.status, reason: r.reason, createdAt: r.created_at,
    })),
    rounds: rounds.rows.map((r: any) => ({
      ...r, id: Number(r.id), round_number: Number(r.round_number),
      blocks: normalizedBlocks.filter((b: any) => b.round_id === Number(r.id)),
      groups: groupRows.filter((g: any) => g.round_id === Number(r.id)),
    })),
    currentBlock: normalizedBlocks.find((b: any) => b.id === Number(game.current_round_block_id)) || null,
    players: players.rows.map((p: any) => ({ ...p, id: Number(p.id), current_balance: Number(p.current_balance), locked_prediction: Number(p.locked_prediction), rank: p.rank ? Number(p.rank) : null, active: Boolean(p.active), joined: Boolean(p.joined) })),
    predictions: normalizedPredictions,
    activePredictions: normalizedPredictions.filter((p: any) => ['OPEN','LOCKED','RESULT'].includes(p.status)),
    recentTransactions: recent.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
    activeRoulette: (() => { const r = roulette.rows[0]; return r ? { ...r, id: Number(r.id), round_id: r.round_id ? Number(r.round_id) : null, round_block_id: r.round_block_id ? Number(r.round_block_id) : null, result_number: r.status === 'SPINNING' || r.result_number == null ? null : Number(r.result_number), bet_count: Number(r.bet_count), total_stake: Number(r.total_stake) } : null; })(),
    // Everything the host judges from: photos grouped by subject, which teams are still
    // missing, what each has earned, and how each award was split.
    photoRound: (() => {
      const currentBlock = normalizedBlocks.find((b: any) => b.id === Number(game.current_round_block_id)) || null;
      if (!currentBlock || currentBlock.type !== 'FOTORONDE') return null;
      const screenRow = screen.rows[0];
      const subjects = photoRoundSubjects(currentBlock.payload);
      // Spread first so the loaded round's own fields win; the fallback stands in for a
      // block the host has not opened yet, which has no row.
      return {
        ...(photoRound || {
          id: null,
          status: 'DRAFT',
          teams: [],
          submissions: [],
          // Still list the subjects, so the host sees what will be asked.
          bySubject: subjects.map(subject => ({ subject, submissions: [], missingTeams: [], submittedCount: 0 })),
          teamTotals: [],
          submissionCount: 0,
          judgedCount: 0,
          totalCredits: 0,
          acceptsUploads: false,
          acceptsAwards: false,
        }),
        blockId: currentBlock.id,
        subjects,
        instructions: photoRoundInstructions(currentBlock.payload),
        // Which photo, if any, the projector is currently showing.
        shownSubmissionId: Number(screenRow?.payload?.photoSubmissionId || 0) || null,
      };
    })(),
    slotConfig,
    // What the host needs while a Pak een Zes runs: whose turn it is, how far the deck
    // has gone, which sixes are out and who is still missing a prediction.
    pakEenZes: (() => {
      if (!pakEenZes) return null;
      const currentBlock = normalizedBlocks.find((b: any) => b.id === Number(game.current_round_block_id)) || null;
      if (!currentBlock || currentBlock.type !== 'PAK_EEN_ZES') return null;
      const activePlayers = players.rows.filter((p: any) => p.active);
      const predicted = new Set(pakEenZes.predictedPlayerIds);
      return {
        ...pakEenZes,
        blockId: currentBlock.id,
        // Named rather than counted: the host is explicitly allowed to close without
        // everyone, so they need to see who they are closing without.
        awaitingPrediction: activePlayers
          .filter((p: any) => !predicted.has(Number(p.id)))
          .map((p: any) => ({ playerId: Number(p.id), name: p.display_name })),
        sixesFound: pakEenZes.sixes.length,
        activePlayerCount: activePlayers.length,
      };
    })(),
    // Live slotmachine picture for whatever block is current. Null-ish rather than
    // absent when the current block is not a slotmachine, so the Control Center can key
    // off the block type as it does for roulette.
    activeSlot: (() => {
      const currentBlock = normalizedBlocks.find((b: any) => b.id === Number(game.current_round_block_id)) || null;
      if (!currentBlock || currentBlock.type !== 'SLOTMACHINE') return null;
      const settings = slotBlockSettings(currentBlock.payload);
      const series = slotSeries.rows.map((row: any) => ({
        id: Number(row.id),
        playerId: Number(row.player_id),
        playerName: row.display_name,
        playerColor: row.public_color,
        stakePerSpin: Number(row.stake_per_spin),
        totalSpins: Number(row.total_spins),
        spinsRemaining: Number(row.spins_remaining),
        totalStake: Number(row.total_stake),
        status: row.status,
      }));
      const spins = slotSpins.rows.map((row: any) => ({
        id: Number(row.id),
        playerId: Number(row.player_id),
        playerName: row.display_name,
        spinNumber: Number(row.spin_number),
        outcomeType: row.outcome_type as SlotOutcomeType,
        outcome: SLOT_OUTCOME_LABELS[row.outcome_type as SlotOutcomeType] || row.outcome_type,
        stake: Number(row.stake),
        payoutMultiplier: Number(row.payout_multiplier),
        payout: Number(row.payout),
        status: row.status,
        spunAt: row.spun_at,
      }));
      return {
        blockId: currentBlock.id,
        maxSpins: settings.maxSpins,
        participantCount: settings.allowedPlayerIds.length,
        activeSeries: series.filter(x => x.status === 'ACTIVE'),
        series,
        spins,
        lastSpin: spins[0] || null,
        lockedCoins: series.filter(x => x.status === 'ACTIVE').reduce((sum, x) => sum + x.stakePerSpin * x.spinsRemaining, 0),
        // One player at a time: who is up, whether their spin is still resolving, and
        // who follows once they have used their whole run.
        turn: slotTurn ? {
          current: slotTurn.current,
          next: slotTurn.next,
          spinning: slotTurn.spinning,
          queue: slotTurn.queue,
          finished: slotTurn.finished,
          allDone: !slotTurn.current,
        } : null,
      };
    })(),
  };
}

export async function getPlayerState(gameId: number, playerId: number) {
  // Timer reconciliation is owned by getGameVersion, which every client polls before
  // it ever asks for a snapshot. Repeating the due-check here cost an extra query on
  // every snapshot for no new information. If a timer falls due while nobody is
  // polling, the next version poll reconciles it and bumps the version, which pulls a
  // fresh snapshot — so this self-heals within one poll interval.
  const pool = database().pool;
  const playerResult = await pool.query(
    `WITH values AS (
       SELECT p.id,p.display_name,p.public_color,w.current_balance,g.game_state_version,g.maximum_wallet_percentage,
              p.starting_balance_snapshot::int AS starting_balance,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions pr ON pr.id=b.prediction_id WHERE b.player_id=p.id AND b.status='ACTIVE' AND pr.status IN ('OPEN','LOCKED','RESULT')),0)::int AS prediction_locked,
              COALESCE((SELECT SUM(rb.stake) FROM roulette_bets rb JOIN roulette_games rg ON rg.id=rb.roulette_game_id WHERE rb.player_id=p.id AND rb.status='ACTIVE' AND rg.status IN ('OPEN','LOCKED','SPINNING','RESULT')),0)::int AS roulette_locked,
              COALESCE((SELECT SUM(sr.stake_per_spin*sr.spins_remaining) FROM slot_series sr WHERE sr.player_id=p.id AND sr.status='ACTIVE'),0)::int AS slot_locked
       FROM players p JOIN wallets w ON w.player_id=p.id JOIN game_nights g ON g.id=p.game_night_id
       WHERE p.game_night_id=$1 AND p.active=TRUE
     ), ranked AS (
       SELECT *,DENSE_RANK() OVER (ORDER BY current_balance+prediction_locked+roulette_locked+slot_locked DESC) AS rank FROM values
     ) SELECT * FROM ranked WHERE id=$2`, [gameId, playerId],
  );
  const player = playerResult.rows[0];
  if (!player) throw new HttpError(404, 'Player not found');

  const [ledger, predictions, roulette, interactive, myRequests, slotBlock, slotSeries, pakBlock, pakMine, pakSixes, pakRoster, slotTurn, photoBlock] = await Promise.all([
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
      'SELECT id,question,status,reason,created_at FROM prediction_requests WHERE game_night_id=$1 AND player_id=$2 ORDER BY created_at DESC,id DESC',
      [gameId, playerId],
    ),
    // The slotmachine only reaches a phone while its block is the live one and its round
    // is active — the same gate the live question uses. That is what makes the controls
    // appear and disappear with the block instead of living on a page of their own.
    pool.query(
      `SELECT b.id,b.round_id,b.title,b.payload,
              COALESCE(sc.total_weight,0)::int AS total_weight,
              COALESCE((SELECT SUM(o.weight) FROM slot_outcome_types o WHERE o.game_night_id=g.id),0)::int AS allocated_weight,
              COALESCE((SELECT COUNT(*) FROM slot_reel_symbols s WHERE s.game_night_id=g.id),0)::int AS symbol_count
       FROM game_nights g JOIN round_blocks b ON b.id=g.current_round_block_id
       JOIN rounds r ON r.id=b.round_id
       LEFT JOIN slot_configs sc ON sc.game_night_id=g.id
       WHERE g.id=$1 AND b.type='SLOTMACHINE' AND r.status='ACTIVE'`, [gameId],
    ),
    pool.query(
      `SELECT sr.id,sr.round_block_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.total_stake,sr.status,
              ss.id AS spin_id,ss.spin_number,ss.outcome_type,
              ss.payout_multiplier,ss.payout,ss.status AS spin_status,ss.spun_at
       FROM slot_series sr
       LEFT JOIN LATERAL (
         SELECT * FROM slot_spins WHERE slot_series_id=sr.id ORDER BY spin_number DESC LIMIT 1
       ) ss ON TRUE
       WHERE sr.game_night_id=$1 AND sr.player_id=$2
         AND sr.round_block_id=(SELECT current_round_block_id FROM game_nights WHERE id=$1)
       ORDER BY CASE sr.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,sr.id DESC LIMIT 1`, [gameId, playerId],
    ),
    // Like the live question and the slotmachine, Pak een Zes only reaches a phone while
    // its block is the live one and its round is active — that is what makes the
    // controls appear and disappear with the block rather than living on a page.
    pool.query(
      `SELECT b.id,b.round_id,b.title,b.payload,
              pz.id AS pak_game_id,pz.status,pz.turn_index,
              COALESCE(pz.points_per_correct, g.pak_een_zes_points_per_correct) AS points_per_correct
       FROM game_nights g JOIN round_blocks b ON b.id=g.current_round_block_id
       JOIN rounds r ON r.id=b.round_id
       LEFT JOIN LATERAL (
         SELECT id,status,turn_index FROM pak_een_zes_games
         WHERE game_night_id=g.id AND round_block_id=b.id ORDER BY id DESC LIMIT 1
       ) pz ON TRUE
       WHERE g.id=$1 AND b.type='PAK_EEN_ZES' AND r.status='ACTIVE'`, [gameId],
    ),
    // The player's own four picks, in slot order. Duplicates survive because the rows
    // are per slot, so "Daan, Twan, Daan, Bas" comes back as four picks.
    pool.query(
      `SELECT pr.slot,pr.predicted_player_id
       FROM pak_een_zes_predictions pr
       JOIN pak_een_zes_games pz ON pz.id=pr.pak_een_zes_game_id
       WHERE pz.game_night_id=$1 AND pr.player_id=$2
         AND pz.round_block_id=(SELECT current_round_block_id FROM game_nights WHERE id=$1)
       ORDER BY pr.slot`, [gameId, playerId],
    ),
    // Who actually drew a six, so this player's own score can be shown afterwards.
    pool.query(
      `SELECT d.player_id
       FROM pak_een_zes_draws d
       JOIN pak_een_zes_games pz ON pz.id=d.pak_een_zes_game_id
       WHERE pz.game_night_id=$1 AND d.is_six
         AND pz.round_block_id=(SELECT current_round_block_id FROM game_nights WHERE id=$1)
       ORDER BY d.draw_number`, [gameId],
    ),
    // Two things in one read: every name the picker can offer, and the frozen turn order
    // with it. `turn_order` is null for anyone who is not a participant, which only
    // happens if they joined after the host started.
    pool.query(
      `SELECT pl.id,pl.display_name,pl.public_color,pt.turn_order
       FROM players pl
       LEFT JOIN pak_een_zes_participants pt
         ON pt.player_id=pl.id
         AND pt.pak_een_zes_game_id=(
           SELECT id FROM pak_een_zes_games
           WHERE game_night_id=$1 AND round_block_id=(SELECT current_round_block_id FROM game_nights WHERE id=$1)
           ORDER BY id DESC LIMIT 1
         )
       WHERE pl.game_night_id=$1 AND pl.active=TRUE
       ORDER BY pl.display_name,pl.id`, [gameId],
    ),
    // The turn, resolved by the same function the spin endpoint enforces, so the button
    // the phone enables and the turn the server allows cannot disagree.
    pool.query('SELECT current_round_block_id FROM game_nights WHERE id=$1', [gameId])
      .then(r => {
        const current = Number(r.rows[0]?.current_round_block_id || 0);
        return current ? loadSlotTurn(pool, gameId, current) : null;
      }),
    // Like the other games, a Fotoronde only reaches a phone while its block is live and
    // its round is active. The team comes from the round's groups, never from the phone.
    pool.query(
      `SELECT b.id,b.round_id,b.title,b.payload,fr.id AS photo_round_id,fr.status
       FROM game_nights g JOIN round_blocks b ON b.id=g.current_round_block_id
       JOIN rounds r ON r.id=b.round_id
       LEFT JOIN photo_rounds fr ON fr.round_block_id=b.id AND fr.game_night_id=g.id
       WHERE g.id=$1 AND b.type='FOTORONDE' AND r.status='ACTIVE'`, [gameId],
    ),
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

  // The phone is only ever a controller: it receives its own series, the limits it must
  // respect and the last outcome as text. It never receives the reel strip or a
  // forthcoming outcome — the reels exist only on the Big Screen.
  const slotBlockRow = slotBlock.rows[0];
  const slotSeriesRow = slotSeries.rows[0];
  const slotmachine = slotBlockRow ? (() => {
    // Same verdict the Admin sees, reached from aggregates this one query already
    // returned rather than three more round trips on the hottest polling path.
    const configStatus = describeSlotConfig({
      totalWeight: Number(slotBlockRow.total_weight),
      allocatedWeight: Number(slotBlockRow.allocated_weight),
      symbolCount: Number(slotBlockRow.symbol_count),
    });
    const settings = slotBlockSettings(slotBlockRow.payload);
    const allowed = settings.allowedPlayerIds.length === 0 || settings.allowedPlayerIds.includes(Number(player.id));
    const series = slotSeriesRow && Number(slotSeriesRow.round_block_id) === Number(slotBlockRow.id) ? {
      id: Number(slotSeriesRow.id),
      stakePerSpin: Number(slotSeriesRow.stake_per_spin),
      totalSpins: Number(slotSeriesRow.total_spins),
      spinsRemaining: Number(slotSeriesRow.spins_remaining),
      totalStake: Number(slotSeriesRow.total_stake),
      status: slotSeriesRow.status,
      lastSpin: slotSeriesRow.spin_id ? {
        spinNumber: Number(slotSeriesRow.spin_number),
        // Held back until the Big Screen animation has finished, so the phone cannot
        // spoil the reels for the room. The phone shows the category name — never the
        // field, which belongs on the projector.
        outcome: slotSeriesRow.spin_status === 'RESULT'
          ? SLOT_OUTCOME_LABELS[slotSeriesRow.outcome_type as SlotOutcomeType] || slotSeriesRow.outcome_type
          : null,
        payoutMultiplier: slotSeriesRow.spin_status === 'RESULT' ? Number(slotSeriesRow.payout_multiplier) : null,
        payout: slotSeriesRow.spin_status === 'RESULT' ? Number(slotSeriesRow.payout) : null,
        status: slotSeriesRow.spin_status,
      } : null,
    } : null;
    return {
      blockId: Number(slotBlockRow.id),
      roundId: Number(slotBlockRow.round_id),
      title: slotBlockRow.title || 'Slotmachine',
      instructions: settings.instructions,
      maxSpins: settings.maxSpins,
      allowed,
      // Whether the machine itself is configured. The phone needs it so INZET VASTZETTEN
      // can explain why it is unavailable rather than failing on submit.
      configValid: configStatus.valid,
      configReason: configStatus.reason,
      // One player at a time. Everyone else is told who they are waiting for rather
      // than being shown a dead button.
      turn: slotTurn ? {
        current: slotTurn.current ? { playerId: slotTurn.current.playerId, name: slotTurn.current.playerName ?? null, spinsRemaining: slotTurn.current.spinsRemaining, totalSpins: slotTurn.current.totalSpins, stakePerSpin: slotTurn.current.stakePerSpin } : null,
        next: slotTurn.next ? { playerId: slotTurn.next.playerId, name: slotTurn.next.playerName ?? null } : null,
        spinning: slotTurn.spinning,
        isMyTurn: Boolean(slotTurn.current && slotTurn.current.playerId === Number(player.id)),
        // The server's own verdict, not a re-derivation on the phone.
        maySpin: slotTurn ? maySpin(slotTurn, Number(player.id)) : false,
        waitingFor: slotTurn.current && slotTurn.current.playerId !== Number(player.id) ? (slotTurn.current.playerName ?? null) : null,
        allDone: !slotTurn.current,
      } : null,
      series: series && series.status === 'ACTIVE' ? series : null,
      lastSeries: series,
    };
  })() : null;

  // The phone is a controller here too: predict during the prediction phase, then a
  // single big KAART PAKKEN when it is your turn. It never learns the deck or the next
  // card — the card is revealed on the projector.
  const pakRow = pakBlock.rows[0];
  const pakEenZes = pakRow ? (() => {
    const settings = pakEenZesBlockSettings(pakRow.payload);
    const status = pakRow.status || 'READY';
    const picks = pakMine.rows.map((r: any) => Number(r.predicted_player_id));
    const roster = pakRoster.rows.map((r: any) => ({
      id: Number(r.id),
      name: r.display_name,
      color: r.public_color,
      turnOrder: r.turn_order == null ? null : Number(r.turn_order),
    }));
    // The turn is resolved with the same function the draw endpoint uses, so the button
    // the phone enables and the turn the server enforces cannot disagree.
    const order = roster
      .filter((r: any) => r.turnOrder != null)
      .sort((a: any, b: any) => (a.turnOrder as number) - (b.turnOrder as number));
    const currentPlayer = status === 'DRAWING' ? playerAtTurn(order, Number(pakRow.turn_index || 0)) : null;
    return {
      blockId: Number(pakRow.id),
      roundId: Number(pakRow.round_id),
      title: pakRow.title || 'Pak een Zes',
      instructions: settings.instructions,
      status,
      predicting: status === 'PREDICTING',
      drawing: status === 'DRAWING',
      finished: status === 'FINISHED',
      // Four picks only count as a saved prediction once all four are in.
      myPicks: picks.length === 4 ? picks : [],
      hasPredicted: picks.length === 4,
      // Shown before predicting, so the player knows what a correct pick is worth. Not
      // hardcoded anywhere — this is the Admin's Settings value, or the rate the game
      // actually paid once it has finished.
      pointsPerCorrect: Number(pakRow.points_per_correct ?? 0),
      // This player's own score. Multiset matching, so a name picked twice can count
      // twice when that person drew two sixes.
      myScore: picks.length === 4 ? (() => {
        const correct = countCorrectPredictions(picks, pakSixes.rows.map((r: any) => Number(r.player_id)));
        return { correct, points: predictionPoints(correct, Number(pakRow.points_per_correct ?? 0)) };
      })() : null,
      // Everyone active can be named — including yourself, and more than once.
      players: roster.map((r: any) => ({ id: r.id, name: r.name, color: r.color })),
      turnOrder: order.map((r: any) => ({ id: r.id, name: r.name })),
      currentPlayer: currentPlayer ? { id: currentPlayer.id, name: currentPlayer.name } : null,
      isMyTurn: Boolean(currentPlayer && currentPlayer.id === Number(player.id)),
    };
  })() : null;

  // The phone shows the subject list with this player's own team's photos against it.
  // Which team that is comes from the round's groups: a player is in at most one group
  // per round, so uploading for another team is not something the client can ask for.
  const photoRow = photoBlock.rows[0];
  const photoRound = photoRow ? await (async () => {
    const subjects = photoRoundSubjects(photoRow.payload);
    const status = photoRow.status || 'DRAFT';
    const team = await playerTeamForRound(pool, Number(photoRow.round_id), playerId);
    const own = team && photoRow.photo_round_id
      ? await pool.query(
        `SELECT s.subject_key,s.media_key,s.created_at,p.display_name AS uploader_name
         FROM photo_submissions s LEFT JOIN players p ON p.id=s.uploaded_by
         WHERE s.photo_round_id=$1 AND s.group_id=$2`,
        [Number(photoRow.photo_round_id), team.groupId],
      )
      : { rows: [] } as any;
    const byKey = new Map<string, any>();
    for (const row of own.rows) byKey.set(row.subject_key, row);

    return {
      blockId: Number(photoRow.id),
      roundId: Number(photoRow.round_id),
      title: photoRow.title || 'Fotoronde',
      instructions: photoRoundInstructions(photoRow.payload),
      status,
      open: status === 'OPEN',
      // Null when this player is in no team: they are told so rather than shown an
      // upload button that the server would refuse.
      team: team ? { groupId: team.groupId, name: team.name } : null,
      subjects: subjects.map(subject => {
        const submitted = byKey.get(subject.key);
        return {
          ...subject,
          // Any team member's photo counts as the team's photo — that is what makes a
          // second member see it is already done.
          submitted: Boolean(submitted),
          mediaKey: submitted?.media_key ?? null,
          uploaderName: submitted?.uploader_name ?? null,
          uploadedAt: submitted?.created_at ?? null,
        };
      }),
    };
  })() : null;

  // The player's own prediction requests, plus how many they have left and whether they
  // are on cooldown. Computed here so the phone can explain the limits before the player
  // types something and gets refused.
  const myRequestRows = myRequests.rows;
  const lastSubmittedAt = myRequestRows[0]?.created_at ?? null;
  return {
    version: Number(player.game_state_version),
    predictionRequests: {
      mine: myRequestRows.map((r: any) => ({
        id: Number(r.id), question: r.question, status: r.status, reason: r.reason,
        statusLabel: describeRequestStatus(r.status, r.reason),
      })),
      remaining: requestsRemaining(myRequestRows.length),
      cooldownMinutesLeft: cooldownMinutesLeft(lastSubmittedAt),
    },
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
    slotmachine,
    pakEenZes,
    photoRound,
    actionable: normalizedPredictions.some((p: any) => p.status === 'OPEN') || currentRoulette?.status === 'OPEN' || interactiveBlock?.status === 'OPEN'
      || Boolean(slotmachine?.allowed && slotmachine.configValid)
      || Boolean(pakEenZes && ['PREDICTING', 'DRAWING'].includes(pakEenZes.status))
      || Boolean(photoRound?.open && photoRound.team),
    recentLedger: ledger.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
  };
}

function eventTimestamp(value: unknown) {
  return value ? new Date(String(value)).getTime() : 0;
}

export async function getScreenState(gameId: number) {
  // Timer reconciliation is owned by getGameVersion, which every client polls before
  // it ever asks for a snapshot. Repeating the due-check here cost an extra query on
  // every snapshot for no new information. If a timer falls due while nobody is
  // polling, the next version poll reconciles it and bumps the version, which pulls a
  // fresh snapshot — so this self-heals within one poll interval.
  const pool = database().pool;
  const gameResult = await pool.query('SELECT g.*,s.mode,s.round_id AS screen_round_id,s.prediction_id,s.payload FROM game_nights g LEFT JOIN screen_state s ON s.game_night_id=g.id WHERE g.id=$1', [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');
  const screenMode = game.mode || game.current_screen_mode || 'DASHBOARD';
  const blockId = ['ROUND_BLOCK','ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'].includes(screenMode) ? (Number(game.payload?.blockId || game.current_round_block_id || 0) || null) : null;
  const rouletteGameId = screenMode === 'ROULETTE' ? (Number(game.payload?.rouletteGameId || 0) || null) : null;

  const [round, block, prediction, players, ledgerEvents, predictionEvents, rouletteEvents, ticker, totals, roulette, recentResults, slot, slotSpins, pakEenZesGame, pakPredictionCount, screenSlotTurn, screenPhotoRound] = await Promise.all([
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
              COALESCE((SELECT SUM(sr.stake_per_spin*sr.spins_remaining) FROM slot_series sr WHERE sr.player_id=p.id AND sr.status='ACTIVE'),0)::int AS slot_locked
       FROM players p JOIN wallets w ON w.player_id=p.id WHERE p.game_night_id=$1 AND p.active=TRUE ORDER BY w.current_balance DESC,p.display_name`, [gameId],
    ),
    pool.query(
      `SELECT l.id,l.player_id,l.amount,l.transaction_type,l.created_at
       FROM ledger_entries l JOIN players p ON p.id=l.player_id
       WHERE l.game_night_id=$1 AND p.active=TRUE AND l.transaction_type NOT IN (
         'STARTING_BALANCE','PREDICTION_DEPOSIT','BET_STAKE','BET_PAYOUT','BET_REFUND','ROULETTE_STAKE','ROULETTE_PAYOUT','ROULETTE_REFUND'
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
              COALESCE((SELECT SUM(sr.stake_per_spin*sr.spins_remaining) FROM slot_series sr WHERE sr.game_night_id=$1 AND sr.status='ACTIVE'),0)::int AS slot_stakes,
              (SELECT COUNT(*) FROM predictions WHERE game_night_id=$1 AND status='OPEN')::int + (SELECT COUNT(*) FROM roulette_games WHERE game_night_id=$1 AND status='OPEN')::int AS markets_open`, [gameId],
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
    // The projector is the only surface that renders reels, so it is the only one that
    // receives the reel strips.
    screenMode === 'SLOTMACHINE' ? loadSlotConfig(pool, gameId) : Promise.resolve(null),
    screenMode === 'SLOTMACHINE' && blockId
      ? pool.query(
        `SELECT ss.id,ss.spin_number,ss.outcome_type,ss.grid,ss.win_cells,
                ss.stake,ss.payout_multiplier,ss.payout,ss.status,ss.spun_at,
                p.display_name,p.public_color,
                sr.id AS series_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.status AS series_status
         FROM slot_spins ss JOIN players p ON p.id=ss.player_id JOIN slot_series sr ON sr.id=ss.slot_series_id
         WHERE ss.round_block_id=$1 AND ss.game_night_id=$2
         ORDER BY ss.spun_at DESC,ss.id DESC LIMIT 6`, [blockId, gameId])
      : Promise.resolve({ rows: [] } as any),
    // The projector is the only surface that shows the deck and the reveal.
    screenMode === 'PAK_EEN_ZES' && blockId
      ? loadPakEenZesGame(pool, gameId, blockId)
      : Promise.resolve(null),
    screenMode === 'PAK_EEN_ZES'
      ? pool.query('SELECT COUNT(*)::int AS n FROM players WHERE game_night_id=$1 AND active=TRUE', [gameId])
      : Promise.resolve({ rows: [{ n: 0 }] } as any),
    screenMode === 'SLOTMACHINE' && blockId
      ? loadSlotTurn(pool, gameId, blockId)
      : Promise.resolve(null),
    screenMode === 'FOTORONDE' && blockId
      ? pool.query('SELECT payload FROM round_blocks WHERE id=$1 AND game_night_id=$2', [blockId, gameId])
        .then(r => (r.rows[0] ? loadPhotoRound(pool, gameId, blockId, r.rows[0].payload) : null))
      : Promise.resolve(null),
  ]);

  type EconEvent = { playerId: number; delta: number; time: number; key: string };
  const events: EconEvent[] = [];
  ledgerEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: Number(e.amount), time: eventTimestamp(e.created_at), key: `l${e.id}` }));
  predictionEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: e.status === 'WON' ? Number(e.potential_return) - Number(e.stake) : -Number(e.stake), time: eventTimestamp(e.settled_at), key: `p${e.id}` }));
  rouletteEvents.rows.forEach((e: any) => events.push({ playerId: Number(e.player_id), delta: e.status === 'WON' ? Number(e.potential_return) - Number(e.stake) : -Number(e.stake), time: eventTimestamp(e.settled_at), key: `r${e.id}` }));
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
    // The whole slotmachine scene. The projector is the only surface that draws the
    // field, so it is the only one that receives it. `currentSpin.grid` is the outcome
    // the server already committed, which is what the animation lands on, and
    // `spinning` tells the projector to animate rather than reveal.
    slotmachine: slot ? (() => {
      const spins = slotSpins.rows.map((row: any) => ({
        id: Number(row.id),
        spinNumber: Number(row.spin_number),
        outcomeType: row.outcome_type as SlotOutcomeType,
        outcome: SLOT_OUTCOME_LABELS[row.outcome_type as SlotOutcomeType] || row.outcome_type,
        // 3 rows x 3 cells of { position, mediaKey } — the artwork as it was at spin time.
        grid: (Array.isArray(row.grid) ? row.grid : []).map((gridRow: any) =>
          (Array.isArray(gridRow) ? gridRow : []).map((cell: any) => ({
            position: Number(cell?.p ?? 0),
            letter: symbolLetter(Number(cell?.p ?? 0)),
            mediaKey: typeof cell?.k === 'string' ? cell.k : '',
          }))),
        winCells: (Array.isArray(row.win_cells) ? row.win_cells : []).map((cell: any) => [Number(cell?.[0]), Number(cell?.[1])]),
        stake: Number(row.stake),
        payoutMultiplier: Number(row.payout_multiplier),
        payout: Number(row.payout),
        status: row.status,
        spinning: row.status === 'SPINNING',
        spunAt: row.spun_at,
        playerName: row.display_name,
        playerColor: row.public_color,
        seriesId: Number(row.series_id),
        stakePerSpin: Number(row.stake_per_spin),
        totalSpins: Number(row.total_spins),
        spinsRemaining: Number(row.spins_remaining),
        seriesStatus: row.series_status,
      }));
      return {
        blockId,
        configValid: slot.status.valid,
        configReason: slot.status.reason,
        // The twelve symbols, sent once. The projector uses them as the blur each reel
        // spins through; the symbols it actually lands on come from the spin's own
        // field, not from this strip.
        strip: Array.from({ length: 12 }, (_, index) => {
          const position = index + 1;
          return { position, letter: symbolLetter(position), mediaKey: slot.symbolByPosition[position] || '' };
        }),
        currentSpin: spins[0] || null,
        recentSpins: spins.slice(1),
        // The whole turn stays on screen for the player's entire run: who is up, what
        // they bought, what is left. Only the remaining count changes between spins.
        turn: screenSlotTurn ? {
          current: screenSlotTurn.current,
          next: screenSlotTurn.next,
          spinning: screenSlotTurn.spinning,
          queue: screenSlotTurn.queue,
          finished: screenSlotTurn.finished,
          allDone: !screenSlotTurn.current,
        } : null,
      };
    })() : null,
    // The Pak een Zes scene: before the game it counts predictions, during it shows the
    // deck, the turn and the last card, and after it lists the four sixes and who drew
    // them. `lastDraw` is what the reveal animates to — it is already committed.
    pakEenZes: pakEenZesGame ? {
      blockId,
      status: pakEenZesGame.status,
      turnIndex: pakEenZesGame.turnIndex,
      participants: pakEenZesGame.participants,
      currentPlayer: pakEenZesGame.currentPlayer,
      drawnCount: pakEenZesGame.drawnCount,
      cardsRemaining: pakEenZesGame.cardsRemaining,
      lastDraw: pakEenZesGame.draws[pakEenZesGame.draws.length - 1] || null,
      recentDraws: pakEenZesGame.draws.slice(-6).reverse(),
      sixes: pakEenZesGame.sixes,
      sixesFound: pakEenZesGame.sixes.length,
      predictionCount: pakEenZesGame.predictionCount,
      activePlayerCount: Number(pakPredictionCount.rows[0]?.n || 0),
      finished: pakEenZesGame.finished,
      pointsPerCorrect: pakEenZesGame.pointsPerCorrect,
      // Only the players who scored something, best first — the room does not need a
      // list of zeros.
      results: pakEenZesGame.results.filter(r => r.correct > 0),
      allResults: pakEenZesGame.results,
    } : null,
    // The Fotoronde scene. During the open phase it counts submissions per subject; when
    // the Admin picks a photo to judge, that photo fills the screen with its team's name.
    photoRound: screenPhotoRound ? (() => {
      const shownId = Number(game.payload?.photoSubmissionId || 0) || null;
      const shown = shownId ? screenPhotoRound.submissions.find(s => s.id === shownId) || null : null;
      const shownSubject = shown
        ? screenPhotoRound.subjects.find(subject => subject.key === shown.subjectKey) || null
        : null;
      return {
        blockId,
        status: screenPhotoRound.status,
        teamCount: screenPhotoRound.teams.length,
        subjects: screenPhotoRound.bySubject.map(entry => ({
          key: entry.subject.key,
          label: entry.subject.label,
          submittedCount: entry.submittedCount,
        })),
        submissionCount: screenPhotoRound.submissionCount,
        judgedCount: screenPhotoRound.judgedCount,
        teamTotals: screenPhotoRound.teamTotals,
        // One photo, blown up, with its team — what the room looks at while it is judged.
        shown: shown ? {
          id: shown.id,
          mediaKey: shown.mediaKey,
          teamName: shown.teamName,
          uploaderName: shown.uploaderName,
          subjectLabel: shownSubject?.label ?? null,
          creditsAwarded: shown.creditsAwarded,
        } : null,
      };
    })() : null,
    recentPredictionResults: recentResults.rows.map((r: any) => ({ id: Number(r.id), number: Number(r.display_number), question: r.question, result: r.result, yesOdds: Number(r.yes_odds), noOdds: Number(r.no_odds), settledAt: r.settled_at })),
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
