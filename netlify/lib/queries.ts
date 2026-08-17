import { database } from './db';
import { HttpError } from './http';

export async function getGameVersion(gameId: number) {
  const rows = await database().sql<{ game_state_version: string }>`SELECT game_state_version FROM game_nights WHERE id = ${gameId}`;
  if (!rows[0]) throw new HttpError(404, 'Game not found');
  return Number(rows[0].game_state_version);
}

export async function getScreenState(gameId: number) {
  const pool = database().pool;
  const gameResult = await pool.query(
    `SELECT g.id, g.name, g.game_state_version, g.current_screen_mode,
            r.id AS round_id, r.round_number, r.title AS round_title, r.status AS round_status,
            s.mode, s.payload, s.updated_at,
            p.id AS prediction_id, p.display_number, p.question, p.status AS prediction_status,
            p.crowd_yes_probability, p.crowd_no_probability, p.yes_odds, p.no_odds, p.result
       FROM game_nights g
       LEFT JOIN rounds r ON r.id = g.current_round_id
       LEFT JOIN screen_state s ON s.game_night_id = g.id
       LEFT JOIN predictions p ON p.id = s.prediction_id
      WHERE g.id = $1`, [gameId]
  );
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');

  const leaderboardResult = await pool.query(
    `SELECT p.id, p.display_name, p.public_color, w.current_balance,
            DENSE_RANK() OVER (ORDER BY w.current_balance DESC, p.display_name ASC) AS rank
       FROM players p JOIN wallets w ON w.player_id = p.id
      WHERE p.game_night_id = $1 AND p.active = TRUE
      ORDER BY w.current_balance DESC, p.display_name ASC`, [gameId]
  );

  const tickerResult = await pool.query(
    `SELECT l.id, p.display_name, l.amount, l.transaction_type, l.description,
            r.round_number, pr.display_number AS prediction_number, l.created_at
       FROM ledger_entries l
       JOIN players p ON p.id = l.player_id
       LEFT JOIN rounds r ON r.id = l.attributed_round_id
       LEFT JOIN predictions pr ON pr.id = l.prediction_id
      WHERE l.game_night_id = $1 AND p.active=TRUE
      ORDER BY l.created_at DESC, l.id DESC LIMIT 16`, [gameId]
  );

  const totalsResult = await pool.query(
    `SELECT COALESCE((SELECT SUM(w.current_balance) FROM wallets w JOIN players pl ON pl.id=w.player_id WHERE w.game_night_id = $1 AND pl.active=TRUE),0)::int AS wallet_total,
            COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions p ON p.id=b.prediction_id
                      WHERE p.game_night_id=$1 AND b.status='ACTIVE'),0)::int AS locked_stakes,
            COALESCE((SELECT COUNT(*) FROM predictions WHERE game_night_id=$1 AND status='BETTING'),0)::int AS markets_open`, [gameId]
  );

  const ledgerChronology = await pool.query(
    `SELECT l.player_id, p.display_name, p.public_color, l.amount, l.created_at, l.id
       FROM ledger_entries l JOIN players p ON p.id=l.player_id
      WHERE l.game_night_id=$1 AND p.active=TRUE
      ORDER BY l.created_at ASC, l.id ASC`, [gameId]
  );
  const series = new Map<number, { playerId:number; name:string; color:string; balance:number; points:{x:number;y:number;at:string}[] }>();
  let x = 0;
  for (const row of ledgerChronology.rows) {
    x += 1;
    const playerId = Number(row.player_id);
    const current = series.get(playerId) || { playerId, name: row.display_name, color: row.public_color, balance: 0, points: [] as {x:number;y:number;at:string}[] };
    current.balance += Number(row.amount);
    current.points.push({ x, y: current.balance, at: row.created_at });
    series.set(playerId, current);
  }

  const total = totalsResult.rows[0];
  return {
    version: Number(game.game_state_version),
    game: { id: Number(game.id), name: game.name },
    mode: game.mode || game.current_screen_mode || 'DASHBOARD',
    round: game.round_id ? { id: Number(game.round_id), number: game.round_number, title: game.round_title, status: game.round_status } : null,
    prediction: game.prediction_id ? {
      id: Number(game.prediction_id), number: game.display_number, question: game.question, status: game.prediction_status,
      crowdYes: game.crowd_yes_probability === null ? null : Number(game.crowd_yes_probability),
      crowdNo: game.crowd_no_probability === null ? null : Number(game.crowd_no_probability),
      yesOdds: game.yes_odds === null ? null : Number(game.yes_odds),
      noOdds: game.no_odds === null ? null : Number(game.no_odds), result: game.result,
    } : null,
    leaderboard: leaderboardResult.rows.map((r:any) => ({ ...r, id: Number(r.id), current_balance: Number(r.current_balance), rank: Number(r.rank) })),
    ticker: tickerResult.rows.map((r:any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
    marketsOpen: Number(total.markets_open),
    totalCoinsInPlay: Number(total.wallet_total) + Number(total.locked_stakes),
    graphSeries: [...series.values()].map(({ balance: _balance, ...rest }) => rest),
  };
}

export async function getPlayerState(gameId: number, playerId: number) {
  const pool = database().pool;
  const playerResult = await pool.query(
    `WITH ranked AS (
       SELECT p.id, p.display_name, p.public_color, p.team_id, w.current_balance,
              DENSE_RANK() OVER (ORDER BY w.current_balance DESC, p.display_name ASC) AS rank
       FROM players p JOIN wallets w ON w.player_id=p.id
       WHERE p.game_night_id=$1 AND p.active=TRUE
     )
     SELECT r.*, t.name AS team_name FROM ranked r LEFT JOIN teams t ON t.id=r.team_id WHERE r.id=$2`, [gameId, playerId]
  );
  const player = playerResult.rows[0];
  if (!player) throw new HttpError(404, 'Player not found');
  const ledger = await pool.query(
    `SELECT id, amount, transaction_type, description, created_at,
            attributed_round_id, prediction_id
       FROM ledger_entries WHERE game_night_id=$1 AND player_id=$2
       ORDER BY created_at DESC, id DESC LIMIT 25`, [gameId, playerId]
  );
  const predictionResult = await pool.query(
    `SELECT id, display_number, question, status, crowd_yes_probability, crowd_no_probability, yes_odds, no_odds, result
       FROM predictions
      WHERE game_night_id=$1
        AND visible_to_players=TRUE
      ORDER BY id DESC LIMIT 1`, [gameId]
  );
  const prediction = predictionResult.rows[0] || null;
  let ownVote = null;
  let ownBet = null;
  if (prediction) {
    const vote = await pool.query(`SELECT yes_probability, updated_at FROM prediction_votes WHERE prediction_id=$1 AND player_id=$2`, [prediction.id, playerId]);
    ownVote = vote.rows[0] || null;
    const bet = await pool.query(`SELECT id, side, stake, odds_snapshot, potential_return, status FROM bets WHERE prediction_id=$1 AND player_id=$2`, [prediction.id, playerId]);
    ownBet = bet.rows[0] ? { ...bet.rows[0], id: Number(bet.rows[0].id), stake: Number(bet.rows[0].stake), odds_snapshot: Number(bet.rows[0].odds_snapshot), potential_return: Number(bet.rows[0].potential_return) } : null;
  }
  return {
    player: { id: Number(player.id), name: player.display_name, color: player.public_color, team: player.team_name, balance: Number(player.current_balance), rank: Number(player.rank) },
    recentLedger: ledger.rows.map((r:any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
    prediction: prediction ? {
      id: Number(prediction.id), number: prediction.display_number, question: prediction.question, status: prediction.status,
      crowdYes: prediction.crowd_yes_probability === null ? null : Number(prediction.crowd_yes_probability),
      crowdNo: prediction.crowd_no_probability === null ? null : Number(prediction.crowd_no_probability),
      yesOdds: prediction.yes_odds === null ? null : Number(prediction.yes_odds),
      noOdds: prediction.no_odds === null ? null : Number(prediction.no_odds), result: prediction.result,
      ownVote: ownVote ? Number(ownVote.yes_probability) : null, ownBet,
    } : null,
  };
}

export async function getAdminState(gameId: number) {
  const pool = database().pool;
  const gameResult = await pool.query(`SELECT * FROM game_nights WHERE id=$1`, [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');

  const rounds = await pool.query(`SELECT * FROM rounds WHERE game_night_id=$1 ORDER BY round_number ASC`, [gameId]);
  const players = await pool.query(
    `SELECT p.id,p.display_name,p.public_color,p.admin_notes,p.active,t.name AS team_name,w.current_balance,
            DENSE_RANK() OVER (ORDER BY w.current_balance DESC,p.display_name ASC) AS rank
       FROM players p JOIN wallets w ON w.player_id=p.id LEFT JOIN teams t ON t.id=p.team_id
      WHERE p.game_night_id=$1 AND p.active=TRUE ORDER BY p.display_name`, [gameId]
  );
  const predictions = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM prediction_votes v WHERE v.prediction_id=p.id)::int AS vote_count,
            (SELECT COUNT(*) FROM bets b WHERE b.prediction_id=p.id)::int AS bet_count,
            (SELECT COALESCE(SUM(stake),0) FROM bets b WHERE b.prediction_id=p.id AND side='YES')::int AS yes_pool,
            (SELECT COALESCE(SUM(stake),0) FROM bets b WHERE b.prediction_id=p.id AND side='NO')::int AS no_pool,
            r.round_number, r.title AS round_title
       FROM predictions p
       LEFT JOIN rounds r ON r.id=p.round_id
      WHERE p.game_night_id=$1
      ORDER BY p.display_number ASC, p.id ASC`, [gameId]
  );
  const recent = await pool.query(
    `SELECT l.id,l.amount,l.description,l.transaction_type,l.created_at,p.display_name,r.round_number
       FROM ledger_entries l
       JOIN players p ON p.id=l.player_id
       LEFT JOIN rounds r ON r.id=l.attributed_round_id
      WHERE l.game_night_id=$1
      ORDER BY l.created_at DESC,l.id DESC LIMIT 30`, [gameId]
  );
  const screen = await pool.query(`SELECT * FROM screen_state WHERE game_night_id=$1`, [gameId]);
  const audit = await pool.query(`SELECT * FROM admin_audit_log WHERE game_night_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`, [gameId]);

  const normalizedPredictions = predictions.rows.map((p:any) => ({
    ...p,
    id: Number(p.id),
    round_id: p.round_id ? Number(p.round_id) : null,
    visible_to_players: Boolean(p.visible_to_players),
    crowd_yes_probability: p.crowd_yes_probability === null ? null : Number(p.crowd_yes_probability),
    crowd_no_probability: p.crowd_no_probability === null ? null : Number(p.crowd_no_probability),
    yes_odds: p.yes_odds === null ? null : Number(p.yes_odds),
    no_odds: p.no_odds === null ? null : Number(p.no_odds),
    vote_count: Number(p.vote_count),
    bet_count: Number(p.bet_count),
    yes_pool: Number(p.yes_pool),
    no_pool: Number(p.no_pool),
  }));

  return {
    version: Number(game.game_state_version),
    game: {
      ...game,
      id: Number(game.id),
      starting_balance: Number(game.starting_balance),
      current_round_id: game.current_round_id ? Number(game.current_round_id) : null,
      game_state_version: Number(game.game_state_version),
    },
    rounds: rounds.rows.map((r:any) => ({ ...r, id: Number(r.id), round_number: Number(r.round_number) })),
    players: players.rows.map((r:any) => ({ ...r, id: Number(r.id), current_balance: Number(r.current_balance), rank: Number(r.rank) })),
    predictions: normalizedPredictions,
    prediction: normalizedPredictions.find((p:any) => !['SETTLED','CANCELLED'].includes(p.status)) || null,
    visiblePrediction: normalizedPredictions.find((p:any) => p.visible_to_players) || null,
    recentTransactions: recent.rows.map((r:any) => ({ ...r, id: Number(r.id), amount: Number(r.amount) })),
    screen: screen.rows[0] || { mode: 'DASHBOARD' },
    audit: audit.rows.map((r:any) => ({ ...r, id: Number(r.id) })),
  };
}
