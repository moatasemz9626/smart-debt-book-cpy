/** S-03 Resolve · S-04 Create · S-06 Rename · S-08a Delete preview · S-09 Restore.
 * S-08 Delete waits for the fresh-OTP decision (docs/API_CONTRACT.md, open item 2). */
import { withStoreTransaction, withUserTransaction } from '../db/tenant';
import { AppError } from './errors';
import { idempotentWrite, iso, writeAudit, type Body, type RequestKey } from './write';

export type StoreDto = { id: string; name: string; timezone: string; deleted_at: string | null };

const STORE_COLUMNS = `id, name, timezone, ${iso('deleted_at')} AS deleted_at`;

/** S-03: the active store, and a deleted one to offer back (S-09). */
export async function getMyStore(userId: string) {
  return withUserTransaction(userId, async (db) => {
    const r = await db.query<StoreDto>(`SELECT ${STORE_COLUMNS} FROM public.stores
      WHERE owner_user_id = $1 ORDER BY deleted_at NULLS FIRST, updated_at DESC`, [userId]);
    return {
      store: r.rows.find((s) => s.deleted_at === null) ?? null,
      deleted_store: r.rows.find((s) => s.deleted_at !== null) ?? null,
    };
  });
}

/** S-04: one active store per owner. If one exists, return it (created: false). */
export async function createStore(userId: string, name: string, key: RequestKey) {
  return withUserTransaction(userId, async (db) => {
    const ins = await db.query<StoreDto>(`INSERT INTO public.stores (owner_user_id, name) VALUES ($1, btrim($2))
      ON CONFLICT (owner_user_id) WHERE deleted_at IS NULL DO NOTHING
      RETURNING ${STORE_COLUMNS}`, [userId, name]);
    if (!ins.rowCount) {
      const existing = await db.query<StoreDto>(`SELECT ${STORE_COLUMNS} FROM public.stores
        WHERE owner_user_id = $1 AND deleted_at IS NULL`, [userId]);
      return { created: false, store: existing.rows[0]! };
    }
    const store = ins.rows[0]!;
    const t = { userId, storeId: store.id };
    await db.query(`SELECT set_config('app.store_id', $1, true)`, [store.id]);
    await writeAudit(db, t, key, { action: 'STORE_CREATE', resourceType: 'store', resourceId: store.id, body: { store } });
    return { created: true, store };
  });
}

/** S-06 Rename store. */
export function renameStore(userId: string, name: string, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    const u = await db.query<StoreDto>(`UPDATE public.stores SET name = btrim($2), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING ${STORE_COLUMNS}`, [t.storeId, name]);
    return { action: 'STORE_RENAME', resourceType: 'store', resourceId: t.storeId, details: { name: u.rows[0]!.name },
      body: { store: u.rows[0]! } };
  }));
}

/** S-08 step 0: what customers still owe, shown before the owner confirms a store delete. */
export function deletePreview(userId: string) {
  return withStoreTransaction(userId, async (db, t) => {
    const r = await db.query(`
      SELECT count(*) FILTER (WHERE a.balance_agorot > 0)::int AS customers_owing,
             coalesce(sum(a.balance_agorot), 0)::bigint::text AS total_owed_agorot
      FROM public.customer_accounts a
      JOIN public.customers c ON c.store_id = a.store_id AND c.id = a.customer_id
      WHERE a.store_id = $1 AND c.deleted_at IS NULL`, [t.storeId]);
    return r.rows[0] as { customers_owing: number; total_owed_agorot: string };
  });
}

/** S-09 Restore store. Runs with only app.user_id: the deleted store's rows are hidden until it is back.
 * Fails with ACTIVE_STORE_EXISTS if the owner opened a new store since (partial unique index).
 * A retry after COMMIT finds nothing to restore, so it looks up its own receipt and replays it. */
export function restoreStore(userId: string, storeId: string, key: RequestKey) {
  return withUserTransaction(userId, async (db) => {
    const u = await db.query<StoreDto>(`UPDATE public.stores SET deleted_at = NULL, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NOT NULL
      RETURNING ${STORE_COLUMNS}`, [storeId, userId]);
    const owned = await db.query(`SELECT 1 FROM public.stores WHERE id = $1 AND owner_user_id = $2`, [storeId, userId]);
    if (!owned.rowCount) throw new AppError('NOT_FOUND');
    await db.query(`SELECT set_config('app.store_id', $1, true)`, [storeId]);
    const t = { userId, storeId };
    if (!u.rowCount) {
      const prior = await db.query<{ request_hash: string; response_data: Body }>(`SELECT request_hash, response_data
        FROM public.audit_events WHERE store_id = $1 AND request_id = $2`, [storeId, key.id]);
      if (!prior.rowCount) throw new AppError('NOT_FOUND', { reason: 'store is not deleted' });
      if (prior.rows[0]!.request_hash !== key.hash) throw new AppError('IDEMPOTENCY_CONFLICT');
      return { replayed: true, body: prior.rows[0]!.response_data };
    }
    const body = { store: u.rows[0]! };
    await writeAudit(db, t, key, { action: 'STORE_RESTORE', resourceType: 'store', resourceId: storeId, body });
    return { replayed: false, body };
  });
}
