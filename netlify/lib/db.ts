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
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
