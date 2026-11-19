/** TX-OPEN (advisory lock + receipt lookup) and TX-AUDIT from the operations doc. */
import type { Db } from '../db/pool';
import type { Tenant } from '../db/tenant';
import { AppError } from './errors';

/** request_id = the Idempotency-Key header; hash = sha256 the API layer computed from method, path and body. */
export type RequestKey = { id: string; hash: string };

/** The JSON body the API returns. Money and versions are already strings (API contract rule A). */
export type Body = Record<string, unknown>;

export type Effect = {
  action: string; resourceType: string; resourceId: string | null;
  details?: Record<string, unknown>; body: Body;
};

export type WriteResult = { replayed: boolean; body: Body };

/** Idempotent write inside an open store transaction. The saved response_data is the API body,
 * so a replay (same key, same hash) returns exactly what the first call returned. */
export async function idempotentWrite(db: Db, t: Tenant, key: RequestKey,
  steps: () => Promise<Effect>): Promise<WriteResult> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [t.storeId, key.id]);
  const prior = await db.query<{ request_hash: string; response_data: Body }>(
    `SELECT request_hash, response_data FROM public.audit_events WHERE store_id = $1 AND request_id = $2`,
    [t.storeId, key.id]);
  if (prior.rowCount) {
    if (prior.rows[0]!.request_hash !== key.hash) throw new AppError('IDEMPOTENCY_CONFLICT');
    return { replayed: true, body: prior.rows[0]!.response_data };
  }
  const effect = await steps();
  await writeAudit(db, t, key, effect);
  return { replayed: false, body: effect.body };
}

export async function writeAudit(db: Db, t: Tenant, key: RequestKey, e: Effect) {
  await db.query(`INSERT INTO public.audit_events
      (store_id, request_id, request_hash, action, resource_type, resource_id, details, response_data, actor_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [t.storeId, key.id, key.hash, e.action, e.resourceType, e.resourceId,
      JSON.stringify(e.details ?? {}, bigintToString), JSON.stringify(e.body, bigintToString), t.userId]);
}

export const bigintToString = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** Timestamps leave the DB as ISO 8601 UTC with microseconds, so cursors stay exact. */
export const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
