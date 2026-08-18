import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, textValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin=await requireAdmin(request); const p=await body<any>(request);
  const gameId=intValue(p.gameId,'gameId',{min:1}); const name=textValue(p.name,'name',120);
  const startingBalance=intValue(p.startingBalance,'startingBalance',{min:0,max:1_000_000});
  const predictionDuration=intValue(p.predictionDurationSeconds,'predictionDurationSeconds',{min:5,max:86400});
  const minimumStake=intValue(p.minimumPredictionStake,'minimumPredictionStake',{min:1,max:1_000_000});
  const maximumStake=intValue(p.maximumPredictionStake,'maximumPredictionStake',{min:1,max:1_000_000});
  const maximumWalletPercentage=p.maximumWalletPercentage==null||p.maximumWalletPercentage===''?null:intValue(p.maximumWalletPercentage,'maximumWalletPercentage',{min:1,max:100});
  if(maximumStake<minimumStake) throw new HttpError(400,'Maximum prediction stake must be at least the minimum stake');
  return ok(await withTransaction(async client=>{
    const q=await client.query(`UPDATE game_nights SET name=$2,starting_balance=$3,prediction_duration_seconds=$4,minimum_prediction_stake=$5,maximum_prediction_stake=$6,maximum_wallet_percentage=$7,updated_at=NOW() WHERE id=$1 RETURNING id`,[gameId,name,startingBalance,predictionDuration,minimumStake,maximumStake,maximumWalletPercentage]);
    if(!q.rows[0]) throw new HttpError(404,'Game not found');
    await audit(client,gameId,admin.username,'updated game settings','game',gameId,{name,startingBalance,predictionDuration,minimumStake,maximumStake,maximumWalletPercentage});
    return {version:await incrementGameVersion(client,gameId)};
  }));
});
