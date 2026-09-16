import { database, withTransaction } from './db';
import { HttpError } from './http';
import { incrementGameVersion } from './game-state';
import { publicPredictionStatus } from './economy';
import { cooldownMinutesLeft, describeRequestStatus, requestsRemaining } from './prediction-requests';
import { loadSlotConfig, loadSlotTurn, slotRoundIsFinished } from './slot-state';
import { loadPakEenZesGame } from './pak-een-zes-state';
import { loadPhotoRound, playerTeamForRound } from './photo-round-state';
import { countCorrectPredictions, playerAtTurn, predictionPoints } from './pak-een-zes';
import { describeSlotConfig, maySpin, symbolLetter, SLOT_OUTCOME_LABELS, SLOT_SPIN_MS, type SlotOutcomeType } from './slotmachine';
import { isRevealed, mayShowContextPhoto, questionParticipation } from './live-quiz';
import { settleRouletteRun, ROULETTE_SPIN_MS } from './roulette';
import { completeRound } from './round-lifecycle';
import { loadAllRoundContent, loadRoundRuntime } from './rounds';
import {
  adminRound, adminQuizQuestion, adminPubquizQuestion, adminSlide, adminSubject,
  playerQuizQuestion, playerPubquizQuestion, publicRound, publicSubject,
  screenQuizQuestion, screenPubquizQuestion, screenRoulette, screenSlide,
} from './dto';


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

    // The moment a roulette result becomes final is the moment everybody is paid.
    //
    // Settlement used to be a separate Admin button pressed after this transition, which
    // meant the room could be looking at a winning number while no wallet had moved, and
    // a host who navigated away instead of pressing it simply never paid out. Now the
    // transition out of SPINNING and the payout are the same transaction.
    //
    // `WHERE status='SPINNING'` is the whole concurrency story: two pollers arriving
    // together both try this UPDATE, one wins the row and settles, the other gets no rows
    // back and does nothing. Nothing is paid twice even before the per-bet business key
    // gets involved.
    const spun = await client.query(
      `UPDATE roulette_games SET status='RESULT',updated_at=NOW()
       WHERE game_night_id=$1 AND status='SPINNING' AND spun_at IS NOT NULL
         AND spun_at<=NOW()-($2::text||' milliseconds')::interval
       RETURNING id`,
      [gameId, ROULETTE_SPIN_MS],
    );
    if (spun.rowCount) {
      changed = true;
      // 'timer' rather than an admin name: no human pressed anything, and the ledger
      // should say so.
      for (const row of spun.rows) await settleRouletteRun(client, gameId, Number(row.id), 'timer');
    }

    // A slot spin's outcome was already final when it was written; this only ends the
    // presentational SPINNING window so every surface can show the result together.
    const slotRevealed = await client.query(
      `UPDATE slot_spins SET status='RESULT'
       WHERE game_night_id=$1 AND status='SPINNING' AND spun_at<=NOW()-($2::text||' milliseconds')::interval
       RETURNING id`,
      [gameId, SLOT_SPIN_MS],
    );
    if (slotRevealed.rowCount) changed = true;

    // A slotmachine round ends itself once everybody has had their run.
    //
    // Checked here rather than at the end of a spin, because a spin is not over until its
    // animation window has elapsed — which is this transaction. The guard inside
    // `completeRound` is what makes it happen once: the last two players finishing almost
    // together both reach this, one moves the round out of ACTIVE and the other finds
    // nothing to move.
    if (slotRevealed.rowCount) {
      const active = await client.query(
        `SELECT r.id,r.type FROM rounds r JOIN game_nights g ON g.current_round_id=r.id
         WHERE g.id=$1 AND r.status='ACTIVE' AND r.type='SLOTMACHINE' FOR UPDATE OF r`,
        [gameId],
      );
      const round = active.rows[0];
      if (round) {
        const state = await slotRoundIsFinished(client, gameId, Number(round.id));
        if (state.finished) {
          await completeRound(client, gameId, Number(round.id), 'SLOTMACHINE', 'timer', 'round completed');
        }
      }
    }

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
  const activeRoundId = game.current_round_id ? Number(game.current_round_id) : null;

  const [rounds, groups, players, predictions, recent, screen, requests, slotConfig] = await Promise.all([
    pool.query(
      `SELECT id,game_night_id,sort_order,title,description,type,status,instructions,default_points,started_at,completed_at
       FROM rounds WHERE game_night_id=$1 ORDER BY sort_order,id`, [gameId],
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
       SELECT p.id,p.display_name,p.public_color,p.active,p.created_at,p.seed_key,w.current_balance,r.rank,
              EXISTS(SELECT 1 FROM player_sessions s WHERE s.player_id=p.id AND s.revoked_at IS NULL AND s.expires_at>NOW()) AS joined,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions pr ON pr.id=b.prediction_id WHERE b.player_id=p.id AND b.status='ACTIVE' AND pr.status IN ('OPEN','LOCKED','RESULT')),0)::int AS locked_prediction
       FROM players p JOIN wallets w ON w.player_id=p.id LEFT JOIN ranked r ON r.id=p.id
       WHERE p.game_night_id=$1 ORDER BY p.active DESC,p.display_name`, [gameId],
    ),
    pool.query(
      `SELECT p.*,COUNT(b.id)::int AS bet_count,COUNT(b.id)::int AS participation_count,
              COALESCE(SUM(b.stake) FILTER (WHERE b.status='ACTIVE'),0)::int AS deposited_coins,
              r.sort_order AS round_number,r.title AS round_title
       FROM predictions p LEFT JOIN rounds r ON r.id=p.round_id LEFT JOIN bets b ON b.prediction_id=p.id
       WHERE p.game_night_id=$1 GROUP BY p.id,r.sort_order,r.title ORDER BY p.display_number,p.id`, [gameId],
    ),
    pool.query(
      `SELECT l.id,l.amount,l.description,l.transaction_type,l.created_at,p.display_name,
              r.sort_order AS round_number,pr.display_number AS prediction_number,l.roulette_game_id,g.name AS group_name
       FROM ledger_entries l JOIN players p ON p.id=l.player_id
       LEFT JOIN rounds r ON r.id=l.attributed_round_id LEFT JOIN predictions pr ON pr.id=l.prediction_id
       LEFT JOIN round_groups g ON g.id=l.round_group_id
       WHERE l.game_night_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 12`, [gameId],
    ),
    pool.query(
      `SELECT mode,round_id,prediction_id,quiz_question_id,slide_id,payload,
              staged_mode,staged_round_id,staged_prediction_id,staged_quiz_question_id,staged_slide_id,
              previous_mode,previous_round_id,previous_prediction_id,previous_quiz_question_id,previous_slide_id
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
  ]);

  // Who may answer a live question: every active player. Derived from the player rows
  // this snapshot already fetched rather than a second query.
  const eligibleCount = players.rows.filter((p: any) => p.active).length;

  // All content for the whole game in a fixed number of queries, then grouped in memory.
  // One query per round would have been simpler to write and would have made a ten-round
  // evening cost ten times as much database compute, for the whole evening, on a snapshot
  // every client polls.
  const content = await loadAllRoundContent(pool, gameId);
  const roundsWithContent = rounds.rows.map((row: any) => {
    const round = adminRound(row);
    const id = round.id;
    const base = {
      ...round,
      groups: groups.rows
        .filter((g: any) => Number(g.round_id) === id)
        .map((g: any) => ({
          id: Number(g.id), round_id: Number(g.round_id), name: g.name, created_at: g.created_at,
          members: (g.members || []).map((m: any) => ({ ...m, id: Number(m.id), active: Boolean(m.active) })),
        })),
    };

    // Only the content that round's type can have. A quiz round is not given an empty
    // slide list, so a surface reading `slides` on it gets undefined rather than a lie.
    if (round.type === 'LIVE_QUIZ') {
      return {
        ...base,
        questions: (content.questionsByRound.get(id) || []).map(q => adminQuizQuestion(q.row, q.options, eligibleCount)),
      };
    }
    if (round.type === 'PRESENTATIE') {
      return { ...base, slides: (content.slidesByRound.get(id) || []).map(adminSlide) };
    }
    if (round.type === 'PUBQUIZ') {
      return {
        ...base,
        pubquizQuestions: (content.pubquizByRound.get(id) || [])
          .map(q => adminPubquizQuestion(q.row, q.options, q.answers, eligibleCount)),
      };
    }
    if (round.type === 'FOTORONDE') {
      return { ...base, subjects: (content.subjectsByRound.get(id) || []).map(adminSubject) };
    }
    if (round.type === 'SLOTMACHINE') {
      return { ...base, slotmachine: content.slotByRound.get(id) || { maxSpins: 10, allowedPlayerIds: [] } };
    }
    return base;
  });

  // Everything below is about the round being played. A game with no active round gets
  // nulls rather than a shape full of empty lists, so the Control Center can tell "no
  // round" from "a round with nothing in it".
  const activeRound = roundsWithContent.find(r => r.id === activeRoundId) || null;
  const runtime = activeRoundId ? await loadRoundRuntime(pool, activeRoundId) : null;

  const [roulette, slotSeries, slotSpins, pakEenZes, slotTurn, photoRound] = await Promise.all([
    activeRound?.type === 'ROULETTE'
      ? pool.query(
        `SELECT rg.*,COUNT(rb.id) FILTER (WHERE rb.status='ACTIVE')::int AS bet_count,
                COALESCE(SUM(rb.stake) FILTER (WHERE rb.status='ACTIVE'),0)::int AS total_stake,
                -- A player with five chips is one participant. This is the number the
                -- host reads to decide whether to close betting, so it counts people.
                COUNT(DISTINCT rb.player_id) FILTER (WHERE rb.status='ACTIVE')::int AS live_participants,
                (SELECT COUNT(*)::int FROM players pl WHERE pl.game_night_id=$1 AND pl.active=TRUE) AS eligible_players
         FROM roulette_games rg LEFT JOIN roulette_bets rb ON rb.roulette_game_id=rg.id
         WHERE rg.game_night_id=$1 AND rg.round_id=$2
         GROUP BY rg.id ORDER BY rg.run_number DESC,rg.id DESC LIMIT 1`, [gameId, activeRoundId])
      : Promise.resolve({ rows: [] as any[] }),
    activeRound?.type === 'SLOTMACHINE'
      ? pool.query(
        `SELECT sr.id,sr.player_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.total_stake,sr.status,sr.created_at,
                p.display_name,p.public_color
         FROM slot_series sr JOIN players p ON p.id=sr.player_id
         WHERE sr.game_night_id=$1 AND sr.round_id=$2
         ORDER BY CASE sr.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,sr.id DESC LIMIT 20`, [gameId, activeRoundId])
      : Promise.resolve({ rows: [] as any[] }),
    activeRound?.type === 'SLOTMACHINE'
      ? pool.query(
        `SELECT ss.id,ss.player_id,ss.spin_number,ss.outcome_type,
                ss.stake,ss.payout_multiplier,ss.payout,ss.status,ss.spun_at,p.display_name
         FROM slot_spins ss JOIN players p ON p.id=ss.player_id
         WHERE ss.game_night_id=$1 AND ss.round_id=$2
         ORDER BY ss.spun_at DESC,ss.id DESC LIMIT 8`, [gameId, activeRoundId])
      : Promise.resolve({ rows: [] as any[] }),
    activeRound?.type === 'PAK_EEN_ZES' ? loadPakEenZesGame(pool, gameId, activeRoundId!) : Promise.resolve(null),
    activeRound?.type === 'SLOTMACHINE' ? loadSlotTurn(pool, gameId, activeRoundId!) : Promise.resolve(null),
    activeRound?.type === 'FOTORONDE'
      ? loadPhotoRound(pool, gameId, activeRoundId!, (activeRound as any).subjects.map((s: any) => ({ key: s.key, label: s.label })))
      : Promise.resolve(null),
  ]);

  const normalizedPredictions = predictions.rows.map(normalizePrediction);
  const screenRow = screen.rows[0];

  return {
    version: Number(game.game_state_version),
    game: {
      id: Number(game.id), name: game.name, starting_balance: Number(game.starting_balance),
      maximum_wallet_percentage: game.maximum_wallet_percentage == null ? null : Number(game.maximum_wallet_percentage),
      current_round_id: activeRoundId,
      current_screen_mode: game.current_screen_mode,
      game_state_version: Number(game.game_state_version),
    },
    // Live, staged and previous presentation pointers, all from the one screen_state row.
    // Typed columns now rather than ids inside a JSON payload, so a pointer at deleted
    // content is a null instead of a number naming nothing.
    screen: (() => {
      const slot = (mode: any, roundId: any, predictionId: any, questionId: any, slideId: any) => ({
        mode: mode || null,
        roundId: Number(roundId || 0) || null,
        predictionId: Number(predictionId || 0) || null,
        questionId: Number(questionId || 0) || null,
        slideId: Number(slideId || 0) || null,
      });
      return {
        ...slot(screenRow?.mode || game.current_screen_mode, screenRow?.round_id, screenRow?.prediction_id, screenRow?.quiz_question_id, screenRow?.slide_id),
        staged: slot(screenRow?.staged_mode, screenRow?.staged_round_id, screenRow?.staged_prediction_id, screenRow?.staged_quiz_question_id, screenRow?.staged_slide_id),
        previous: slot(screenRow?.previous_mode, screenRow?.previous_round_id, screenRow?.previous_prediction_id, screenRow?.previous_quiz_question_id, screenRow?.previous_slide_id),
        // Which Fotoronde photo is enlarged on the projector — presentational only.
        photoSubmissionId: Number(screenRow?.payload?.photoSubmissionId || 0) || null,
      };
    })(),
    predictionRequests: requests.rows.map((r: any) => ({
      id: Number(r.id), playerId: Number(r.player_id), playerName: r.display_name,
      question: r.question, status: r.status, reason: r.reason, createdAt: r.created_at,
    })),
    rounds: roundsWithContent,
    activeRound,
    // The round's own execution cursor. Separate from `screen` above, and deliberately
    // so: one is where the game is, the other is what the audience is looking at.
    roundRuntime: runtime,
    // `is_default` rather than the seed key itself: the Admin screen only needs to know
    // whether this is one of the standard ten — they are the players a reset puts back,
    // and the others are the ones it removes.
    players: players.rows.map((p: any) => ({ ...p, id: Number(p.id), current_balance: Number(p.current_balance), locked_prediction: Number(p.locked_prediction), rank: p.rank ? Number(p.rank) : null, active: Boolean(p.active), joined: Boolean(p.joined), is_default: p.seed_key != null })),
    predictions: normalizedPredictions,
    activePredictions: normalizedPredictions.filter((p: any) => ['OPEN','LOCKED','RESULT'].includes(p.status)),
    recentTransactions: recent.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
    activeRoulette: (() => {
      const r = roulette.rows[0];
      if (!r) return null;
      const settled = r.status === 'SETTLED';
      // A settled run's numbers come from the run itself, frozen when it paid out; a live
      // one is counted from the bets on the table right now.
      const participants = settled ? Number(r.participant_count) : Number(r.live_participants);
      const eligible = Number(r.eligible_players);
      return {
        ...r, id: Number(r.id), round_id: r.round_id ? Number(r.round_id) : null,
        runNumber: Number(r.run_number),
        // Held back from the Admin while the wheel is still turning, exactly as before:
        // the host is the one person who could act on an early number.
        result_number: r.status === 'SPINNING' || r.result_number == null ? null : Number(r.result_number),
        bet_count: Number(r.bet_count),
        total_stake: settled ? Number(r.total_staked) : Number(r.total_stake),
        participantCount: participants,
        eligiblePlayers: eligible,
        participationPercentage: eligible > 0 ? Math.round((participants / eligible) * 100) : 0,
        settled,
        totals: settled ? {
          staked: Number(r.total_staked),
          payout: Number(r.total_payout),
          net: Number(r.total_payout) - Number(r.total_staked),
        } : null,
      };
    })(),
    // Everything the host judges from: photos grouped by subject, which teams are still
    // missing, what each has earned, and how each award was split.
    photoRound: (() => {
      if (!activeRound || activeRound.type !== 'FOTORONDE') return null;
      const subjects = ((activeRound as any).subjects || []).map((s: any) => ({ key: s.key, label: s.label }));
      // Spread first so the loaded round's own fields win; the fallback stands in for a
      // round the host has not opened yet, which has no row.
      return {
        ...(photoRound || {
          id: null,
          status: 'DRAFT',
          teams: [],
          submissions: [],
          // Still list the subjects, so the host sees what will be asked.
          bySubject: subjects.map((subject: any) => ({ subject, submissions: [], missingTeams: [], submittedCount: 0 })),
          teamTotals: [],
          submissionCount: 0,
          judgedCount: 0,
          totalCredits: 0,
          acceptsUploads: false,
          acceptsAwards: false,
        }),
        roundId: activeRound.id,
        subjects: (activeRound as any).subjects,
        instructions: activeRound.instructions,
        shownSubmissionId: Number(screenRow?.payload?.photoSubmissionId || 0) || null,
      };
    })(),
    slotConfig,
    // What the host needs while a Pak een Zes runs: whose turn it is, how far the deck
    // has gone, which sixes are out and who is still missing a prediction.
    pakEenZes: (() => {
      if (!pakEenZes || !activeRound || activeRound.type !== 'PAK_EEN_ZES') return null;
      const activePlayers = players.rows.filter((p: any) => p.active);
      const predicted = new Set(pakEenZes.predictedPlayerIds);
      return {
        ...pakEenZes,
        roundId: activeRound.id,
        // Named rather than counted: the host is explicitly allowed to close without
        // everyone, so they need to see who they are closing without.
        awaitingPrediction: activePlayers
          .filter((p: any) => !predicted.has(Number(p.id)))
          .map((p: any) => ({ playerId: Number(p.id), name: p.display_name })),
        sixesFound: pakEenZes.sixes.length,
        activePlayerCount: activePlayers.length,
        pointsPerCorrect: activeRound.defaultPoints,
      };
    })(),
    // Live slotmachine picture for the active round.
    activeSlot: (() => {
      if (!activeRound || activeRound.type !== 'SLOTMACHINE') return null;
      const settings = (activeRound as any).slotmachine as { maxSpins: number; allowedPlayerIds: number[] };
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
        roundId: activeRound.id,
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

  const [ledger, predictions, roulette, interactive, myRequests, slotBlock, slotSeries, pakBlock, pakMine, pakSixes, pakRoster, slotTurn, photoBlock, pubInteractive] = await Promise.all([
    pool.query('SELECT id,amount,transaction_type,description,created_at,attributed_round_id,prediction_id,roulette_game_id,quiz_question_id FROM ledger_entries WHERE game_night_id=$1 AND player_id=$2 ORDER BY created_at DESC,id DESC LIMIT 12', [gameId, playerId]),
    pool.query(
      `SELECT p.id,p.display_number,p.question,p.status,p.probability_yes,p.yes_odds,p.no_odds,p.prediction_time_seconds,p.minimum_stake,p.maximum_stake,p.opened_at,p.closes_at,p.result,p.round_id,r.sort_order AS round_number,
              b.id AS own_bet_id,b.side AS own_bet_side,b.stake AS own_bet_stake,b.odds_snapshot AS own_bet_odds,b.potential_return AS own_bet_return,b.status AS own_bet_status
       FROM predictions p LEFT JOIN rounds r ON r.id=p.round_id LEFT JOIN bets b ON b.prediction_id=p.id AND b.player_id=$2
       WHERE p.game_night_id=$1 AND p.status NOT IN ('DRAFT','SCHEDULED')
       ORDER BY CASE p.status WHEN 'OPEN' THEN 0 WHEN 'LOCKED' THEN 1 WHEN 'RESULT' THEN 2 ELSE 3 END,p.updated_at DESC,p.id DESC LIMIT 30`, [gameId, playerId],
    ),
    pool.query(
      `SELECT rg.id,rg.status,rg.result_number,rg.spun_at,rg.round_id,rb.title AS round_title,
              COALESCE(json_agg(json_build_object('id',b.id,'bet_type',b.bet_type,'selection',b.selection,'stake',b.stake,'payout_multiplier',b.payout_multiplier,'potential_return',b.potential_return,'status',b.status) ORDER BY b.id)
                FILTER (WHERE b.id IS NOT NULL),'[]') AS own_bets
       FROM roulette_games rg LEFT JOIN rounds rb ON rb.id=rg.round_id LEFT JOIN roulette_bets b ON b.roulette_game_id=rg.id AND b.player_id=$2
       WHERE rg.id=(SELECT rg2.id FROM roulette_games rg2 WHERE rg2.game_night_id=$1 AND rg2.round_id=(SELECT current_round_id FROM game_nights WHERE id=$1) ORDER BY rg2.id DESC LIMIT 1)
       GROUP BY rg.id,rb.title`, [gameId, playerId],
    ),
    // The question the round's own cursor is on, and only while that round is active.
    // The phone never names the question; the server decides which one is live.
    pool.query(
      `SELECT q.id,q.round_id,q.sort_order,q.prompt,q.body,q.points,q.time_limit_seconds,q.context_media_key,
              st.status,st.closed_at,a.option_id AS my_option_id
       FROM game_nights g
       JOIN rounds r ON r.id=g.current_round_id AND r.status='ACTIVE' AND r.type='LIVE_QUIZ'
       JOIN round_runtime rt ON rt.round_id=r.id
       JOIN live_quiz_questions q ON q.id=rt.current_quiz_question_id
       JOIN live_quiz_question_state st ON st.question_id=q.id
       LEFT JOIN quiz_answers a ON a.question_id=q.id AND a.player_id=$2
       WHERE g.id=$1`, [gameId, playerId],
    ),
    pool.query(
      'SELECT id,question,status,reason,created_at FROM prediction_requests WHERE game_night_id=$1 AND player_id=$2 ORDER BY created_at DESC,id DESC',
      [gameId, playerId],
    ),
    // The slotmachine only reaches a phone while its block is the live one and its round
    // is active — the same gate the live question uses. That is what makes the controls
    // appear and disappear with the block instead of living on a page of their own.
    pool.query(
      `SELECT r.id,r.id AS round_id,r.title,r.instructions,
              COALESCE(sm.max_spins,10)::int AS max_spins,
              EXISTS(SELECT 1 FROM slotmachine_round_participants sp WHERE sp.round_id=r.id) AS has_allowlist,
              EXISTS(SELECT 1 FROM slotmachine_round_participants sp WHERE sp.round_id=r.id AND sp.player_id=$2) AS is_allowed,
              COALESCE(sc.total_weight,0)::int AS total_weight,
              COALESCE((SELECT SUM(o.weight) FROM slot_outcome_types o WHERE o.game_night_id=g.id),0)::int AS allocated_weight,
              COALESCE((SELECT COUNT(*) FROM slot_reel_symbols s WHERE s.game_night_id=g.id),0)::int AS symbol_count
       FROM game_nights g
       JOIN rounds r ON r.id=g.current_round_id AND r.status='ACTIVE' AND r.type='SLOTMACHINE'
       LEFT JOIN slotmachine_rounds sm ON sm.round_id=r.id
       LEFT JOIN slot_configs sc ON sc.game_night_id=g.id
       WHERE g.id=$1`, [gameId, playerId],
    ),
    pool.query(
      `SELECT sr.id,sr.round_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.total_stake,sr.status,
              ss.id AS spin_id,ss.spin_number,ss.outcome_type,
              ss.payout_multiplier,ss.payout,ss.status AS spin_status,ss.spun_at
       FROM slot_series sr
       LEFT JOIN LATERAL (
         SELECT * FROM slot_spins WHERE slot_series_id=sr.id ORDER BY spin_number DESC LIMIT 1
       ) ss ON TRUE
       WHERE sr.game_night_id=$1 AND sr.player_id=$2
         AND sr.round_id=(SELECT current_round_id FROM game_nights WHERE id=$1)
       ORDER BY CASE sr.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,sr.id DESC LIMIT 1`, [gameId, playerId],
    ),
    // Like the live question and the slotmachine, Pak een Zes only reaches a phone while
    // its block is the live one and its round is active — that is what makes the
    // controls appear and disappear with the block rather than living on a page.
    pool.query(
      `SELECT r.id,r.id AS round_id,r.title,r.instructions,r.default_points,
              pz.id AS pak_game_id,pz.status,pz.turn_index,
              COALESCE(pz.points_per_correct, r.default_points) AS points_per_correct
       FROM game_nights g
       JOIN rounds r ON r.id=g.current_round_id AND r.status='ACTIVE' AND r.type='PAK_EEN_ZES'
       LEFT JOIN LATERAL (
         SELECT id,status,turn_index,points_per_correct FROM pak_een_zes_games
         WHERE game_night_id=g.id AND round_id=r.id ORDER BY id DESC LIMIT 1
       ) pz ON TRUE
       WHERE g.id=$1`, [gameId],
    ),
    // The player's own four picks, in slot order. Duplicates survive because the rows
    // are per slot, so "Daan, Twan, Daan, Bas" comes back as four picks.
    pool.query(
      `SELECT pr.slot,pr.predicted_player_id
       FROM pak_een_zes_predictions pr
       JOIN pak_een_zes_games pz ON pz.id=pr.pak_een_zes_game_id
       WHERE pz.game_night_id=$1 AND pr.player_id=$2
         AND pz.round_id=(SELECT current_round_id FROM game_nights WHERE id=$1)
       ORDER BY pr.slot`, [gameId, playerId],
    ),
    // Who actually drew a six, so this player's own score can be shown afterwards.
    pool.query(
      `SELECT d.player_id
       FROM pak_een_zes_draws d
       JOIN pak_een_zes_games pz ON pz.id=d.pak_een_zes_game_id
       WHERE pz.game_night_id=$1 AND d.is_six
         AND pz.round_id=(SELECT current_round_id FROM game_nights WHERE id=$1)
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
           WHERE game_night_id=$1 AND round_id=(SELECT current_round_id FROM game_nights WHERE id=$1)
           ORDER BY id DESC LIMIT 1
         )
       WHERE pl.game_night_id=$1 AND pl.active=TRUE
       ORDER BY pl.display_name,pl.id`, [gameId],
    ),
    // The turn, resolved by the same function the spin endpoint enforces, so the button
    // the phone enables and the turn the server allows cannot disagree.
    pool.query('SELECT current_round_id FROM game_nights WHERE id=$1', [gameId])
      .then(r => {
        const current = Number(r.rows[0]?.current_round_id || 0);
        return current ? loadSlotTurn(pool, gameId, current) : null;
      }),
    // Like the other games, a Fotoronde only reaches a phone while its block is live and
    // its round is active. The team comes from the round's groups, never from the phone.
    pool.query(
      `SELECT r.id,r.id AS round_id,r.title,r.instructions,fr.id AS photo_round_id,fr.status
       FROM game_nights g
       JOIN rounds r ON r.id=g.current_round_id AND r.status='ACTIVE' AND r.type='FOTORONDE'
       LEFT JOIN photo_rounds fr ON fr.round_id=r.id AND fr.game_night_id=g.id
       WHERE g.id=$1`, [gameId],
    ),
    // The pubquiz question the round's cursor is on, and only while that round is active.
    // The phone never names the question; the server decides which one is live, and a
    // question held back from the run reaches nobody.
    pool.query(
      `SELECT q.id,q.round_id,q.sort_order,q.question,q.body,q.points,q.media_key,
              q.time_limit_seconds,st.status,st.closed_at,a.option_id AS my_option_id
       FROM game_nights g
       JOIN rounds r ON r.id=g.current_round_id AND r.status='ACTIVE' AND r.type='PUBQUIZ'
       JOIN round_runtime rt ON rt.round_id=r.id
       JOIN pubquiz_questions q ON q.id=rt.current_pubquiz_question_id AND q.hidden=FALSE
       JOIN pubquiz_question_state st ON st.question_id=q.id
       LEFT JOIN pubquiz_answers a ON a.question_id=q.id AND a.player_id=$2
       WHERE g.id=$1`, [gameId, playerId],
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
    result_number: rouletteRow.status === 'SPINNING' || rouletteRow.result_number == null ? null : Number(rouletteRow.result_number), own_bets: rouletteRow.own_bets || [],
  } : null;
  // The quiz question this player's phone should be showing, built by the player DTO so
  // the option texts travel but correctness does not until the reveal. `interactive`
  // holds at most one row: the question the round's cursor is on.
  const quizRow = interactive.rows[0];
  const quizQuestion = quizRow
    ? await (async () => {
      const options = await pool.query(
        'SELECT id,question_id,sort_order,text,is_correct FROM live_quiz_question_options WHERE question_id=$1 ORDER BY sort_order,id',
        [Number(quizRow.id)],
      );
      return {
        ...playerQuizQuestion(quizRow, options.rows, {
          optionId: quizRow.my_option_id == null ? null : Number(quizRow.my_option_id),
        }),
        roundId: Number(quizRow.round_id),
      };
    })()
    : null;

  // Built by the player DTO, so the option texts travel but the answer key does not until
  // the reveal — at which point this player also learns whether they were right and what
  // it paid them.
  const pubRow = pubInteractive.rows[0];
  const pubquizQuestion = pubRow
    ? await (async () => {
      const options = await pool.query(
        'SELECT id,question_id,sort_order,text,is_correct FROM pubquiz_question_options WHERE question_id=$1 ORDER BY sort_order,id',
        [Number(pubRow.id)],
      );
      return playerPubquizQuestion(pubRow, options.rows, {
        optionId: pubRow.my_option_id == null ? null : Number(pubRow.my_option_id),
      });
    })()
    : null;

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
    // An empty allowlist means everyone plays, which is the usual case and the reason
    // the query asks whether a list exists at all rather than counting it here.
    const allowed = !slotBlockRow.has_allowlist || Boolean(slotBlockRow.is_allowed);
    const series = slotSeriesRow && Number(slotSeriesRow.round_id) === Number(slotBlockRow.round_id) ? {
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
      roundId: Number(slotBlockRow.round_id),
      title: slotBlockRow.title || 'Slotmachine',
      instructions: slotBlockRow.instructions || '',
      maxSpins: Number(slotBlockRow.max_spins),
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
      roundId: Number(pakRow.round_id),
      title: pakRow.title || 'Pak een Zes',
      instructions: pakRow.instructions || '',
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
    // The subject list is the round's own authored rows, so the phone is asked for
    // exactly what the Admin wrote and nothing is derived from a payload.
    const subjectRows = await pool.query(
      'SELECT id,round_id,sort_order,subject_key,label,points,reference_media_key FROM fotoronde_subjects WHERE round_id=$1 ORDER BY sort_order,id',
      [Number(photoRow.round_id)],
    );
    const subjects = subjectRows.rows.map(publicSubject);
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
      roundId: Number(photoRow.round_id),
      title: photoRow.title || 'Fotoronde',
      instructions: photoRow.instructions || '',
      status,
      open: status === 'OPEN',
      // Null when this player is in no team: they are told so rather than shown an
      // upload button that the server would refuse.
      team: team ? { groupId: team.groupId, name: team.name } : null,
      subjects: subjects.map((subject: any) => {
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
    quizQuestion,
    pubquizQuestion,
    slotmachine,
    pakEenZes,
    photoRound,
    actionable: normalizedPredictions.some((p: any) => p.status === 'OPEN') || currentRoulette?.status === 'OPEN' || quizQuestion?.status === 'OPEN'
      || pubquizQuestion?.status === 'OPEN'
      || Boolean(slotmachine?.allowed && slotmachine.configValid)
      || Boolean(pakEenZes && ['PREDICTING', 'DRAWING'].includes(pakEenZes.status))
      || Boolean(photoRound?.open && photoRound.team),
    recentLedger: ledger.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
  };
}

function eventTimestamp(value: unknown) {
  return value ? new Date(String(value)).getTime() : 0;
}

export type ScreenOverride = {
  mode: string;
  roundId: number | null;
  quizQuestionId: number | null;
  slideId: number | null;
  pubquizQuestionId: number | null;
  predictionId: number | null;
};

/**
 * The projector snapshot.
 *
 * `override` builds the snapshot for a screen state that is not live — the Admin's preview
 * of what NEXT will show. It goes through this same function on purpose: a preview built
 * by a second code path is a preview that can disagree with the projector, which is the
 * whole failure the LIVE/NEXT pair exists to remove. Same query, same DTOs, same
 * withholding; only the pointers differ.
 */
export async function getScreenState(gameId: number, override?: ScreenOverride) {
  // Timer reconciliation is owned by getGameVersion, which every client polls before
  // it ever asks for a snapshot. Repeating the due-check here cost an extra query on
  // every snapshot for no new information. If a timer falls due while nobody is
  // polling, the next version poll reconciles it and bumps the version, which pulls a
  // fresh snapshot — so this self-heals within one poll interval.
  const pool = database().pool;
  const gameResult = await pool.query('SELECT g.*,s.mode,s.round_id AS screen_round_id,s.prediction_id,s.payload FROM game_nights g LEFT JOIN screen_state s ON s.game_night_id=g.id WHERE g.id=$1', [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');
  const screenMode = override ? override.mode : (game.mode || game.current_screen_mode || 'DASHBOARD');
  // Typed pointers straight from the row. A scene that needs a round gets one; a scene
  // that needs an item within it gets that too, and nothing is parsed out of JSON.
  const screenRoundId = override ? override.roundId : (Number(game.screen_round_id || 0) || null);
  const quizQuestionId = screenMode === 'QUIZ_QUESTION'
    ? (override ? override.quizQuestionId : (Number(game.quiz_question_id || 0) || null))
    : null;
  const slideId = screenMode === 'SLIDE'
    ? (override ? override.slideId : (Number(game.slide_id || 0) || null))
    : null;
  const pubquizQuestionId = screenMode === 'PUBQUIZ_QUESTION'
    ? (override ? override.pubquizQuestionId : (Number(game.pubquiz_question_id || 0) || null))
    : null;
  if (override) game.prediction_id = override.predictionId;
  const gameRoundId = ['ROULETTE','SLOTMACHINE','PAK_EEN_ZES','FOTORONDE'].includes(screenMode) ? screenRoundId : null;

  const [round, quizRow, prediction, players, ledgerEvents, predictionEvents, rouletteEvents, ticker, totals, roulette, recentResults, slot, slotSpins, pakEenZesGame, pakPredictionCount, screenSlotTurn, screenPhotoRound, pubRow, pubOptions, pubAnswers] = await Promise.all([
    pool.query(
      `SELECT id,game_night_id,sort_order,title,description,type,status,instructions,default_points
       FROM rounds WHERE id=COALESCE($1::bigint,$2::bigint) AND game_night_id=$3`,
      [screenRoundId, game.current_round_id, gameId],
    ),
    // The question and its options, or the slide — whichever the scene names. Both come
    // back raw here and are shaped by the projector DTO below, which is where the
    // withholding happens.
    quizQuestionId ? pool.query(
      `SELECT q.id,q.round_id,q.sort_order,q.prompt,q.body,q.points,q.time_limit_seconds,q.context_media_key,
              st.status,st.context_photo_shown,
              COUNT(ap.id)::int AS answer_count
       FROM live_quiz_questions q
       JOIN live_quiz_question_state st ON st.question_id=q.id
       LEFT JOIN quiz_answers a ON a.question_id=q.id
       LEFT JOIN players ap ON ap.id=a.player_id AND ap.active=TRUE
       WHERE q.id=$1 AND q.game_night_id=$2
       GROUP BY q.id,st.status,st.context_photo_shown`, [quizQuestionId, gameId],
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
      `SELECT l.id,p.display_name,l.amount,l.transaction_type,l.description,r.sort_order AS round_number,pr.display_number AS prediction_number,l.roulette_game_id
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
        `SELECT rg.id,rg.round_id,rg.status,rg.result_number,rg.spun_at,rg.run_number,
                rg.total_staked,rg.total_payout,rg.participant_count,
                (SELECT COUNT(*)::int FROM players pl WHERE pl.game_night_id=$1 AND pl.active=TRUE) AS eligible_players,
                COALESCE(json_agg(json_build_object('id',rb.id,'displayName',p.display_name,'color',p.public_color,'betType',rb.bet_type,'selection',rb.selection,'stake',rb.stake) ORDER BY rb.id)
                  FILTER (WHERE rb.id IS NOT NULL),'[]') AS public_bets
         FROM roulette_games rg LEFT JOIN roulette_bets rb ON rb.roulette_game_id=rg.id LEFT JOIN players p ON p.id=rb.player_id
         WHERE rg.id=(SELECT id FROM roulette_games WHERE game_night_id=$1 AND round_id=$2 ORDER BY run_number DESC,id DESC LIMIT 1) AND rg.game_night_id=$1
         GROUP BY rg.id`, [gameId, gameRoundId])
      : Promise.resolve({ rows: [] } as any),
    pool.query(
      `SELECT id,display_number,question,result,yes_odds,no_odds,settled_at
       FROM predictions WHERE game_night_id=$1 AND status='SETTLED' AND result IN ('YES','NO')
       ORDER BY settled_at DESC NULLS LAST,id DESC LIMIT 6`, [gameId],
    ),
    // The projector is the only surface that renders reels, so it is the only one that
    // receives the reel strips.
    screenMode === 'SLOTMACHINE' ? loadSlotConfig(pool, gameId) : Promise.resolve(null),
    screenMode === 'SLOTMACHINE' && gameRoundId
      ? pool.query(
        `SELECT ss.id,ss.spin_number,ss.outcome_type,ss.grid,ss.win_cells,
                ss.stake,ss.payout_multiplier,ss.payout,ss.status,ss.spun_at,
                p.display_name,p.public_color,
                sr.id AS series_id,sr.stake_per_spin,sr.total_spins,sr.spins_remaining,sr.status AS series_status
         FROM slot_spins ss JOIN players p ON p.id=ss.player_id JOIN slot_series sr ON sr.id=ss.slot_series_id
         WHERE ss.round_id=$1 AND ss.game_night_id=$2
         ORDER BY ss.spun_at DESC,ss.id DESC LIMIT 6`, [gameRoundId, gameId])
      : Promise.resolve({ rows: [] } as any),
    // The projector is the only surface that shows the deck and the reveal.
    screenMode === 'PAK_EEN_ZES' && gameRoundId
      ? loadPakEenZesGame(pool, gameId, gameRoundId)
      : Promise.resolve(null),
    screenMode === 'PAK_EEN_ZES'
      ? pool.query('SELECT COUNT(*)::int AS n FROM players WHERE game_night_id=$1 AND active=TRUE', [gameId])
      : Promise.resolve({ rows: [{ n: 0 }] } as any),
    screenMode === 'SLOTMACHINE' && gameRoundId
      ? loadSlotTurn(pool, gameId, gameRoundId)
      : Promise.resolve(null),
    screenMode === 'FOTORONDE' && gameRoundId
      ? pool.query(
        'SELECT subject_key,label FROM fotoronde_subjects WHERE round_id=$1 ORDER BY sort_order,id',
        [gameRoundId],
      ).then(r => loadPhotoRound(
        pool, gameId, gameRoundId,
        r.rows.map((x: any) => ({ key: x.subject_key, label: x.label })),
      ))
      : Promise.resolve(null),
    // The pubquiz scene: the question, its options, and — only once revealed — how the
    // room answered. Fetched only when that scene is up, like every other one here.
    pubquizQuestionId
      ? pool.query(
        `SELECT q.id,q.round_id,q.sort_order,q.question,q.body,q.points,q.media_key,
                q.time_limit_seconds,q.hidden,st.status,st.closed_at,st.revealed_at,
                COUNT(ap.id)::int AS answer_count
         FROM pubquiz_questions q
         JOIN pubquiz_question_state st ON st.question_id=q.id
         LEFT JOIN pubquiz_answers a ON a.question_id=q.id
         LEFT JOIN players ap ON ap.id=a.player_id AND ap.active=TRUE
         WHERE q.id=$1 AND q.game_night_id=$2
         GROUP BY q.id,st.status,st.closed_at,st.revealed_at`,
        [pubquizQuestionId, gameId],
      )
      : Promise.resolve({ rows: [] } as any),
    pubquizQuestionId
      ? pool.query(
        'SELECT id,question_id,sort_order,text,is_correct FROM pubquiz_question_options WHERE question_id=$1 ORDER BY sort_order,id',
        [pubquizQuestionId],
      )
      : Promise.resolve({ rows: [] } as any),
    pubquizQuestionId
      ? pool.query(
        `SELECT a.option_id FROM pubquiz_answers a
         JOIN players pl ON pl.id=a.player_id AND pl.active=TRUE
         WHERE a.question_id=$1`,
        [pubquizQuestionId],
      )
      : Promise.resolve({ rows: [] } as any),
  ]);

  // The two pieces the scene DTOs still need, fetched only for the scene that is up.
  const [quizOptionRows, slideRows] = await Promise.all([
    quizQuestionId
      ? pool.query(
        'SELECT id,question_id,sort_order,text,is_correct FROM live_quiz_question_options WHERE question_id=$1 ORDER BY sort_order,id',
        [quizQuestionId],
      )
      : Promise.resolve({ rows: [] } as any),
    slideId
      ? pool.query(
        `SELECT s.id,s.round_id,s.sort_order,s.title,s.body,s.media_key,s.media_kind,s.media_name,
                s.reveal_text,s.hide_title_until_reveal,st.revealed_at
         FROM presentation_slides s
         LEFT JOIN presentation_slide_state st ON st.slide_id=s.id
         WHERE s.id=$1 AND s.game_night_id=$2`,
        [slideId, gameId],
      )
      : Promise.resolve({ rows: [] } as any),
  ]);
  const quizOptions = quizOptionRows.rows;
  const slideRow = slideRows.rows[0] ?? null;

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
    round: publicRound(round.rows[0]),
    // The projector's player list is already active-only, so its length is the same
    // eligible count the Admin bar uses.
    //
    // Both scenes are built by an explicit DTO rather than by stripping a row: the
    // question's correct options and its context photo key, and the slide's reveal line
    // and hidden title, are simply not put on the wire until the host reveals them, so a
    // viewer with the projector URL has nothing to read early.
    quizQuestion: quizRow.rows[0] ? screenQuizQuestion(quizRow.rows[0], quizOptions, players.rows.length) : null,
    slide: slideRow ? screenSlide(slideRow) : null,
    // Built by its own explicit DTO, like the quiz scene: the answer key and the per-option
    // tally are simply not on the wire before the reveal, so there is nothing for a viewer
    // with the projector URL to read early.
    pubquizQuestion: pubRow.rows[0]
      ? screenPubquizQuestion(
        pubRow.rows[0],
        pubOptions.rows,
        pubAnswers.rows.map((a: any) => ({ optionId: Number(a.option_id) })),
        players.rows.length,
      )
      : null,
    prediction: pred ? { id: Number(pred.id), number: Number(pred.display_number), question: pred.question, status: pred.status, publicStatus: publicPredictionStatus(pred.status, pred.result), probabilityYes: Number(pred.probability_yes), yesOdds: Number(pred.yes_odds), noOdds: Number(pred.no_odds), result: pred.result, openedAt: pred.opened_at, closesAt: pred.closes_at } : null,
    leaderboard: players.rows.map((p: any) => ({
      id: Number(p.id), display_name: p.display_name, public_color: p.public_color,
      current_balance: Number(p.current_balance) + Number(p.prediction_locked) + Number(p.roulette_locked) + Number(p.slot_locked),
      available_balance: Number(p.current_balance), starting_balance: Number(p.starting_balance), series: series.get(Number(p.id)) || [],
    })),
    ticker: ticker.rows.map((t: any) => ({ ...t, id: Number(t.id), amount: Number(t.amount) })),
    marketsOpen: Number(total.markets_open),
    totalCoinsInPlay: Number(total.wallets) + Number(total.prediction_stakes) + Number(total.roulette_stakes) + Number(total.slot_stakes),
    roulette: screenRoulette(rouletteRow),
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
        roundId: gameRoundId,
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
      roundId: gameRoundId,
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
        roundId: gameRoundId,
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
      `SELECT l.id,l.created_at,l.amount,l.description,l.transaction_type,l.attributed_round_id,l.prediction_id,l.roulette_game_id,l.round_group_id,l.quiz_question_id,
              p.display_name,r.sort_order AS round_number,r.title AS round_title,pr.display_number AS prediction_number,g.name AS group_name,q.prompt AS question_prompt
       FROM ledger_entries l JOIN players p ON p.id=l.player_id LEFT JOIN rounds r ON r.id=l.attributed_round_id
       LEFT JOIN predictions pr ON pr.id=l.prediction_id LEFT JOIN round_groups g ON g.id=l.round_group_id LEFT JOIN live_quiz_questions q ON q.id=l.quiz_question_id
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
    entries: entries.rows.map((r: any) => ({ ...r, id: Number(r.id), amount: Number(r.amount), attributed_round_id: r.attributed_round_id ? Number(r.attributed_round_id) : null, prediction_id: r.prediction_id ? Number(r.prediction_id) : null, roulette_game_id: r.roulette_game_id ? Number(r.roulette_game_id) : null, round_group_id: r.round_group_id ? Number(r.round_group_id) : null, quiz_question_id: r.quiz_question_id ? Number(r.quiz_question_id) : null })),
    summary: summary.rows.map((r: any) => ({ ...r, id: Number(r.id), earned: Number(r.earned), lost: Number(r.lost), net: Number(r.net) })),
  };
}
