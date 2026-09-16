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
