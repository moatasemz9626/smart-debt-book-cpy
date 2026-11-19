/** Server-only transaction wrappers. NEVER import in browser code.
 * userId must come from a VERIFIED Supabase session (src/auth/session.ts), never from the request.
 * Context is set with set_config(..., true): transaction-local, never leaks across pooled connections.
 */
import { getPool, type Db } from './pool';
import { AppError } from '../ledger/errors';

export type Tenant = { userId: string; storeId: string };

async function inTransaction<T>(work: (db: Db) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    // API contract rule B: no request waits forever on a lock or a slow query.
    await db.query(`SET LOCAL lock_timeout = '3s'`);
    await db.query(`SET LOCAL statement_timeout = '8s'`);
    const result = await work(db);
    await db.query('COMMIT');      // deferred guards run here; a failure rejects the whole write
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

/** New-owner flows (S-03, S-04, S-09): only app.user_id. */
export function withUserTransaction<T>(userId: string, work: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(async (db) => {
    await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    return work(db);
  });
}

/** Every other operation: resolves the owner's active store in the same transaction (S-03),
 * then sets app.store_id. No store id is ever taken from the request. */
export function withStoreTransaction<T>(userId: string, work: (db: Db, tenant: Tenant) => Promise<T>): Promise<T> {
  return inTransaction(async (db) => {
    await db.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const store = await db.query<{ id: string }>(
      `SELECT id FROM public.stores WHERE owner_user_id = $1 AND deleted_at IS NULL`, [userId]);
    if (!store.rowCount) throw new AppError('NO_STORE');
    const tenant = { userId, storeId: store.rows[0]!.id };
    await db.query(`SELECT set_config('app.store_id', $1, true)`, [tenant.storeId]);
    return work(db, tenant);
  });
}
