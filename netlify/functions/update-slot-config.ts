import { requireAdmin, audit } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, numberValue, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { mediaKeyValue } from '../lib/media';
import { loadSlotConfig } from '../lib/slot-state';
import {
  isSlotOutcomeType,
  outcomeTypeAllowsPayout,
  SLOT_OUTCOME_TYPES,
  SLOT_POSITIONS_PER_REEL,
  SLOT_SYMBOL_COUNT,
  type SlotOutcomeType,
} from '../lib/slotmachine';
import { wrap } from './_wrap';

/**
 * Save the game-wide slotmachine configuration: the total number of chances, the symbol
 * artwork and the chance/payout for each of the five outcome types.
 *
 * Accepts a partial update — Settings saves the symbols and the chances independently,
 * and neither should have to resend the other. An invalid configuration is deliberately
 * *saveable*: the Admin needs to be able to nudge the numbers toward the total across
 * several saves. Validity is enforced where it matters instead, at the point a series is
 * locked or a spin is taken.
 */
export default wrap(async request => {
  const admin = await requireAdmin(request);
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });

  const totalWeight = p.totalWeight == null ? null : intValue(p.totalWeight, 'totalWeight', { min: 1, max: 1_000_000 });

  // Symbols: [{ position, mediaKey }]. One shared set of twelve used by all three
  // reels. An empty/null mediaKey deletes that position, which is how the Admin's
  // REMOVE button works.
  const symbols = p.symbols == null ? null : (() => {
    if (!Array.isArray(p.symbols)) throw new HttpError(400, 'symbols must be an array');
    if (p.symbols.length > SLOT_SYMBOL_COUNT) throw new HttpError(400, `symbols cannot exceed ${SLOT_SYMBOL_COUNT} positions`);
    const seen = new Set<number>();
    return p.symbols.map((raw: any, index: number) => {
      const position = intValue(raw?.position, `symbols[${index}].position`, { min: 1, max: SLOT_POSITIONS_PER_REEL });
      if (seen.has(position)) throw new HttpError(400, `symbols contains position ${position} twice`);
      seen.add(position);
      const empty = raw?.mediaKey == null || raw.mediaKey === '';
      return { position, mediaKey: empty ? '' : mediaKeyValue(raw.mediaKey) };
    });
  })();

  // Outcome types: [{ type, weight, payoutMultiplier }]. The five categories are fixed
  // product, so this only ever updates their chance and payout — it cannot add a sixth
  // or remove one, and an unknown type is a client bug rather than something to ignore.
  const outcomeTypes = p.outcomeTypes == null ? null : (() => {
    if (!Array.isArray(p.outcomeTypes)) throw new HttpError(400, 'outcomeTypes must be an array');
    if (p.outcomeTypes.length > SLOT_OUTCOME_TYPES.length) throw new HttpError(400, `outcomeTypes cannot exceed the ${SLOT_OUTCOME_TYPES.length} fixed categories`);
    const seen = new Set<SlotOutcomeType>();
    return p.outcomeTypes.map((raw: any, index: number) => {
      const type = raw?.type;
      if (!isSlotOutcomeType(type)) throw new HttpError(400, `outcomeTypes[${index}].type is not one of the five categories`);
      if (seen.has(type)) throw new HttpError(400, `outcomeTypes contains ${type} twice`);
      seen.add(type);
      const requested = Number(numberValue(raw?.payoutMultiplier, `outcomeTypes[${index}].payoutMultiplier`, { min: 0, max: 10_000 }).toFixed(3));
      return {
        type,
        weight: intValue(raw?.weight, `outcomeTypes[${index}].weight`, { min: 0, max: 1_000_000 }),
        // No win pays nothing by definition. Forced rather than rejected so a stale
        // client cannot fail a whole save over a field it should not have sent.
        payoutMultiplier: outcomeTypeAllowsPayout(type) ? requested : 0,
      };
    });
  })();

  if (totalWeight == null && symbols == null && outcomeTypes == null) throw new HttpError(400, 'Nothing to update');

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    await client.query(
      `INSERT INTO slot_configs(game_night_id,total_weight,updated_by)
       VALUES($1,COALESCE($2,100),$3)
       ON CONFLICT(game_night_id) DO UPDATE
         SET total_weight=COALESCE($2,slot_configs.total_weight),updated_at=NOW(),updated_by=$3`,
      [gameId, totalWeight, admin.username],
    );

    if (symbols) {
      for (const symbol of symbols) {
        if (symbol.mediaKey) {
          await client.query(
            `INSERT INTO slot_reel_symbols(game_night_id,position,media_key)
             VALUES($1,$2,$3)
             ON CONFLICT(game_night_id,position) DO UPDATE SET media_key=EXCLUDED.media_key,updated_at=NOW()`,
            [gameId, symbol.position, symbol.mediaKey],
          );
        } else {
          await client.query('DELETE FROM slot_reel_symbols WHERE game_night_id=$1 AND position=$2', [gameId, symbol.position]);
        }
      }
    }

    if (outcomeTypes) {
      // Upsert rather than delete-and-insert: the five rows always exist, so a save only
      // moves their numbers. A category the client left out keeps what it had.
      for (const outcome of outcomeTypes) {
        await client.query(
          `INSERT INTO slot_outcome_types(game_night_id,outcome_type,weight,payout_multiplier)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(game_night_id,outcome_type)
             DO UPDATE SET weight=EXCLUDED.weight,payout_multiplier=EXCLUDED.payout_multiplier,updated_at=NOW()`,
          [gameId, outcome.type, outcome.weight, outcome.payoutMultiplier],
        );
      }
    }

    const config = await loadSlotConfig(client, gameId);
    await audit(client, gameId, admin.username, 'updated slotmachine configuration', 'game', gameId, {
      totalWeight: config.totalWeight,
      allocatedWeight: config.status.allocatedWeight,
      symbolCount: config.status.symbolCount,
      valid: config.status.valid,
    });
    return { slotConfig: config, version: await incrementGameVersion(client, gameId) };
  }));
});
