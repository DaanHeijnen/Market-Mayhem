import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue } from '../lib/http';
import { incrementGameVersion, screenModeValue, setScreenMode } from '../lib/game-state';
import { wrap } from './_wrap';

export default wrap(async (request) => {
  const admin = await requireAdmin(request);
  const payload = await body<any>(request);
  const gameId = intValue(payload.gameId, 'gameId', { min: 1 });
  const mode = screenModeValue(payload.mode);
  const roundId = payload.roundId == null ? null : intValue(payload.roundId, 'roundId', { min: 1 });
  const predictionId = payload.predictionId == null ? null : intValue(payload.predictionId, 'predictionId', { min: 1 });

  return ok(await withTransaction(async (client) => {
    await setScreenMode(client, gameId, mode, admin.username, roundId, predictionId);
    await audit(client, gameId, admin.username, `screen mode ${mode}`, 'screen');
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
