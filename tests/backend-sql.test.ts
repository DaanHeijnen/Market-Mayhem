import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pgliteAvailable } from './helpers/pglite';

/**
 * Every SQL statement in the backend, checked against the migrated schema.
 *
 * TypeScript cannot see inside a query string, so a renamed column or a placeholder that
 * does not match its column list compiles perfectly and fails at the moment somebody
 * presses the button. PREPARE makes Postgres parse and plan each statement without
 * running it, which catches exactly that class of mistake — and it caught several during
 * the move away from round blocks.
 */
const available = await pgliteAvailable();
const MIGRATIONS = join(__dirname, '..', 'netlify', 'database', 'migrations');

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip comments before looking for SQL.
 *
 * Without this an apostrophe in prose ("the round's own settings") opens a string as far
 * as the scanner is concerned and swallows the SQL that follows — which silently shrinks
 * the set of statements being checked, the one failure mode a checker must not have.
 */
function stripComments(text: string) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractSql(raw: string) {
  const text = stripComments(raw);
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[2];
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(body)) continue;
    // Skip the one statement built at runtime: reorderRoundContent interpolates a table
    // name from its own fixed list, never from a request.
    if (body.includes('${')) continue;
    out.push(body.replace(/\\'/g, "'").replace(/\\`/g, '`'));
  }
  return out;
}

describe.skipIf(!available)('every backend query parses against the migrated schema', () => {
  it('has no statement naming a column or table that does not exist', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }

    const failures: string[] = [];
    let checked = 0;
    for (const file of walk(join(__dirname, '..', 'netlify'))) {
      for (const sql of extractSql(readFileSync(file, 'utf8'))) {
        checked += 1;
        try {
          await db.query(`PREPARE chk_${checked} AS ${sql}`);
        } catch (error) {
          const message = String((error as Error).message);
          // Postgres cannot always infer a bare parameter's type (a lone $1 inside a
          // COALESCE, say). That is not a schema error, so it is not a failure here.
          if (/could not determine data type of parameter/i.test(message)) continue;
          failures.push(`${file}\n    ${message}\n    ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
        }
      }
    }

    await db.close();
    expect(failures.join('\n\n')).toBe('');
    // A guard on the guard: if the extractor ever stops finding statements, this test
    // would pass while checking nothing.
    expect(checked).toBeGreaterThan(400);
  }, 60_000);
});

/**
 * Every query is called with as many parameters as it has placeholders.
 *
 * A separate check from the one above, because PREPARE cannot see it: a statement with two
 * placeholders parses perfectly and then fails at *bind* time when the call site hands it
 * three. Postgres answers that with a driver error rather than an HttpError, so it reaches
 * the client as a bare "Internal server error" with nothing to go on.
 *
 * This is not hypothetical. `pak-een-zes-action` passed three parameters to a two-parameter
 * insert — a leftover from the migration that dropped round blocks — and every OPEN
 * PREDICTIONS in the product returned a 500 because of it.
 */
function countArrayItems(text: string, open: number) {
  let depth = 0;
  let items = 0;
  // Whether anything has appeared since the last top-level comma. A trailing comma before
  // the closing bracket is idiomatic here and must not count as another parameter.
  let sinceComma = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i += 1; i += 1; }
      sinceComma = true;
      continue;
    }
    if ('([{'.includes(ch)) { depth += 1; if (depth > 1) sinceComma = true; continue; }
    if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) return { items: items + (sinceComma ? 1 : 0), end: i };
      sinceComma = true;
      continue;
    }
    if (ch === ',' && depth === 1) { items += 1; sinceComma = false; continue; }
    if (!/\s/.test(ch)) sinceComma = true;
  }
  return null;
}

describe('every query is bound with the parameters it asks for', () => {
  it('has no call site passing more or fewer parameters than the statement has placeholders', () => {
    const problems: string[] = [];

    for (const file of walk(join(__dirname, '..', 'netlify'))) {
      const raw = readFileSync(file, 'utf8');
      const text = stripComments(raw);
      const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const sql = m[2];
        if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) continue;
        if (sql.includes('${')) continue;

        // The highest $n the statement mentions is how many it expects.
        const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(x => Number(x[1]));
        const expected = placeholders.length ? Math.max(...placeholders) : 0;

        // Only a call of the shape query(<sql>, [ ... ]) can be checked; a statement
        // handed a variable is left alone rather than guessed at.
        const after = text.slice(m.index + m[0].length);
        const bracket = after.match(/^\s*,\s*\[/);
        if (!bracket) {
          // No array at all: the statement must take no parameters.
          if (expected > 0 && /^\s*\)/.test(after)) {
            problems.push(`${file}: statement needs ${expected} parameter(s) but is called with none — ${sql.slice(0, 70)}`);
          }
          continue;
        }
        const counted = countArrayItems(after, bracket[0].length - 1);
        if (!counted) continue;
        if (counted.items !== expected) {
          problems.push(`${file}: statement uses $1..$${expected} but is given ${counted.items} parameter(s) — ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
