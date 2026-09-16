import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, HttpError } from '../lib/http';
import { performFullReset } from '../lib/full-reset';
import { requireFullResetPhrase } from '../lib/settings';
import { wrap } from './_wrap';

/**
 * Full Reset: throw away the test run, keep the prepared evening.
 *
 * Separate endpoint from reset-game (Delete Game Save) on purpose. The two are the only
 * destructive actions in the app and they mean opposite things about the round content,
 * so they do not share a handler, a phrase or a request shape — a mistyped flag must not
 * be able to turn one into the other.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });

  // The phrase is checked here, on the server. The typed-confirmation field in Settings is
  // a guard against a slip of the hand, not the authority — a request that reaches this
  // function without the exact phrase is refused whatever the client believed.
  if (typeof p.confirmation !== 'string' || p.confirmation.length > 40) {
    throw new HttpError(400, 'confirmation must be the exact reset phrase');
  }
  requireFullResetPhrase(p.confirmation);

  return ok(await withTransaction(async client => {
    const summary = await performFullReset(client, gameId, admin.username);

    // The audit log is operational history rather than game state, so it survives the
    // reset — and this entry is the one record that the played night ever happened.
    await audit(client, gameId, admin.username, 'FULL_RESET', 'game', gameId, {
      confirmation: 'verified',
      deleted: summary.deleted,
      playersReset: summary.playersReset,
      roundsReset: summary.roundsReset,
      questionsReset: summary.questionsReset,
      slidesReset: summary.slidesReset,
      predictionsReset: summary.predictionsReset,
    });

    return { ok: true, ...summary };
  }));
});
