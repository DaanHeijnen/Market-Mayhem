import type { PoolClient } from 'pg';
import { HttpError } from './http';

/**
 * The ten standard players.
 *
 * Every game night is played by the same people, so they are domain configuration rather
 * than something a host retypes. This module is the only place the list exists in the
 * application; migration 0017 repeats it once to seed a fresh database, and
 * tests/default-players.test.ts reads both and fails if they ever drift apart.
 *
 * `key` is the identity, `name` is the presentation. They are separate because the name
 * is editable and carries spelling the Admin can change — Raúl has an accent, and a
 * renamed player must still be the same player, not a second one. The key is written to
 * players.seed_key, which has a partial unique index per game night, so "there is exactly
 * one standard Jordi" is a database invariant rather than a convention.
 */
export const DEFAULT_PLAYERS = [
  { key: 'default:jordi', name: 'Jordi', color: '#3D5AFE' },
  { key: 'default:wouter', name: 'Wouter', color: '#DFF24C' },
  { key: 'default:bas', name: 'Bas', color: '#9B2FF2' },
  { key: 'default:boyen', name: 'Boyen', color: '#FF3FC0' },
  { key: 'default:david', name: 'David', color: '#2FAF5B' },
  { key: 'default:dries', name: 'Dries', color: '#E8352F' },
  { key: 'default:moise', name: 'Moise', color: '#FF7A1E' },
  { key: 'default:raul', name: 'Raúl', color: '#1FD8E0' },
  { key: 'default:tijs', name: 'Tijs', color: '#F2B705' },
  { key: 'default:twan', name: 'Twan', color: '#2A2820' },
] as const;

/**
 * What a standard player starts a night with.
 *
 * It is written to players.starting_balance_snapshot when they are created, and that
 * column — not this constant — is what a reset reads back. So the value is fixed at the
 * moment of seeding and stays attached to the player, which is the same rule
 * create-player already follows for a hand-added player.
 *
 * Deliberately not game_nights.starting_balance: that setting is the default for players
 * the Admin adds during a night and the host may change it, while the standard ten are
 * defined as starting on 100.
 */
export const DEFAULT_PLAYER_COINS = 100;

/** The business key for a standard player's opening ledger entry. */
function startingBalanceKey(seedKey: string) {
  return `default-player:starting-balance:${seedKey}`;
}

export type DefaultPlayersSummary = {
  /** Standard players newly inserted. */
  created: number;
  /** Standard players that already existed and were put back to their default state. */
  restored: number;
  /** Hand-added players removed. Only a reset ever removes anyone. */
  removed: number;
  /** Opening ledger entries written. */
  startingBalanceEntries: number;
};

const EMPTY: DefaultPlayersSummary = { created: 0, restored: 0, removed: 0, startingBalanceEntries: 0 };

/**
 * Write the standard roster, without deleting anything.
 *
 * Idempotent by construction: the player upsert is arbitrated by the seed-key unique
 * index, the wallet upsert by its primary key, and the opening ledger entry by the
 * ledger's own idempotency index. Running this three times in a row therefore produces
 * ten players, ten wallets and ten opening entries — not thirty of anything.
 *
 * Wallet and ledger move together in the caller's transaction, which is the financial
 * invariant the rest of the app keeps: a balance exists because a ledger entry says so.
 */
async function applyDefaultRoster(client: PoolClient, gameId: number, actor: string): Promise<DefaultPlayersSummary> {
  const keys = DEFAULT_PLAYERS.map(p => p.key);
  const names = DEFAULT_PLAYERS.map(p => p.name);
  const colors = DEFAULT_PLAYERS.map(p => p.color);

  // One statement for all ten, so the query count does not grow with the roster.
  // `xmax = 0` is true only for a row this statement inserted, which is what separates
  // "created" from "restored" without a second round trip.
  const players = await client.query(
    `WITH d(seed_key,display_name,public_color) AS (
       SELECT * FROM unnest($2::text[],$3::text[],$4::text[])
     )
     INSERT INTO players(game_night_id,display_name,public_color,active,starting_balance_snapshot,seed_key)
     SELECT $1,d.display_name,d.public_color,TRUE,$5,d.seed_key FROM d
     ON CONFLICT (game_night_id,seed_key) WHERE seed_key IS NOT NULL DO UPDATE
       SET display_name=EXCLUDED.display_name,
           public_color=EXCLUDED.public_color,
           active=TRUE,
           starting_balance_snapshot=EXCLUDED.starting_balance_snapshot,
           updated_at=NOW()
     RETURNING id,seed_key,(xmax = 0) AS inserted`,
    [gameId, keys, names, colors, DEFAULT_PLAYER_COINS],
  );

  await client.query(
    `INSERT INTO wallets(player_id,game_night_id,current_balance)
     SELECT p.id,$1,$2 FROM players p WHERE p.game_night_id=$1 AND p.seed_key = ANY($3::text[])
     ON CONFLICT (player_id) DO UPDATE SET current_balance=EXCLUDED.current_balance,updated_at=NOW()`,
    [gameId, DEFAULT_PLAYER_COINS, keys],
  );

  // The opening entry. ON CONFLICT DO NOTHING against the ledger's idempotency index is
  // what makes a retried request harmless: the same key can only ever buy one entry, so
  // a double-clicked reset cannot pay the starting balance twice.
  //
  // A zero starting balance would have no entry at all, because ledger_entries forbids a
  // zero amount — the wallet is already correct in that case, and create-player and the
  // Full Reset path make the same exception.
  const entries = DEFAULT_PLAYER_COINS > 0
    ? await client.query(
      `INSERT INTO ledger_entries(game_night_id,player_id,amount,transaction_type,description,created_by,idempotency_key)
       SELECT $1,p.id,$2,'STARTING_BALANCE','Starting balance',$3,'default-player:starting-balance:' || p.seed_key
       FROM players p WHERE p.game_night_id=$1 AND p.seed_key = ANY($4::text[])
       ON CONFLICT (game_night_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [gameId, DEFAULT_PLAYER_COINS, actor, keys],
    )
    : { rowCount: 0 };

  await client.query(
    'UPDATE game_nights SET default_players_initialized_at=COALESCE(default_players_initialized_at,NOW()),updated_at=NOW() WHERE id=$1',
    [gameId],
  );

  const created = players.rows.filter(row => row.inserted).length;
  return {
    created,
    restored: players.rows.length - created,
    removed: 0,
    startingBalanceEntries: entries.rowCount ?? 0,
  };
}

/**
 * Ensure initial setup — put the standard players there once, and never again.
 *
 * The latch on the game night is the whole point. Without it this would be a rule that
 * the ten always exist, and a player the host deliberately removed would silently
 * reappear on the next request. With it, initialization happens once per night and
 * putting the full list back is an explicit act: resetPlayersToDefaults.
 *
 * Safe to call any number of times, from anywhere. The caller supplies the transaction;
 * the row lock here is what serialises two requests that arrive together.
 */
export async function initializeDefaultPlayers(
  client: PoolClient,
  gameId: number,
  actor: string,
): Promise<DefaultPlayersSummary & { alreadyInitialized: boolean }> {
  const game = await client.query(
    'SELECT default_players_initialized_at FROM game_nights WHERE id=$1 FOR UPDATE',
    [gameId],
  );
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');
  if (game.rows[0].default_players_initialized_at) return { ...EMPTY, alreadyInitialized: true };

  return { ...await applyDefaultRoster(client, gameId, actor), alreadyInitialized: false };
}

/**
 * Reset to defaults — the roster a night starts from, restored exactly.
 *
 * Afterwards the night holds the ten standard players and nobody else, each on their
 * starting balance with a single opening ledger entry behind it. Hand-added players are
 * removed; a standard player who was deactivated or renamed is put back rather than
 * duplicated, which is why their join link and session survive a Full Reset.
 *
 * This deletes the night's ledger rather than writing correcting entries. That is the
 * decision Full Reset already made and the reason is unchanged: a reset is meant to leave
 * no trace of the run before it, and a compensating transaction would leave that run
 * visible in every player's history as though it had really happened. What remains is one
 * opening entry per player, which is also what keeps wallet and ledger in step.
 *
 * Callers are expected to have cleared the night's runtime tables first. This function
 * still removes the ledger itself, so the invariant holds however it is called.
 */
export async function resetPlayersToDefaults(
  client: PoolClient,
  gameId: number,
  actor: string,
): Promise<DefaultPlayersSummary> {
  const game = await client.query('SELECT id FROM game_nights WHERE id=$1 FOR UPDATE', [gameId]);
  if (!game.rows[0]) throw new HttpError(404, 'Game not found');

  // Everyone who is not one of the ten. Every table that references a player does so with
  // ON DELETE CASCADE, so their wallet, sessions, join tokens, bets and entries go with
  // them rather than being left behind pointing at nobody.
  const removed = await client.query(
    'DELETE FROM players WHERE game_night_id=$1 AND seed_key IS NULL RETURNING id',
    [gameId],
  );

  // Only standard players remain, so this is exactly their history.
  await client.query('DELETE FROM ledger_entries WHERE game_night_id=$1', [gameId]);

  // Names are unique per night and the upsert below hands them back out, so a night where
  // two standard players were renamed past each other would collide mid-statement. Moving
  // every one of them out of the way first makes the order irrelevant. Never visible: it
  // happens and is undone inside the caller's transaction.
  await client.query(
    `UPDATE players SET display_name='seed-reset:' || id
     WHERE game_night_id=$1 AND seed_key IS NOT NULL`,
    [gameId],
  );

  const summary = await applyDefaultRoster(client, gameId, actor);
  return { ...summary, removed: removed.rowCount ?? 0 };
}
