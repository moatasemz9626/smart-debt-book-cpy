/** Server-only Postgres pool for the restricted runtime role sdb_app. NEVER import in browser code. */
import pg from 'pg';

// bigint (money, versions, counts) → BigInt. date → 'YYYY-MM-DD'. time → 'HH:MM:SS'. No floats, no timezone shifts.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIME, (v) => v);
// numeric must never reach money code: every money sum() is cast ::bigint in SQL. Keep it a string if one slips through.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_RUNTIME_URL;
    if (!connectionString) throw new Error('DATABASE_RUNTIME_URL is missing');
    // Small per function instance; Supabase's transaction pooler (6543) multiplexes. API contract rule B.
    pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}

export type Db = pg.PoolClient;
