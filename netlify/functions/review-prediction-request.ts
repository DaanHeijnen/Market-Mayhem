import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { decisionValue, reasonForDecision } from '../lib/prediction-requests';
import { wrap } from './_wrap';

// Approve or deny a player-proposed market.
//
// Approving deliberately does not create the market: the player-facing copy is
// "waiting for prediction to go live", so approval only signals intent and the Admin
// still authors it on the Predictions page with its own odds and stake limits.
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const requestId = intValue(p.requestId, 'requestId', { min: 1 });
  const decision = decisionValue(p.decision);
  const reason = reasonForDecision(decision, p.reason);

  return ok(await withTransaction(async client => {
    const existing = await client.query(
      'SELECT id,status FROM prediction_requests WHERE id=$1 AND game_night_id=$2 FOR UPDATE',
      [requestId, gameId],
    );
    if (!existing.rows[0]) throw new HttpError(404, 'Prediction request not found');
    if (existing.rows[0].status !== 'PENDING') throw new HttpError(409, 'That request has already been reviewed');

    await client.query(
      `UPDATE prediction_requests SET status=$2,reason=$3,reviewed_at=NOW(),reviewed_by=$4 WHERE id=$1`,
      [requestId, decision, reason, admin.username],
    );
    await audit(client, gameId, admin.username, `prediction request ${decision.toLowerCase()}`, 'prediction_request', requestId, { reason });
    return { version: await incrementGameVersion(client, gameId) };
  }));
});
