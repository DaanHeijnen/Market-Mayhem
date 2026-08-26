import { getConnectionString, getDatabase } from '@netlify/database';
import pg from 'pg';
import type { PoolClient } from 'pg';

let pool: pg.Pool | undefined;

export function database() {
  const db = getDatabase();

  if (!pool) {
    pool = new pg.Pool({
      connectionString: getConnectionString(),
      max: 5,
      // Netlify Database (Neon) bills compute for as long as its endpoint is active, and
      // an open connection keeps it active — so idle connections cost money even when no
      // query is running. Releasing them promptly is what lets the endpoint suspend
      // between rounds. Not shorter than this: each reconnect pays connection latency,
      // and on a suspended endpoint it also pays the wake-up.
      idleTimeoutMillis: 10_000,
      // Let a warm function container exit without waiting on the pool.
      allowExitOnIdle: true,
      // Fail fast rather than hanging the whole invocation on a bad connect.
      connectionTimeoutMillis: 10_000,
    });
  }

  return {
    sql: db.sql,
    pool,
  };
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original transaction error if the connection is already broken.
    }
    throw error;
  } finally {
    client.release();
  }
}
