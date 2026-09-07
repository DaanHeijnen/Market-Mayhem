import { randomInt } from 'node:crypto';
import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import { loadSlotConfig, playerMayPlaySlot, slotBlockSettings } from '../lib/slot-state';
import {
  classifyGrid,
  generateGrid,
  gridLabel,
  pickOutcomeType,
  slotPayout,
  winningCells,
  SLOT_MAIN_ROW,
  SLOT_OUTCOME_LABELS,
} from '../lib/slotmachine';
import { wrap } from './_wrap';

/**
 * Take one spin from a locked series.
 *
 * The server decides everything, in two steps. First it draws one of the five outcome
 * types from the Admin's distribution. Then it builds a 3x3 field that matches that type
 * and re-classifies the finished field to prove it does — so the configured chances are
 * the chances players actually see, and no spin can quietly show a stronger pattern than
 * the one it was paid for. The payout comes from the drawn type, never from which
 * symbols happened to fill it.
 *
 * All of that, the coin movement and the stored result happen inside one transaction,
 * before any client is told anything. The Big Screen animation only ever plays toward an
 * outcome that is already committed.
 *
 * The payout is credited here rather than after the animation. That keeps the money in
 * the same transaction as the decision, so there is no settlement step that could be
 * missed or replayed, which is the same reliability the prediction and roulette paths
 * have. `status='SPINNING'` is what lets the surfaces hold the reveal for the length of
 * the animation.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const seriesId = intValue(p.seriesId, 'seriesId', { min: 1 });
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id,current_round_block_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    // FOR UPDATE on the series is what serialises a double SPIN tap: the second request
    // waits here and then sees spins_remaining already decremented.
    const seriesResult = await client.query(
      `SELECT id,player_id,round_id,round_block_id,stake_per_spin,total_spins,spins_remaining,status
       FROM slot_series WHERE id=$1 AND game_night_id=$2 FOR UPDATE`,
      [seriesId, gameId],
    );
    const series = seriesResult.rows[0];
    if (!series) throw new HttpError(404, 'Slotmachine series not found');
    // A series belongs to the player who locked it. Another phone holding a valid
    // session for this game still cannot spin it.
    if (Number(series.player_id) !== session.playerId) throw new HttpError(403, 'This series belongs to another player');

    // An idempotent replay is answered with the spin that key already produced, so a
    // double tap on SPIN never consumes a second spin or pays a second payout.
    const replay = await client.query(
      'SELECT id,spin_number,payout FROM slot_spins WHERE slot_series_id=$1 AND idempotency_key=$2',
      [seriesId, key],
    );
    if (replay.rows[0]) {
      const spin = replay.rows[0];
      return { duplicate: true, spinId: Number(spin.id), spinNumber: Number(spin.spin_number), payout: Number(spin.payout) };
    }

    if (series.status !== 'ACTIVE') throw new HttpError(409, 'This series is no longer active');
    const remaining = Number(series.spins_remaining);
    if (remaining <= 0) throw new HttpError(409, 'No spins remaining in this series');

    const blockId = Number(series.round_block_id || 0);
    if (!blockId || Number(game.rows[0].current_round_block_id || 0) !== blockId) throw new HttpError(409, 'The slotmachine is not the live content block');

    const blockResult = await client.query(
      `SELECT b.id,b.round_id,b.type,b.payload,r.status AS round_status
       FROM round_blocks b JOIN rounds r ON r.id=b.round_id
       WHERE b.id=$1 AND b.game_night_id=$2`,
      [blockId, gameId],
    );
    const block = blockResult.rows[0];
    if (!block) throw new HttpError(404, 'Slotmachine block not found');
    if (block.type !== 'SLOTMACHINE') throw new HttpError(409, 'Block is not a slotmachine');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== Number(block.round_id)) {
      throw new HttpError(409, 'The slotmachine round is not active');
    }
    if (!playerMayPlaySlot(slotBlockSettings(block.payload), session.playerId)) {
      throw new HttpError(403, 'You are not taking part in this slotmachine');
    }

    const config = await loadSlotConfig(client, gameId);
    if (!config.status.valid) throw new HttpError(409, `Slotmachine is not ready: ${config.status.reason}`);

    // The one place the result is decided. randomInt is cryptographic.
    const random = (maxExclusive: number) => randomInt(0, maxExclusive);

    // Step 1 — which kind of outcome falls, from the configured chances.
    const outcome = pickOutcomeType(config.outcomeTypes, config.totalWeight, random);

    // Step 2 — a field that shows exactly that. generateGrid classifies its own result
    // and retries, but the verdict is re-derived here as well: the payout below is only
    // honest if the field on the projector really is the category that was drawn.
    const grid = generateGrid(outcome.type, config.availableSymbols, random);
    const shown = classifyGrid(grid);
    if (shown !== outcome.type) throw new HttpError(500, 'Slotmachine generated a field that does not match its outcome type');

    const stake = Number(series.stake_per_spin);
    const payout = slotPayout(stake, outcome.payoutMultiplier);
    const spinNumber = Number(series.total_spins) - remaining + 1;
    const label = SLOT_OUTCOME_LABELS[outcome.type];

    // The field as stored: position plus the artwork key at that moment, so history
    // survives a later re-upload in Settings.
    const gridPayload = grid.map(row => row.map(position => ({
      p: position,
      k: config.symbolByPosition[position] || '',
    })));
    const winCells = winningCells(grid);
    const mainRow = grid[SLOT_MAIN_ROW];

    const inserted = await client.query(
      `INSERT INTO slot_spins(slot_series_id,game_night_id,round_id,round_block_id,player_id,spin_number,
        reel1_position,reel2_position,reel3_position,reel1_media_key,reel2_media_key,reel3_media_key,
        stake,payout_multiplier,payout,idempotency_key,status,outcome_type,grid,win_cells)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'SPINNING',$17,$18::jsonb,$19::jsonb)
       RETURNING id,spun_at`,
      [
        seriesId, gameId, Number(series.round_id), blockId, session.playerId, spinNumber,
        // The reel1-3 columns carry the main row, the row that decides the two-alike
        // categories; the whole field lives in `grid`.
        mainRow[0], mainRow[1], mainRow[2],
        config.symbolByPosition[mainRow[0]] || '',
        config.symbolByPosition[mainRow[1]] || '',
        config.symbolByPosition[mainRow[2]] || '',
        stake, outcome.payoutMultiplier, payout, key,
        outcome.type, JSON.stringify(gridPayload), JSON.stringify(winCells),
      ],
    );
    const spinId = Number(inserted.rows[0].id);

    if (payout > 0) {
      const wallet = await client.query('SELECT current_balance FROM wallets WHERE player_id=$1 AND game_night_id=$2 FOR UPDATE', [session.playerId, gameId]);
      if (!wallet.rows[0]) throw new HttpError(404, 'Player wallet not found');
      await client.query(
        `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,attributed_round_id,round_block_id,slot_series_id,slot_spin_id,created_by,idempotency_key,metadata)
         VALUES($1,$2,$3,'SLOT_PAYOUT',$4,$5,$6,$7,$8,'player',$9,$10::jsonb)`,
        [
          gameId, session.playerId, payout, `Slotmachine ${label} at ${outcome.payoutMultiplier}x`,
          Number(series.round_id), blockId, seriesId, spinId, `slot:spin:${key}`,
          JSON.stringify({ outcomeType: outcome.type, field: gridLabel(grid), multiplier: outcome.payoutMultiplier, stake, spinNumber }),
        ],
      );
      await client.query('UPDATE wallets SET current_balance=current_balance+$1,updated_at=NOW() WHERE player_id=$2', [payout, session.playerId]);
    }

    // The guard in the WHERE clause is a second line of defence behind the row lock and
    // the spins_remaining >= 0 constraint: a spin can never take the counter negative.
    const decremented = await client.query(
      `UPDATE slot_series
       SET spins_remaining=spins_remaining-1,
           status=CASE WHEN spins_remaining-1 = 0 THEN 'COMPLETED' ELSE status END,
           closed_at=CASE WHEN spins_remaining-1 = 0 THEN NOW() ELSE closed_at END
       WHERE id=$1 AND spins_remaining > 0 RETURNING spins_remaining,status`,
      [seriesId],
    );
    if (!decremented.rows[0]) throw new HttpError(409, 'No spins remaining in this series');

    return {
      spinId,
      spinNumber,
      outcomeType: outcome.type,
      outcome: label,
      spinsRemaining: Number(decremented.rows[0].spins_remaining),
      seriesStatus: decremented.rows[0].status,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
