/** Test harness: real Supabase Auth users, the restricted sdb_app role, and the operations-doc
 * SQL as fixtures. Until LedgerService exists (plan step 5), these fixtures stand in for it.
 *
 * - `app` connects as sdb_app (no BYPASSRLS). Every business call goes through it.
 * - `admin` connects as the migration user. Only for proving triggers fire even for the owner
 *   of the tables, and for reading the truth behind RLS. Never for business writes.
 */
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';

pg.types.setTypeParser(20, (v) => BigInt(v));   // bigint (money, versions) -> BigInt, never float
pg.types.setTypeParser(1082, (v) => v);         // date -> 'YYYY-MM-DD' string, no timezone shift

export const app = new pg.Pool({ connectionString: process.env.DATABASE_RUNTIME_URL, max: 10 });
export const admin = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATION_URL, max: 3 });
afterAll(async () => { await app.end(); await admin.end(); });

export type Client = pg.PoolClient;
export type Owner = { userId: string; email: string; password: string; accessToken: string };
export type Tenant = { userId: string; storeId: string };

export class AppError extends Error {
  constructor(public code: 'STALE_DRAFT' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'NOTHING_TO_PAY'
    | 'OVERPAYMENT' | 'BALANCE_NOT_ZERO' | 'NAME_MISMATCH' | 'NOT_ACTIVE', detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
  }
}

// ---------- Supabase Auth (public API only, like the real app) ----------

const auth = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY!, 'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });

/** A brand-new real Auth user. userId comes from verifying the session, not from the sign-up body. */
export async function newOwner(): Promise<Owner> {
  const email = `owner-${randomUUID()}@test.local`;
  const password = randomUUID();
  const res = await auth('/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
  const body = await res.json() as { access_token?: string; msg?: string };
  if (!res.ok || !body.access_token) throw new Error(`signup failed: ${res.status} ${body.msg ?? ''}`);
  const user = await verifySession(body.access_token);
  return { userId: user.id, email, password, accessToken: body.access_token };
}

export async function verifySession(accessToken: string): Promise<{ id: string }> {
  const res = await auth('/user', { token: accessToken });
  if (!res.ok) throw new Error(`session not valid: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

export async function signIn(email: string, password: string) {
  const res = await auth('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

export async function refresh(refreshToken: string) {
  return auth('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) });
}

export async function logoutOthers(accessToken: string) {
  return auth('/logout?scope=others', { method: 'POST', token: accessToken });
}

// ---------- Transactions ----------

const jsonBig = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** One transaction on sdb_app with transaction-local context (set_config(..., true)). */
export async function tx<T>(ctx: { userId: string; storeId?: string | null },
  work: (c: Client) => Promise<T>, client?: Client): Promise<T> {
  const c = client ?? await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.store_id', $2, true)`,
      [ctx.userId, ctx.storeId ?? '']);
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (!client) c.release();
  }
}

export const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value, jsonBig)).digest('hex');
export const req = (body: unknown = {}) => ({ id: randomUUID(), hash: hashOf(body) });
export type Req = { id: string; hash: string };

type Effect = { action: string; resourceType: string; resourceId: string | null;
  details?: object; response: Record<string, unknown> };

/** TX-OPEN (advisory lock + receipt lookup), the operation's steps, TX-AUDIT, COMMIT. */
export async function write(t: Tenant, r: Req, steps: (c: Client) => Promise<Effect>, client?: Client) {
  return tx(t, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [t.storeId, r.id]);
    const prior = await c.query(`SELECT request_hash, response_data FROM public.audit_events
      WHERE store_id = $1 AND request_id = $2`, [t.storeId, r.id]);
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== r.hash) throw new AppError('IDEMPOTENCY_CONFLICT');
      return { replayed: true, response: prior.rows[0].response_data as Record<string, unknown> };
    }
    const e = await steps(c);
    await audit(c, t, r, e);
    return { replayed: false, response: e.response };
  }, client);
}

async function audit(c: Client, t: Tenant, r: Req, e: Effect) {
  await c.query(`INSERT INTO public.audit_events
      (store_id, request_id, request_hash, action, resource_type, resource_id, details, response_data, actor_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [t.storeId, r.id, r.hash, e.action, e.resourceType, e.resourceId,
      JSON.stringify(e.details ?? {}), JSON.stringify(e.response, jsonBig), t.userId]);
}

// ---------- Store (S-) ----------

/** S-04 Create store. Runs with only app.user_id (withUserTransaction). */
export async function createStore(owner: { userId: string }, name = 'دكان الاختبار', r = req({ name })) {
  return tx({ userId: owner.userId }, async (c) => {
    const ins = await c.query(`INSERT INTO public.stores (owner_user_id, name) VALUES ($1, btrim($2))
      ON CONFLICT (owner_user_id) WHERE deleted_at IS NULL DO NOTHING RETURNING id`, [owner.userId, name]);
    if (!ins.rowCount) {
      const existing = await c.query(`SELECT id FROM public.stores WHERE owner_user_id = $1 AND deleted_at IS NULL`, [owner.userId]);
      return { created: false, tenant: { userId: owner.userId, storeId: existing.rows[0].id as string } };
    }
    const t = { userId: owner.userId, storeId: ins.rows[0].id as string };
    await c.query(`SELECT set_config('app.store_id', $1, true)`, [t.storeId]);
    await audit(c, t, r, { action: 'STORE_CREATE', resourceType: 'store', resourceId: t.storeId, response: { store_id: t.storeId } });
    return { created: true, tenant: t };
  });
}

/** New owner + store, ready for business calls. */
export async function newTenant(name?: string): Promise<Tenant & { owner: Owner }> {
  const owner = await newOwner();
  const { tenant } = await createStore(owner, name);
  return { ...tenant, owner };
}

/** S-08 step 0: what customers still owe. */
export async function storeOwed(t: Tenant) {
  return tx(t, async (c) => (await c.query(`
    SELECT count(*) FILTER (WHERE a.balance_agorot > 0) AS customers_owing,
           coalesce(sum(a.balance_agorot), 0)::bigint AS total_owed_agorot
    FROM public.customer_accounts a
    JOIN public.customers c ON c.store_id = a.store_id AND c.id = a.customer_id
    WHERE a.store_id = $1 AND c.deleted_at IS NULL`, [t.storeId])).rows[0]);
}

/** S-08 Delete store (the OTP check is the backend's, before this). Audit row BEFORE deleted_at. */
export async function deleteStore(t: Tenant, confirmName: string, r = req({ confirmName })) {
  return tx(t, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`, [t.storeId, r.id]);
    const s = await c.query(`SELECT name FROM public.stores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [t.storeId]);
    if (!s.rowCount) throw new AppError('NOT_FOUND');
    if (s.rows[0].name !== confirmName) throw new AppError('NAME_MISMATCH');
    await audit(c, t, r, { action: 'STORE_DELETE', resourceType: 'store', resourceId: t.storeId, response: { store_id: t.storeId } });
    await c.query(`UPDATE public.stores SET deleted_at = now(), updated_at = now() WHERE id = $1`, [t.storeId]);
  });
}

/** S-09 Restore store. Runs with only app.user_id. */
export async function restoreStore(t: Tenant, r = req({ restore: t.storeId })) {
  return tx({ userId: t.userId }, async (c) => {
    const u = await c.query(`UPDATE public.stores SET deleted_at = NULL, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NOT NULL RETURNING id, name`, [t.storeId, t.userId]);
    if (!u.rowCount) throw new AppError('NOT_FOUND');
    await c.query(`SELECT set_config('app.store_id', $1, true)`, [t.storeId]);
    await audit(c, t, r, { action: 'STORE_RESTORE', resourceType: 'store', resourceId: t.storeId, response: { store_id: t.storeId } });
  });
}

// ---------- Customer (C-) ----------

/** C-01 step 2: the three rows (similar-name check is `similarNames`). */
export async function createCustomer(t: Tenant, name: string, r = req({ name })) {
  const customerId = randomUUID();
  await write(t, r, async (c) => {
    await c.query(`INSERT INTO public.customers (id, store_id) VALUES ($1, $2)`, [customerId, t.storeId]);
    await c.query(`INSERT INTO public.customer_accounts (store_id, customer_id) VALUES ($1, $2)`, [t.storeId, customerId]);
    await c.query(`INSERT INTO public.customer_names (store_id, customer_id, name, is_primary) VALUES ($1, $2, btrim($3), true)`,
      [t.storeId, customerId, name]);
    return { action: 'CUSTOMER_CREATE', resourceType: 'customer', resourceId: customerId, response: { customer_id: customerId } };
  });
  return customerId;
}

/** C-01 step 1: similar names, deleted customers included. */
export async function similarNames(t: Tenant, name: string) {
  return tx(t, async (c) => (await c.query(`
    SELECT n.customer_id, n.name, c.deleted_at,
           word_similarity(sdb_normalize_name($2), n.normalized_name) AS score
    FROM public.customer_names n
    JOIN public.customers c ON c.store_id = n.store_id AND c.id = n.customer_id
    WHERE n.store_id = $1
      AND (n.normalized_name LIKE '%' || sdb_normalize_name($2) || '%'
           OR word_similarity(sdb_normalize_name($2), n.normalized_name) >= 0.3)
    ORDER BY score DESC LIMIT 5`, [t.storeId, name])).rows);
}

/** C-04 Add alias. */
export async function addAlias(t: Tenant, customerId: string, alias: string) {
  const r = await write(t, req({ customerId, alias }), async (c) => {
    const ins = await c.query(`INSERT INTO public.customer_names (store_id, customer_id, name, is_primary)
      VALUES ($1, $2, btrim($3), false) RETURNING id`, [t.storeId, customerId, alias]);
    return { action: 'ALIAS_ADD', resourceType: 'customer_name', resourceId: ins.rows[0].id, response: { name_id: ins.rows[0].id } };
  });
  return r.response.name_id as string;
}

/** C-06 Search. */
export async function search(t: Tenant, q: string) {
  return tx(t, async (c) => (await c.query(`
    SELECT c.id, p.name AS primary_name, n.name AS matched_name, a.balance_agorot, c.deleted_at,
           CASE WHEN n.normalized_name = q.v THEN 1
                WHEN n.normalized_name LIKE q.v || '%' THEN 2
                WHEN n.normalized_name LIKE '%' || q.v || '%' THEN 3
                ELSE 4 END AS rank
    FROM (SELECT sdb_normalize_name($2) AS v) q
    JOIN public.customer_names n ON n.store_id = $1
    JOIN public.customers c ON c.store_id = n.store_id AND c.id = n.customer_id
    JOIN public.customer_names p ON p.store_id = c.store_id AND p.customer_id = c.id AND p.is_primary
    JOIN public.customer_accounts a ON a.store_id = c.store_id AND a.customer_id = c.id
    WHERE n.normalized_name LIKE '%' || q.v || '%' OR word_similarity(q.v, n.normalized_name) >= 0.3
    ORDER BY c.deleted_at NULLS FIRST, rank, word_similarity(q.v, n.normalized_name) DESC
    LIMIT 10`, [t.storeId, q])).rows);
}

/** C-07 Delete customer: only at balance 0; bumps ledger_version to kill drafts. */
export async function deleteCustomer(t: Tenant, customerId: string, expectedVersion: bigint, r = req({ del: customerId })) {
  return write(t, r, async (c) => {
    const a = await lockAccount(c, t, customerId, expectedVersion);
    if (a.balance_agorot !== 0n) throw new AppError('BALANCE_NOT_ZERO', a.balance_agorot.toString());
    await c.query(`UPDATE public.customers SET deleted_at = now(), updated_at = now() WHERE store_id = $1 AND id = $2`, [t.storeId, customerId]);
    await c.query(`UPDATE public.customer_accounts SET ledger_version = ledger_version + 1 WHERE store_id = $1 AND customer_id = $2`, [t.storeId, customerId]);
    return { action: 'CUSTOMER_DELETE', resourceType: 'customer', resourceId: customerId, response: { customer_id: customerId } };
  });
}

/** C-08 Restore customer. */
export async function restoreCustomer(t: Tenant, customerId: string, r = req({ restore: customerId })) {
  return write(t, r, async (c) => {
    await c.query(`SELECT ledger_version FROM public.customer_accounts WHERE store_id = $1 AND customer_id = $2 FOR UPDATE`, [t.storeId, customerId]);
    const u = await c.query(`UPDATE public.customers SET deleted_at = NULL, updated_at = now()
      WHERE store_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, [t.storeId, customerId]);
    if (!u.rowCount) throw new AppError('NOT_FOUND');
    await c.query(`UPDATE public.customer_accounts SET ledger_version = ledger_version + 1 WHERE store_id = $1 AND customer_id = $2`, [t.storeId, customerId]);
    return { action: 'CUSTOMER_RESTORE', resourceType: 'customer', resourceId: customerId, response: { customer_id: customerId } };
  });
}

// ---------- Ledger (L-, K-) ----------

/** LOCK-ACCOUNT. */
export async function lockAccount(c: Client, t: Tenant, customerId: string, expectedVersion: bigint) {
  const a = await c.query(`SELECT a.balance_agorot, a.ledger_version
    FROM public.customer_accounts a
    JOIN public.customers c ON c.store_id = a.store_id AND c.id = a.customer_id
    WHERE a.store_id = $1 AND a.customer_id = $2 AND c.deleted_at IS NULL
    FOR UPDATE OF a`, [t.storeId, customerId]);
  if (!a.rowCount) throw new AppError('NOT_FOUND');
  const row = a.rows[0] as { balance_agorot: bigint; ledger_version: bigint };
  if (row.ledger_version !== expectedVersion) throw new AppError('STALE_DRAFT', `${row.ledger_version} <> ${expectedVersion}`);
  return row;
}

type Post = { customerId: string; expectedVersion: bigint; amount: bigint; date: string;
  time?: string | null; description?: string | null; full?: boolean };

/** POST steps shared by L-01, L-02, L-03 (inside a write). */
async function post(c: Client, t: Tenant, type: 'DEBT' | 'PAYMENT' | 'OPENING_BALANCE', p: Post, opId: string) {
  const a = await lockAccount(c, t, p.customerId, p.expectedVersion);
  let amount = p.amount;
  if (type === 'PAYMENT') {
    if (a.balance_agorot === 0n) throw new AppError('NOTHING_TO_PAY');
    if (p.full) amount = a.balance_agorot;
    if (amount > a.balance_agorot) throw new AppError('OVERPAYMENT');
  }
  const signed = type === 'PAYMENT' ? -amount : amount;
  const time = type === 'OPENING_BALANCE' ? null : (p.time ?? null);
  const revId = randomUUID();
  await c.query(`INSERT INTO public.ledger_operations
      (id, store_id, customer_id, type, amount_agorot, description, effective_date, effective_time, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [opId, t.storeId, p.customerId, type, amount.toString(), p.description ?? null, p.date, time, t.userId]);
  await c.query(`INSERT INTO public.operation_revisions
      (id, store_id, operation_id, revision_no, customer_id, type, status, amount_agorot, description, effective_date, effective_time, changed_by)
    VALUES ($1, $2, $3, 1, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10)`,
    [revId, t.storeId, opId, p.customerId, type, amount.toString(), p.description ?? null, p.date, time, t.userId]);
  await c.query(`INSERT INTO public.ledger_entries (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot)
    VALUES ($1, $2, $3, $4, 'ORIGINAL', $5)`, [t.storeId, opId, revId, p.customerId, signed.toString()]);
  const u = await c.query(`UPDATE public.customer_accounts
    SET balance_agorot = balance_agorot + $3, ledger_version = ledger_version + 1
    WHERE store_id = $1 AND customer_id = $2 RETURNING balance_agorot, ledger_version`,
    [t.storeId, p.customerId, signed.toString()]);
  return {
    action: 'OPERATION_CREATE', resourceType: 'ledger_operation', resourceId: opId,
    details: { type, amount_agorot: amount.toString(), customer_id: p.customerId, ...(type === 'PAYMENT' ? { full: !!p.full } : {}) },
    response: { operation_id: opId, balance_agorot: u.rows[0].balance_agorot, ledger_version: u.rows[0].ledger_version },
  };
}

export const addDebt = (t: Tenant, p: Post, r = req(p), client?: Client) =>
  write(t, r, (c) => post(c, t, 'DEBT', p, randomUUID()), client);
export const recordPayment = (t: Tenant, p: Post, r = req(p), client?: Client) =>
  write(t, r, (c) => post(c, t, 'PAYMENT', p, randomUUID()), client);
export const addOpening = (t: Tenant, p: Post, r = req(p)) =>
  write(t, r, (c) => post(c, t, 'OPENING_BALANCE', p, randomUUID()));

/** FIND-LIVE-ENTRY. */
async function liveEntry(c: Client, t: Tenant, operationId: string) {
  const e = await c.query(`SELECT e.id, e.signed_amount_agorot FROM public.ledger_entries e
    WHERE e.store_id = $1 AND e.operation_id = $2 AND e.kind <> 'REVERSAL'
      AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.store_id = e.store_id AND r.reverses_entry_id = e.id)`,
    [t.storeId, operationId]);
  if (e.rowCount !== 1) throw new Error(`expected one live entry, found ${e.rowCount}`);
  return e.rows[0] as { id: string; signed_amount_agorot: bigint };
}

async function lockOperation(c: Client, t: Tenant, operationId: string) {
  const o = await c.query(`SELECT * FROM public.ledger_operations WHERE store_id = $1 AND id = $2 FOR UPDATE`, [t.storeId, operationId]);
  if (!o.rowCount) throw new AppError('NOT_FOUND');
  return o.rows[0];
}

async function newRevision(c: Client, t: Tenant, op: any, status: 'ACTIVE' | 'CANCELLED', reason: string) {
  const revId = randomUUID();
  await c.query(`INSERT INTO public.operation_revisions
      (id, store_id, operation_id, revision_no, customer_id, type, status, amount_agorot, description,
       effective_date, effective_time, change_reason, changed_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [revId, t.storeId, op.id, op.revision_no, op.customer_id, op.type, status, op.amount_agorot.toString(),
      op.description, op.effective_date, op.effective_time, reason, t.userId]);
  return revId;
}

/** K-01 Edit saved operation. */
export async function editOperation(t: Tenant, operationId: string, expectedVersion: bigint,
  change: { amount?: bigint; date?: string; description?: string | null }, reason = 'تصحيح', r = req({ operationId, change: String(change.amount ?? '') + (change.date ?? '') + (change.description ?? ''), reason })) {
  return write(t, r, async (c) => {
    const op = await lockOperation(c, t, operationId);
    if (op.status !== 'ACTIVE') throw new AppError('NOT_ACTIVE');
    await lockAccount(c, t, op.customer_id, expectedVersion);
    const amount: bigint = change.amount ?? op.amount_agorot;
    const u = await c.query(`UPDATE public.ledger_operations
      SET amount_agorot = $3, effective_date = $4, description = $5, revision_no = revision_no + 1
      WHERE store_id = $1 AND id = $2 RETURNING *`,
      [t.storeId, operationId, amount.toString(), change.date ?? op.effective_date,
        change.description === undefined ? op.description : change.description]);
    const updated = u.rows[0];
    const revId = await newRevision(c, t, updated, 'ACTIVE', reason);
    let delta = 0n;
    if (amount !== op.amount_agorot) {
      const live = await liveEntry(c, t, operationId);
      const newSigned = op.type === 'PAYMENT' ? -amount : amount;
      await c.query(`INSERT INTO public.ledger_entries
          (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot, reverses_entry_id)
        VALUES ($1, $2, $3, $4, 'REVERSAL', $5, $6), ($1, $2, $3, $4, 'CORRECTION', $7, NULL)`,
        [t.storeId, operationId, revId, op.customer_id, (-live.signed_amount_agorot).toString(), live.id, newSigned.toString()]);
      delta = newSigned - live.signed_amount_agorot;
    }
    const a = await c.query(`UPDATE public.customer_accounts
      SET balance_agorot = balance_agorot + $3, ledger_version = ledger_version + 1
      WHERE store_id = $1 AND customer_id = $2 RETURNING balance_agorot, ledger_version`,
      [t.storeId, op.customer_id, delta.toString()]);
    return { action: 'OPERATION_EDIT', resourceType: 'ledger_operation', resourceId: operationId,
      details: { reason }, response: { operation_id: operationId, ...a.rows[0] } };
  });
}

/** K-02 Cancel saved operation. */
export async function cancelOperation(t: Tenant, operationId: string, expectedVersion: bigint, reason = 'إلغاء', r = req({ cancel: operationId, reason })) {
  return write(t, r, async (c) => {
    const op = await lockOperation(c, t, operationId);
    if (op.status !== 'ACTIVE') throw new AppError('NOT_ACTIVE');
    await lockAccount(c, t, op.customer_id, expectedVersion);
    const u = await c.query(`UPDATE public.ledger_operations SET status = 'CANCELLED', revision_no = revision_no + 1
      WHERE store_id = $1 AND id = $2 RETURNING *`, [t.storeId, operationId]);
    const revId = await newRevision(c, t, u.rows[0], 'CANCELLED', reason);
    const live = await liveEntry(c, t, operationId);
    await c.query(`INSERT INTO public.ledger_entries
        (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot, reverses_entry_id)
      VALUES ($1, $2, $3, $4, 'REVERSAL', $5, $6)`,
      [t.storeId, operationId, revId, op.customer_id, (-live.signed_amount_agorot).toString(), live.id]);
    const a = await c.query(`UPDATE public.customer_accounts
      SET balance_agorot = balance_agorot - $3, ledger_version = ledger_version + 1
      WHERE store_id = $1 AND customer_id = $2 RETURNING balance_agorot, ledger_version`,
      [t.storeId, op.customer_id, live.signed_amount_agorot.toString()]);
    return { action: 'OPERATION_CANCEL', resourceType: 'ledger_operation', resourceId: operationId,
      details: { reason }, response: { operation_id: operationId, ...a.rows[0] } };
  });
}

// ---------- Reads (R-) ----------

export async function account(t: Tenant, customerId: string) {
  return tx(t, async (c) => (await c.query(`SELECT balance_agorot, ledger_version FROM public.customer_accounts
    WHERE store_id = $1 AND customer_id = $2`, [t.storeId, customerId])).rows[0] as
    { balance_agorot: bigint; ledger_version: bigint } | undefined);
}

/** R-01 Dashboard totals. */
export async function dashboard(t: Tenant) {
  return tx(t, async (c) => {
    const totals = (await c.query(`SELECT coalesce(sum(a.balance_agorot), 0)::bigint AS total_debt_agorot,
        count(*) FILTER (WHERE a.balance_agorot > 0) AS debtors
      FROM public.customer_accounts a JOIN public.customers c ON c.store_id = a.store_id AND c.id = a.customer_id
      WHERE a.store_id = $1 AND c.deleted_at IS NULL`, [t.storeId])).rows[0];
    const collected = (await c.query(`SELECT coalesce(sum(amount_agorot), 0)::bigint AS collected_agorot
      FROM public.ledger_operations
      WHERE store_id = $1 AND type = 'PAYMENT' AND status = 'ACTIVE'
        AND effective_date >= date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem')::date
        AND effective_date <  (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') + interval '1 month')::date`,
      [t.storeId])).rows[0];
    return { ...totals, ...collected } as { total_debt_agorot: bigint; debtors: bigint; collected_agorot: bigint };
  });
}

/** R-02 Customer list. */
export async function customerList(t: Tenant, filter: 'all' | 'debtors' = 'all') {
  return tx(t, async (c) => (await c.query(`SELECT c.id, p.name, a.balance_agorot, a.ledger_version
    FROM public.customers c
    JOIN public.customer_accounts a ON a.store_id = c.store_id AND a.customer_id = c.id
    JOIN public.customer_names p ON p.store_id = c.store_id AND p.customer_id = c.id AND p.is_primary
    WHERE c.store_id = $1 AND c.deleted_at IS NULL AND ($2 = 'all' OR a.balance_agorot > 0)
    ORDER BY p.normalized_name, c.id`, [t.storeId, filter])).rows);
}

/** R-04 Statement. */
export async function statement(t: Tenant, customerId: string) {
  return tx(t, async (c) => (await c.query(`SELECT effective_date, type, amount_agorot,
      -- ::bigint is not in the operations doc: sum(bigint) is numeric, which pg returns as a string
      (sum(CASE WHEN type = 'PAYMENT' THEN -amount_agorot ELSE amount_agorot END)
        OVER (ORDER BY effective_date, effective_time NULLS LAST, created_at, id))::bigint AS running_agorot
    FROM public.ledger_operations
    WHERE store_id = $1 AND customer_id = $2 AND status = 'ACTIVE'
    ORDER BY effective_date, effective_time NULLS LAST, created_at, id`, [t.storeId, customerId])).rows);
}

/** R-06 Look up a request. */
export async function lookupRequest(t: Tenant, requestId: string) {
  return tx(t, async (c) => (await c.query(`SELECT action, resource_id, response_data, created_at
    FROM public.audit_events WHERE store_id = $1 AND request_id = $2`, [t.storeId, requestId])).rows[0]);
}

/** Today's date in Asia/Jerusalem, and days relative to it. */
export function day(offset = 0) {
  const now = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}

// ---------- Raw writes for "must be rejected" tests ----------

/** Operation + first revision only (no entry, no account change). For tests that break the rules on purpose. */
export async function rawOperation(c: Client, t: Tenant, customerId: string,
  { amount, type = 'DEBT', date = day() }: { amount: bigint; type?: 'DEBT' | 'PAYMENT'; date?: string }) {
  const opId = randomUUID(); const revId = randomUUID();
  await c.query(`INSERT INTO public.ledger_operations (id, store_id, customer_id, type, amount_agorot, effective_date, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [opId, t.storeId, customerId, type, amount.toString(), date, t.userId]);
  await c.query(`INSERT INTO public.operation_revisions
      (id, store_id, operation_id, revision_no, customer_id, type, status, amount_agorot, effective_date, changed_by)
    VALUES ($1, $2, $3, 1, $4, $5, 'ACTIVE', $6, $7, $8)`, [revId, t.storeId, opId, customerId, type, amount.toString(), date, t.userId]);
  return { opId, revId };
}

export async function rawEntry(c: Client, t: Tenant, e: { opId: string; revId: string; customerId: string;
  kind?: string; signed: bigint; reverses?: string | null }) {
  await c.query(`INSERT INTO public.ledger_entries
      (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot, reverses_entry_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.storeId, e.opId, e.revId, e.customerId, e.kind ?? 'ORIGINAL', e.signed.toString(), e.reverses ?? null]);
}

/** Every row the DB holds for one operation, read through RLS. */
export async function operationRows(t: Tenant, opId: string) {
  return tx(t, async (c) => ({
    op: (await c.query(`SELECT * FROM public.ledger_operations WHERE store_id = $1 AND id = $2`, [t.storeId, opId])).rows[0],
    revisions: (await c.query(`SELECT * FROM public.operation_revisions WHERE store_id = $1 AND operation_id = $2 ORDER BY revision_no`, [t.storeId, opId])).rows,
    entries: (await c.query(`SELECT * FROM public.ledger_entries WHERE store_id = $1 AND operation_id = $2 ORDER BY created_at, kind`, [t.storeId, opId])).rows,
  }));
}
