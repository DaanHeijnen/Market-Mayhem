import { database, withTransaction } from './db';
import { HttpError } from './http';
import { incrementGameVersion } from './game-state';

export async function syncExpiredPredictions(gameId: number, knownDue = false) {
  if (!knownDue) {
    const due = await database().pool.query(
      `SELECT 1 FROM predictions
       WHERE game_night_id=$1 AND status='OPEN' AND closes_at IS NOT NULL AND closes_at<=NOW()
       LIMIT 1`,
      [gameId],
    );
    if (!due.rows[0]) return false;
  }
  return withTransaction(async (client) => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');
    const expired = await client.query(
      `UPDATE predictions
       SET status='LOCKED',updated_at=NOW()
       WHERE game_night_id=$1 AND status='OPEN' AND closes_at IS NOT NULL AND closes_at <= NOW()
       RETURNING id`,
      [gameId],
    );
    if (!expired.rowCount) return false;
    const ids = expired.rows.map((r: any) => Number(r.id));
    await client.query(
      `UPDATE screen_state SET mode='PREDICTION_LOCKED',updated_at=NOW(),updated_by='timer'
       WHERE game_night_id=$1 AND prediction_id = ANY($2::bigint[])`,
      [gameId, ids],
    );
    await client.query(
      `UPDATE game_nights SET current_screen_mode='PREDICTION_LOCKED',updated_at=NOW()
       WHERE id=$1 AND EXISTS(SELECT 1 FROM screen_state WHERE game_night_id=$1 AND mode='PREDICTION_LOCKED')`,
      [gameId],
    );
    await incrementGameVersion(client, gameId);
    return true;
  });
}

export async function getGameVersion(gameId: number) {
  const result = await database().pool.query(
    `SELECT g.game_state_version,
            EXISTS(
              SELECT 1 FROM predictions p
              WHERE p.game_night_id=g.id AND p.status='OPEN' AND p.closes_at IS NOT NULL AND p.closes_at<=NOW()
            ) AS has_expired
     FROM game_nights g WHERE g.id=$1`,
    [gameId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'Game not found');
  if (!row.has_expired) return Number(row.game_state_version);
  await syncExpiredPredictions(gameId, true);
  const refreshed = await database().pool.query('SELECT game_state_version FROM game_nights WHERE id=$1', [gameId]);
  return Number(refreshed.rows[0].game_state_version);
}

function normalizeBlock(row: any) {
  return row ? { ...row, id: Number(row.id), round_id: Number(row.round_id), sort_order: Number(row.sort_order), payload: row.payload || {} } : null;
}
function normalizePrediction(p: any) {
  return {
    ...p,
    id: Number(p.id), round_id: p.round_id ? Number(p.round_id) : null, display_number: Number(p.display_number),
    yes_odds: Number(p.yes_odds), no_odds: Number(p.no_odds), bet_count: Number(p.bet_count || 0),
    participation_count: Number(p.participation_count || p.bet_count || 0),
  };
}

export async function getAdminState(gameId: number) {
  await syncExpiredPredictions(gameId);
  const pool = database().pool;
  const gameResult = await pool.query(`SELECT * FROM game_nights WHERE id=$1`, [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404, 'Game not found');

  const [rounds, blocks, players, predictions, recent, roulette] = await Promise.all([
    pool.query(`SELECT * FROM rounds WHERE game_night_id=$1 ORDER BY round_number,id`, [gameId]),
    pool.query(`SELECT * FROM round_blocks WHERE game_night_id=$1 ORDER BY round_id,sort_order,id`, [gameId]),
    pool.query(
      `WITH ranked AS (
         SELECT p.id,DENSE_RANK() OVER (ORDER BY w.current_balance DESC) AS rank
         FROM players p JOIN wallets w ON w.player_id=p.id
         WHERE p.game_night_id=$1 AND p.active=TRUE
       )
       SELECT p.id,p.display_name,p.public_color,p.active,p.created_at,w.current_balance,r.rank,
              EXISTS(SELECT 1 FROM player_sessions s WHERE s.player_id=p.id AND s.revoked_at IS NULL AND s.expires_at>NOW()) AS joined
       FROM players p JOIN wallets w ON w.player_id=p.id LEFT JOIN ranked r ON r.id=p.id
       WHERE p.game_night_id=$1 ORDER BY p.active DESC,p.display_name`, [gameId]),
    pool.query(
      `SELECT p.*,
              COUNT(b.id)::int AS bet_count,
              COUNT(b.id)::int AS participation_count,
              r.round_number,r.title AS round_title
       FROM predictions p
       LEFT JOIN rounds r ON r.id=p.round_id
       LEFT JOIN bets b ON b.prediction_id=p.id
       WHERE p.game_night_id=$1
       GROUP BY p.id,r.round_number,r.title
       ORDER BY p.display_number,p.id`, [gameId]),
    pool.query(
      `SELECT l.id,l.amount,l.description,l.transaction_type,l.created_at,p.display_name,
              r.round_number,pr.display_number AS prediction_number,rg.id AS roulette_game_id
       FROM ledger_entries l JOIN players p ON p.id=l.player_id
       LEFT JOIN rounds r ON r.id=l.attributed_round_id
       LEFT JOIN predictions pr ON pr.id=l.prediction_id
       LEFT JOIN roulette_games rg ON rg.id=l.roulette_game_id
       WHERE l.game_night_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 10`, [gameId]),
    pool.query(
      `SELECT rg.*,
              COUNT(rb.id) FILTER (WHERE rb.status='ACTIVE')::int AS bet_count,
              COALESCE(SUM(rb.stake) FILTER (WHERE rb.status='ACTIVE'),0)::int AS total_stake
       FROM roulette_games rg LEFT JOIN roulette_bets rb ON rb.roulette_game_id=rg.id
       WHERE rg.game_night_id=$1 AND rg.round_block_id=$2 AND rg.status IN ('DRAFT','OPEN','LOCKED','RESULT')
       GROUP BY rg.id ORDER BY rg.id DESC LIMIT 1`, [gameId, game.current_round_block_id]),
  ]);

  const normalizedBlocks = blocks.rows.map(normalizeBlock);
  const normalizedPredictions = predictions.rows.map(normalizePrediction);
  return {
    version: Number(game.game_state_version),
    game: {
      ...game, id: Number(game.id), starting_balance: Number(game.starting_balance),
      prediction_duration_seconds: Number(game.prediction_duration_seconds), minimum_prediction_stake: Number(game.minimum_prediction_stake),
      maximum_prediction_stake: Number(game.maximum_prediction_stake), maximum_wallet_percentage: game.maximum_wallet_percentage == null ? null : Number(game.maximum_wallet_percentage),
      current_round_id: game.current_round_id ? Number(game.current_round_id) : null,
      current_round_block_id: game.current_round_block_id ? Number(game.current_round_block_id) : null,
      game_state_version: Number(game.game_state_version),
    },
    rounds: rounds.rows.map((r:any) => ({ ...r,id:Number(r.id),round_number:Number(r.round_number),blocks: normalizedBlocks.filter((b:any)=>b.round_id===Number(r.id)) })),
    currentBlock: normalizedBlocks.find((b:any)=>b.id===Number(game.current_round_block_id)) || null,
    players: players.rows.map((p:any)=>({ ...p,id:Number(p.id),current_balance:Number(p.current_balance),rank:p.rank?Number(p.rank):null,active:Boolean(p.active),joined:Boolean(p.joined) })),
    predictions: normalizedPredictions,
    activePredictions: normalizedPredictions.filter((p:any)=>['OPEN','LOCKED','RESULT'].includes(p.status)),
    recentTransactions: recent.rows.map((r:any)=>({ ...r,id:Number(r.id),amount:Number(r.amount) })),
    activeRoulette: (()=>{const r=roulette.rows[0];return r?{...r,id:Number(r.id),round_id:r.round_id?Number(r.round_id):null,round_block_id:r.round_block_id?Number(r.round_block_id):null,result_number:r.result_number==null?null:Number(r.result_number),bet_count:Number(r.bet_count),total_stake:Number(r.total_stake)}:null})(),
  };
}

export async function getPlayerState(gameId: number, playerId: number) {
  await syncExpiredPredictions(gameId);
  const pool = database().pool;
  const playerResult = await pool.query(
    `WITH ranked AS (
       SELECT p.id,p.display_name,p.public_color,w.current_balance,g.game_state_version,
              g.minimum_prediction_stake,g.maximum_prediction_stake,g.maximum_wallet_percentage,
              DENSE_RANK() OVER (ORDER BY w.current_balance DESC) AS rank
       FROM players p JOIN wallets w ON w.player_id=p.id JOIN game_nights g ON g.id=p.game_night_id
       WHERE p.game_night_id=$1 AND p.active=TRUE
     ) SELECT * FROM ranked WHERE id=$2`, [gameId, playerId]);
  const player = playerResult.rows[0];
  if (!player) throw new HttpError(404, 'Player not found');

  const [ledger, predictions, roulette] = await Promise.all([
    pool.query(`SELECT id,amount,transaction_type,description,created_at,attributed_round_id,prediction_id,roulette_game_id FROM ledger_entries WHERE game_night_id=$1 AND player_id=$2 ORDER BY created_at DESC,id DESC LIMIT 10`, [gameId,playerId]),
    pool.query(
      `SELECT p.id,p.display_number,p.question,p.status,p.yes_odds,p.no_odds,p.opened_at,p.closes_at,p.result,p.round_id,r.round_number,
              b.id AS own_bet_id,b.side AS own_bet_side,b.stake AS own_bet_stake,b.odds_snapshot AS own_bet_odds,b.potential_return AS own_bet_return,b.status AS own_bet_status
       FROM predictions p LEFT JOIN rounds r ON r.id=p.round_id
       LEFT JOIN bets b ON b.prediction_id=p.id AND b.player_id=$2
       WHERE p.game_night_id=$1 AND (p.status IN ('OPEN','LOCKED','RESULT') OR b.id IS NOT NULL)
       ORDER BY CASE p.status WHEN 'OPEN' THEN 0 WHEN 'LOCKED' THEN 1 WHEN 'RESULT' THEN 2 ELSE 3 END,p.closes_at DESC NULLS LAST,p.id DESC`, [gameId,playerId]),
    pool.query(
      `SELECT rg.id,rg.status,rg.result_number,rg.round_id,rg.round_block_id,rb.title AS block_title,
              COALESCE(json_agg(json_build_object('id',b.id,'bet_type',b.bet_type,'selection',b.selection,'stake',b.stake,'potential_return',b.potential_return,'status',b.status)) FILTER (WHERE b.id IS NOT NULL),'[]') AS own_bets
       FROM roulette_games rg LEFT JOIN round_blocks rb ON rb.id=rg.round_block_id LEFT JOIN roulette_bets b ON b.roulette_game_id=rg.id AND b.player_id=$2
       WHERE rg.id=(
         SELECT rg2.id FROM roulette_games rg2
         WHERE rg2.game_night_id=$1 AND rg2.round_block_id=(SELECT current_round_block_id FROM game_nights WHERE id=$1)
         ORDER BY rg2.id DESC LIMIT 1
       )
       GROUP BY rg.id,rb.title`, [gameId,playerId]),
  ]);

  const normalizedPredictions = predictions.rows.map((p:any)=>({
    id:Number(p.id),number:Number(p.display_number),question:p.question,status:p.status,yesOdds:Number(p.yes_odds),noOdds:Number(p.no_odds),openedAt:p.opened_at,closesAt:p.closes_at,result:p.result,
    roundId:p.round_id?Number(p.round_id):null,roundNumber:p.round_number?Number(p.round_number):null,
    ownBet:p.own_bet_id?{id:Number(p.own_bet_id),side:p.own_bet_side,stake:Number(p.own_bet_stake),odds:Number(p.own_bet_odds),potentialReturn:Number(p.own_bet_return),status:p.own_bet_status}:null,
  }));
  const rouletteRow = roulette.rows[0];
  const currentRoulette = rouletteRow && rouletteRow.status !== 'DRAFT' ? {...rouletteRow,id:Number(rouletteRow.id),round_id:rouletteRow.round_id?Number(rouletteRow.round_id):null,round_block_id:rouletteRow.round_block_id?Number(rouletteRow.round_block_id):null,result_number:rouletteRow.result_number==null?null:Number(rouletteRow.result_number),own_bets:rouletteRow.own_bets||[]} : null;
  return {
    version:Number(player.game_state_version),
    player:{id:Number(player.id),name:player.display_name,color:player.public_color,balance:Number(player.current_balance),rank:Number(player.rank)},
    settings:{minimumStake:Number(player.minimum_prediction_stake),maximumStake:Number(player.maximum_prediction_stake),maximumWalletPercentage:player.maximum_wallet_percentage==null?null:Number(player.maximum_wallet_percentage)},
    predictions:normalizedPredictions,
    predictionAvailable:normalizedPredictions.some((p:any)=>p.status==='OPEN'),
    roulette:currentRoulette,
    rouletteAvailable:currentRoulette?.status==='OPEN',
    actionable:normalizedPredictions.some((p:any)=>p.status==='OPEN') || currentRoulette?.status==='OPEN',
    recentLedger:ledger.rows.map((r:any)=>({...r,id:Number(r.id),amount:Number(r.amount)})),
  };
}

export async function getScreenState(gameId: number) {
  await syncExpiredPredictions(gameId);
  const pool = database().pool;
  const gameResult = await pool.query(`SELECT g.*,s.mode,s.round_id AS screen_round_id,s.prediction_id,s.payload FROM game_nights g LEFT JOIN screen_state s ON s.game_night_id=g.id WHERE g.id=$1`, [gameId]);
  const game = gameResult.rows[0];
  if (!game) throw new HttpError(404,'Game not found');
  const screenMode = game.mode || game.current_screen_mode || 'DASHBOARD';
  const blockId = ['ROUND_BLOCK','ROULETTE'].includes(screenMode) ? (Number(game.payload?.blockId || game.current_round_block_id || 0) || null) : null;
  const rouletteGameId = screenMode === 'ROULETTE' ? (Number(game.payload?.rouletteGameId || 0) || null) : null;
  const [round, block, prediction, players, ledger, ticker, totals, roulette] = await Promise.all([
    pool.query(`SELECT id,round_number,title,status FROM rounds WHERE id=COALESCE($1::bigint,$2::bigint) AND game_night_id=$3`, [game.screen_round_id,game.current_round_id,gameId]),
    blockId ? pool.query(`SELECT * FROM round_blocks WHERE id=$1 AND game_night_id=$2`, [blockId,gameId]) : Promise.resolve({rows:[]} as any),
    game.prediction_id ? pool.query(`SELECT id,display_number,question,status,yes_odds,no_odds,result,opened_at,closes_at FROM predictions WHERE id=$1 AND game_night_id=$2`,[game.prediction_id,gameId]) : Promise.resolve({rows:[]} as any),
    pool.query(
      `SELECT p.id,p.display_name,p.public_color,w.current_balance,
              COALESCE((SELECT SUM(l.amount) FROM ledger_entries l WHERE l.player_id=p.id AND l.transaction_type='STARTING_BALANCE'),0)::int AS starting_balance
       FROM players p JOIN wallets w ON w.player_id=p.id WHERE p.game_night_id=$1 AND p.active=TRUE ORDER BY w.current_balance DESC,p.display_name`,[gameId]),
    pool.query(
      `SELECT l.id,l.player_id,l.amount FROM ledger_entries l JOIN players p ON p.id=l.player_id
       WHERE l.game_night_id=$1 AND p.active=TRUE ORDER BY l.created_at,l.id`,[gameId]),
    pool.query(
      `SELECT l.id,p.display_name,l.amount,l.transaction_type,l.description,r.round_number,pr.display_number AS prediction_number,l.roulette_game_id
       FROM ledger_entries l JOIN players p ON p.id=l.player_id LEFT JOIN rounds r ON r.id=l.attributed_round_id LEFT JOIN predictions pr ON pr.id=l.prediction_id
       WHERE l.game_night_id=$1 AND p.active=TRUE AND l.public_visible=TRUE ORDER BY l.created_at DESC,l.id DESC LIMIT 12`,[gameId]),
    pool.query(
      `SELECT COALESCE((SELECT SUM(w.current_balance) FROM wallets w JOIN players p ON p.id=w.player_id WHERE w.game_night_id=$1 AND p.active=TRUE),0)::int AS wallets,
              COALESCE((SELECT SUM(b.stake) FROM bets b JOIN predictions p ON p.id=b.prediction_id WHERE p.game_night_id=$1 AND b.status='ACTIVE' AND p.status IN ('OPEN','LOCKED','RESULT')),0)::int AS prediction_stakes,
              COALESCE((SELECT SUM(rb.stake) FROM roulette_bets rb JOIN roulette_games rg ON rg.id=rb.roulette_game_id WHERE rg.game_night_id=$1 AND rb.status='ACTIVE' AND rg.status IN ('OPEN','LOCKED','RESULT')),0)::int AS roulette_stakes,
              (SELECT COUNT(*) FROM predictions WHERE game_night_id=$1 AND status='OPEN')::int + (SELECT COUNT(*) FROM roulette_games WHERE game_night_id=$1 AND status='OPEN')::int AS markets_open`,[gameId]),
    screenMode === 'ROULETTE'
      ? (rouletteGameId ? pool.query(`SELECT * FROM roulette_games WHERE id=$1 AND game_night_id=$2`,[rouletteGameId,gameId]) : pool.query(`SELECT * FROM roulette_games WHERE game_night_id=$1 AND status IN ('DRAFT','OPEN','LOCKED','RESULT') ORDER BY id DESC LIMIT 1`,[gameId]))
      : Promise.resolve({rows:[]} as any),
  ]);

  const balances = new Map<number,number>();
  const series = new Map<number,Array<{x:number;balance:number}>>();
  players.rows.forEach((p:any)=>{balances.set(Number(p.id),0);series.set(Number(p.id),[]);});
  ledger.rows.forEach((e:any,index:number)=>{
    const id=Number(e.player_id); if(!balances.has(id)) return;
    const next=(balances.get(id)||0)+Number(e.amount);balances.set(id,next);
    series.get(id)!.push({x:index+1,balance:next});
  });
  const currentX = ledger.rows.length + 1;
  players.rows.forEach((p:any)=>{
    const points=series.get(Number(p.id))!;
    if(points.length===0) points.push({x:0,balance:Number(p.starting_balance)});
    const last=points[points.length-1];
    if(last.x<currentX) points.push({x:currentX,balance:Number(p.current_balance)});
  });
  const total=totals.rows[0];
  const pred=prediction.rows[0];
  const rouletteRow=roulette.rows[0];
  return {
    version:Number(game.game_state_version),game:{id:Number(game.id),name:game.name},mode:screenMode,
    round:round.rows[0]?{id:Number(round.rows[0].id),number:Number(round.rows[0].round_number),title:round.rows[0].title,status:round.rows[0].status}:null,
    block:normalizeBlock(block.rows[0]),
    prediction:pred?{id:Number(pred.id),number:Number(pred.display_number),question:pred.question,status:pred.status,yesOdds:Number(pred.yes_odds),noOdds:Number(pred.no_odds),result:pred.result,openedAt:pred.opened_at,closesAt:pred.closes_at}:null,
    leaderboard:players.rows.map((p:any)=>({id:Number(p.id),display_name:p.display_name,public_color:p.public_color,current_balance:Number(p.current_balance),starting_balance:Number(p.starting_balance),series:series.get(Number(p.id))||[]})),
    ticker:ticker.rows.map((t:any)=>({...t,id:Number(t.id),amount:Number(t.amount)})),marketsOpen:Number(total.markets_open),totalCoinsInPlay:Number(total.wallets)+Number(total.prediction_stakes)+Number(total.roulette_stakes),
    roulette:rouletteRow?{...rouletteRow,id:Number(rouletteRow.id),round_id:rouletteRow.round_id?Number(rouletteRow.round_id):null,round_block_id:rouletteRow.round_block_id?Number(rouletteRow.round_block_id):null,result_number:rouletteRow.result_number==null?null:Number(rouletteRow.result_number)}:null,
  };
}

export async function getLedgerState(gameId:number, roundFilter:'all'|'general'|number) {
  const pool=database().pool;
  const game=await pool.query('SELECT id FROM game_nights WHERE id=$1',[gameId]); if(!game.rows[0]) throw new HttpError(404,'Game not found');
  const params:any[]=[gameId]; let where='l.game_night_id=$1';
  if(roundFilter==='general') where+=' AND l.attributed_round_id IS NULL';
  else if(typeof roundFilter==='number'){params.push(roundFilter);where+=' AND l.attributed_round_id=$2';}
  const [entries,summary]=await Promise.all([
    pool.query(`SELECT l.id,l.created_at,l.amount,l.description,l.transaction_type,l.attributed_round_id,l.prediction_id,l.roulette_game_id,p.display_name,r.round_number,r.title AS round_title,pr.display_number AS prediction_number FROM ledger_entries l JOIN players p ON p.id=l.player_id LEFT JOIN rounds r ON r.id=l.attributed_round_id LEFT JOIN predictions pr ON pr.id=l.prediction_id WHERE ${where} ORDER BY l.created_at DESC,l.id DESC`,params),
    pool.query(`SELECT p.id,p.display_name,COALESCE(SUM(CASE WHEN l.amount>0 THEN l.amount ELSE 0 END),0)::int AS earned,COALESCE(SUM(CASE WHEN l.amount<0 THEN -l.amount ELSE 0 END),0)::int AS lost,COALESCE(SUM(l.amount),0)::int AS net FROM players p LEFT JOIN ledger_entries l ON l.player_id=p.id AND ${where.replace(/l\.game_night_id=\$1/,'l.game_night_id=$1')} WHERE p.game_night_id=$1 GROUP BY p.id,p.display_name HAVING COUNT(l.id)>0 ORDER BY net DESC,p.display_name`,params),
  ]);
  return {entries:entries.rows.map((r:any)=>({...r,id:Number(r.id),amount:Number(r.amount),attributed_round_id:r.attributed_round_id?Number(r.attributed_round_id):null,prediction_id:r.prediction_id?Number(r.prediction_id):null,roulette_game_id:r.roulette_game_id?Number(r.roulette_game_id):null})),summary:summary.rows.map((r:any)=>({...r,id:Number(r.id),earned:Number(r.earned),lost:Number(r.lost),net:Number(r.net)}))};
}
