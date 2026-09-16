import { randomInt } from 'node:crypto';
import { requirePlayer } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { body, ok, intValue, requestIdempotencyKey, HttpError } from '../lib/http';
import { incrementGameVersion } from '../lib/game-state';
import {
  allSixesFound,
  cardLabel,
  countSixes,
  drawCard,
  isSix,
  nextTurnIndex,
  playerAtTurn,
  remainingDeck,
  type Card,
  type Rank,
  type Suit,
} from '../lib/pak-een-zes';
import { awardPakEenZesPredictions } from '../lib/pak-een-zes-state';
import { wrap } from './_wrap';

/**
 * Draw one card.
 *
 * The server owns both halves of this: which card comes out and whose turn it is. The
 * phone only says "I am drawing"; it cannot choose a card, and a player who is not up
 * cannot draw at all.
 *
 * A card leaves the deck exactly once. The remaining deck is derived from the rows
 * already drawn rather than from a shuffled list held somewhere, so there is no
 * in-memory state to fall out of step, and a unique constraint on (game, rank, suit)
 * makes "no repeats" a database guarantee rather than an application promise.
 *
 * Double-tap protection has three layers: a row lock serialises concurrent requests, a
 * unique idempotency key answers a replay with the card it already produced, and the
 * turn only advances once inside the same transaction.
 */
export default wrap(async request => {
  const p = await body<any>(request);
  const gameId = intValue(p.gameId, 'gameId', { min: 1 });
  const roundId = intValue(p.roundId, 'roundId', { min: 1 });
  const session = await requirePlayer(request, gameId);
  const key = requestIdempotencyKey(request);

  return ok(await withTransaction(async client => {
    const game = await client.query('SELECT current_round_id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
    if (!game.rows[0]) throw new HttpError(404, 'Game not found');

    const roundResult = await client.query(
      'SELECT id,type,status AS round_status FROM rounds WHERE id=$1 AND game_night_id=$2',
      [roundId, gameId],
    );
    const block = roundResult.rows[0];
    if (!block) throw new HttpError(404, 'Round not found');
    if (block.type !== 'PAK_EEN_ZES') throw new HttpError(409, 'That round is not a Pak een Zes');
    if (block.round_status !== 'ACTIVE' || Number(game.rows[0].current_round_id || 0) !== roundId) {
      throw new HttpError(409, 'The Pak een Zes round is not active');
    }

    // FOR UPDATE is what serialises a double tap: the second request waits here and
    // then sees the turn already advanced.
    const existing = await client.query(
      `SELECT id,round_id,status,turn_index FROM pak_een_zes_games
       WHERE game_night_id=$1 AND round_id=$2
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [gameId, roundId],
    );
    const current = existing.rows[0];
    if (!current) throw new HttpError(409, 'The game has not started');
    const pakEenZesGameId = Number(current.id);

    // A replay is answered with the card that key already drew, never another one.
    const replay = await client.query(
      'SELECT id,draw_number,rank,suit,is_six FROM pak_een_zes_draws WHERE pak_een_zes_game_id=$1 AND idempotency_key=$2',
      [pakEenZesGameId, key],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      return {
        duplicate: true,
        drawId: Number(row.id),
        drawNumber: Number(row.draw_number),
        card: cardLabel({ rank: row.rank as Rank, suit: row.suit as Suit }),
        isSix: Boolean(row.is_six),
      };
    }

    if (current.status !== 'DRAWING') throw new HttpError(409, 'The game is not drawing cards');

    const participants = await client.query(
      'SELECT player_id,turn_order FROM pak_een_zes_participants WHERE pak_een_zes_game_id=$1 ORDER BY turn_order',
      [pakEenZesGameId],
    );
    const order = participants.rows.map((r: any) => Number(r.player_id));
    if (!order.length) throw new HttpError(409, 'This game has no turn order');

    const turnIndex = Number(current.turn_index);
    const whoseTurn = playerAtTurn(order, turnIndex);
    // The turn check is the whole reason drawing cannot be client-side: only the player
    // the server says is up may take a card.
    if (whoseTurn !== session.playerId) throw new HttpError(403, 'It is not your turn');

    const drawnRows = await client.query(
      'SELECT rank,suit FROM pak_een_zes_draws WHERE pak_een_zes_game_id=$1',
      [pakEenZesGameId],
    );
    const drawn: Card[] = drawnRows.rows.map((r: any) => ({ rank: r.rank as Rank, suit: r.suit as Suit }));
    const remaining = remainingDeck(drawn);
    if (!remaining.length) throw new HttpError(409, 'The deck is empty');

    const card = drawCard(remaining, max => randomInt(0, max));
    const drawNumber = drawn.length + 1;
    const six = isSix(card);

    const inserted = await client.query(
      `INSERT INTO pak_een_zes_draws(pak_een_zes_game_id,game_night_id,round_id,player_id,
        draw_number,rank,suit,is_six,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [pakEenZesGameId, gameId, roundId, session.playerId, drawNumber, card.rank, card.suit, six, key],
    );

    // The game ends the moment the fourth six is out, whatever is left in the deck.
    const sixesFound = countSixes([...drawn, card]);
    const finished = allSixesFound([...drawn, card]);
    let reward: { awarded: number; totalPoints: number; pointsPerCorrect: number } | null = null;
    if (finished) {
      await client.query(
        "UPDATE pak_een_zes_games SET status='FINISHED',finished_at=NOW(),updated_at=NOW() WHERE id=$1",
        [pakEenZesGameId],
      );
      // Paid in the same transaction as the six that ended the game: no separate Admin
      // step to forget, and no window where the game is over but unscored. The ledger's
      // unique index is what makes a retry safe.
      reward = await awardPakEenZesPredictions(client, gameId, pakEenZesGameId, 'player');
    } else {
      await client.query(
        'UPDATE pak_een_zes_games SET turn_index=$2,updated_at=NOW() WHERE id=$1',
        [pakEenZesGameId, nextTurnIndex(turnIndex, order.length)],
      );
    }

    return {
      drawId: Number(inserted.rows[0].id),
      drawNumber,
      card: cardLabel(card),
      rank: card.rank,
      suit: card.suit,
      isSix: six,
      sixesFound,
      finished,
      reward,
      version: await incrementGameVersion(client, gameId),
    };
  }));
});
