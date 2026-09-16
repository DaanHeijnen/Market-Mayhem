import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESERVED_TABLES, RUNTIME_TABLES } from '../netlify/lib/full-reset';
import { FULL_RESET_PHRASE, GAME_RESET_PHRASE, requireFullResetPhrase } from '../netlify/lib/settings';

const MIGRATIONS = join(__dirname, '..', 'netlify', 'database', 'migrations');

/** Every table the migrations leave behind, read from the migrations themselves. */
function liveTables(): string[] {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  const tables = new Set<string>();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // In document order: 0010 drops the abandoned first attempt at the slotmachine
    // schema and then recreates it in the same file, so create-then-drop would lose it.
    // 0016 renames one table and drops another, so both have to be followed too — a
    // table this misses is a table the classification test cannot hold anyone to.
    for (const m of sql.matchAll(/(?:(CREATE|DROP) TABLE (?:IF (?:NOT )?EXISTS )?([a-z_0-9]+)|ALTER TABLE ([a-z_0-9]+) RENAME TO ([a-z_0-9]+))/g)) {
      if (m[1] === 'CREATE') tables.add(m[2]);
      else if (m[1] === 'DROP') tables.delete(m[2]);
      else { tables.delete(m[3]); tables.add(m[4]); }
    }
  }
  return [...tables].sort();
}

describe('the full reset phrase', () => {
  it('only accepts the exact phrase', () => {
    expect(requireFullResetPhrase(FULL_RESET_PHRASE)).toBe(true);
    expect(() => requireFullResetPhrase('reset avond')).toThrow();
    expect(() => requireFullResetPhrase('RESET AVOND ')).toThrow();
    expect(() => requireFullResetPhrase('RESETAVOND')).toThrow();
    expect(() => requireFullResetPhrase('')).toThrow();
  });

  it('refuses anything that is not a string, rather than coercing it', () => {
    // The phrase arrives from a JSON body, so a client can send anything at all.
    expect(() => requireFullResetPhrase(undefined)).toThrow();
    expect(() => requireFullResetPhrase(null)).toThrow();
    expect(() => requireFullResetPhrase(['RESET AVOND'])).toThrow();
    expect(() => requireFullResetPhrase({ toString: () => FULL_RESET_PHRASE })).toThrow();
  });

  // The two destructive actions sit next to each other in Settings and mean opposite
  // things about the round content, so typing one must never trigger the other.
  it('is not the delete phrase', () => {
    expect(FULL_RESET_PHRASE).not.toBe(GAME_RESET_PHRASE);
    expect(() => requireFullResetPhrase(GAME_RESET_PHRASE)).toThrow();
  });
});

describe('the runtime/configuration classification', () => {
  // The guard that matters most: a table nobody classified is a table whose test data
  // would quietly survive a Full Reset — or whose configuration would quietly be wiped.
  // A new migration that adds a table fails this until someone decides which it is.
  it('classifies every table the migrations create', () => {
    const classified = new Set<string>([...RUNTIME_TABLES, ...PRESERVED_TABLES]);
    const unclassified = liveTables().filter(table => !classified.has(table));
    expect(unclassified).toEqual([]);
  });

  it('never classifies a table as both runtime and configuration', () => {
    const preserved = new Set<string>(PRESERVED_TABLES);
    expect(RUNTIME_TABLES.filter(table => preserved.has(table))).toEqual([]);
  });

  it('classifies no table that does not exist', () => {
    const live = new Set(liveTables());
    const missing = [...RUNTIME_TABLES, ...PRESERVED_TABLES].filter(table => !live.has(table));
    expect(missing).toEqual([]);
  });

  it('lists each table only once', () => {
    expect(new Set(RUNTIME_TABLES).size).toBe(RUNTIME_TABLES.length);
    expect(new Set(PRESERVED_TABLES).size).toBe(PRESERVED_TABLES.length);
  });

  // The headline rule of the feature: the prepared evening must survive. These are the
  // tables that hold it, and none of them may ever appear in the delete list.
  it('never deletes the prepared evening', () => {
    const runtime = new Set<string>(RUNTIME_TABLES);
    for (const table of [
      'rounds',              // the run of show
      'round_blocks',        // every step and its payload
      'round_groups',        // teams
      'round_group_members', // team membership
      'predictions',         // prepared markets with their odds
      'slot_configs',        // slotmachine total
      'slot_reel_symbols',   // the uploaded artwork
      'slot_outcome_types',  // chances and payouts
      'players',             // who is playing
      'wallets',             // reset in place, never dropped
      'game_nights',         // the settings on the Settings page
    ]) {
      expect(runtime.has(table), table).toBe(false);
    }
  });

  // The other half: everything the playing produced must be in the delete list, or the
  // reset would leave test data on screen.
  it('deletes everything the playing produced', () => {
    const runtime = new Set<string>(RUNTIME_TABLES);
    for (const table of [
      'ledger_entries',
      'bets',
      'roulette_games',
      'roulette_bets',
      'slot_series',
      'slot_spins',
      'pak_een_zes_games',
      'pak_een_zes_participants',
      'pak_een_zes_predictions',
      'pak_een_zes_draws',
      'photo_rounds',
      'photo_submissions',
      'quiz_answers',
      'prediction_requests',
    ]) {
      expect(runtime.has(table), table).toBe(true);
    }
  });

  // Deleting a parent before its children would abort the transaction on a foreign key.
  it('deletes children before the rows they hang off', () => {
    const order = (table: string) => RUNTIME_TABLES.indexOf(table as any);
    expect(order('photo_submissions')).toBeLessThan(order('photo_rounds'));
    expect(order('pak_een_zes_draws')).toBeLessThan(order('pak_een_zes_games'));
    expect(order('pak_een_zes_predictions')).toBeLessThan(order('pak_een_zes_games'));
    expect(order('pak_een_zes_participants')).toBeLessThan(order('pak_een_zes_games'));
    expect(order('slot_spins')).toBeLessThan(order('slot_series'));
    expect(order('roulette_bets')).toBeLessThan(order('roulette_games'));
  });
});
