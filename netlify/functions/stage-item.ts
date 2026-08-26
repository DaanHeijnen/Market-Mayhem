import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion, setStagedItem, type StagedItem } from '../lib/game-state';
import { wrap } from './_wrap';

// Select what the projector will show next, without changing what it shows now.
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });

  let item: StagedItem;
  if (p.kind === 'dashboard') {
    item = { kind: 'dashboard' };
  } else if (p.kind === 'block') {
    item = { kind: 'block', roundId: intValue(p.roundId, 'roundId', { min: 1 }), blockId: intValue(p.blockId, 'blockId', { min: 1 }) };
  } else if (p.kind === 'prediction') {
    item = { kind: 'prediction', predictionId: intValue(p.predictionId, 'predictionId', { min: 1 }) };
  } else {
    throw new HttpError(400, 'kind must be dashboard, block or prediction');
  }

  return ok(await withTransaction(async client => {
    await setStagedItem(client, gameId, item, admin.username);
    await audit(client, gameId, admin.username, `staged ${item.kind}`, 'screen');
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
