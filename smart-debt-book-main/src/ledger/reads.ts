/** Reads: R-01 … R-06 and C-06 Search. Only the tenant context: no lock, no audit. */
import { withStoreTransaction } from '../db/tenant';
import { loadCustomer } from './customer-dto';
import { AppError } from './errors';
import { iso } from './write';

export const PAGE_SIZE = 50;

/** Opaque keyset cursors: base64url JSON of the sort key of the last row. */
const encodeCursor = (c: string[]) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string, length: number): string[] {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(c) && c.length === length && c.every((x) => typeof x === 'string')) return c;
  } catch { /* fall through */ }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor', rule: 'opaque cursor from the previous page' });
}

/** R-01 Dashboard: total owed, debtors, collected this month (Asia/Jerusalem), last 5 operations. */
export function dashboard(userId: string) {
  return withStoreTransaction(userId, async (db, t) => {
    const totals = await db.query(`
      SELECT coalesce(sum(a.balance_agorot), 0)::bigint::text AS total_debt_agorot,
             count(*) FILTER (WHERE a.balance_agorot > 0)::int AS debtors
      FROM public.customer_accounts a
      JOIN public.customers c ON c.store_id = a.store_id AND c.id = a.customer_id
      WHERE a.store_id = $1 AND c.deleted_at IS NULL`, [t.storeId]);
    const collected = await db.query(`
      SELECT coalesce(sum(amount_agorot), 0)::bigint::text AS collected
      FROM public.ledger_operations
      WHERE store_id = $1 AND type = 'PAYMENT' AND status = 'ACTIVE'
        AND effective_date >= date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem')::date
        AND effective_date <  (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') + interval '1 month')::date`,
      [t.storeId]);
    const recent = await db.query(`
      SELECT o.id, o.customer_id, o.type, o.status, o.amount_agorot::text AS amount_agorot, n.name AS customer_name,
             o.effective_date, ${iso('o.created_at')} AS created_at
      FROM public.ledger_operations o
      JOIN public.customer_names n ON n.store_id = o.store_id AND n.customer_id = o.customer_id AND n.is_primary
      WHERE o.store_id = $1 AND o.type <> 'MERGE_TRANSFER'
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 5`, [t.storeId]);
    return {
      total_debt_agorot: totals.rows[0].total_debt_agorot,
      debtors: totals.rows[0].debtors,
      collected_this_month_agorot: collected.rows[0].collected,
      recent: recent.rows,
    };
  });
}

/** R-02 Customer list. Default: debtors, biggest debt first. Deleted customers never listed. */
export function customerList(userId: string, filter: 'debtors' | 'all', sort: 'debt' | 'name') {
  return withStoreTransaction(userId, async (db, t) => {
    const r = await db.query(`
      SELECT c.id, p.name AS primary_name, a.balance_agorot::text AS balance_agorot, a.ledger_version::text AS ledger_version
      FROM public.customers c
      JOIN public.customer_accounts a ON a.store_id = c.store_id AND a.customer_id = c.id
      JOIN public.customer_names p ON p.store_id = c.store_id AND p.customer_id = c.id AND p.is_primary
      WHERE c.store_id = $1 AND c.deleted_at IS NULL
        AND ($2 = 'all' OR a.balance_agorot > 0)
      ORDER BY CASE WHEN $3 = 'debt' THEN a.balance_agorot END DESC, p.normalized_name, c.id`,
      [t.storeId, filter, sort]);
    return { customers: r.rows };
  });
}

/** C-06 Search: deleted customers come last, marked, so the owner can restore them. Max 10. */
export function searchCustomers(userId: string, q: string) {
  return withStoreTransaction(userId, async (db, t) => {
    const r = await db.query(`
      SELECT DISTINCT ON (c.id) c.id, p.name AS primary_name, n.name AS matched_name,
             a.balance_agorot::text AS balance_agorot, ${iso('c.deleted_at')} AS deleted_at, c.deleted_at AS d,
             CASE WHEN n.normalized_name = q.v THEN 1
                  WHEN n.normalized_name LIKE q.v || '%' THEN 2
                  WHEN n.normalized_name LIKE '%' || q.v || '%' THEN 3
                  ELSE 4 END AS rank,
             word_similarity(q.v, n.normalized_name) AS sim
      FROM (SELECT public.sdb_normalize_name($2) AS v) q
      JOIN public.customer_names n ON n.store_id = $1
      JOIN public.customers c ON c.store_id = n.store_id AND c.id = n.customer_id
      JOIN public.customer_names p ON p.store_id = c.store_id AND p.customer_id = c.id AND p.is_primary
      JOIN public.customer_accounts a ON a.store_id = c.store_id AND a.customer_id = c.id
      WHERE n.normalized_name LIKE '%' || q.v || '%' OR word_similarity(q.v, n.normalized_name) >= 0.3
      ORDER BY c.id, rank, sim DESC`, [t.storeId, q]);
    // One row per customer (its best-matching name), then the doc's order.
    const rows = r.rows
      .sort((x, y) => (x.d === null ? 0 : 1) - (y.d === null ? 0 : 1) || x.rank - y.rank || y.sim - x.sim)
      .slice(0, 10)
      .map(({ d: _d, sim: _s, ...row }) => row);
    return { results: rows };
  });
}

/** R-03 Customer page: header + one page of operations, newest effective date first. Cancelled stay, marked.
 * The operations doc's cursor leaves out effective_time while ORDER BY uses it; here sort key = cursor key.
 * NULL time sorts first in DESC, as '24:00' (the largest time). */
export function customerPage(userId: string, customerId: string, cursor: string | null) {
  return withStoreTransaction(userId, async (db, t) => {
    const customer = await loadCustomer(db, t, customerId);
    const after = cursor ? decodeCursor(cursor, 4) : null;
    const ops = await db.query(`
      SELECT id, type, status, amount_agorot::text AS amount_agorot, description,
             effective_date, to_char(effective_time, 'HH24:MI') AS effective_time, revision_no,
             ${iso('created_at')} AS created_at,
             coalesce(effective_time, time '24:00')::text AS sort_time
      FROM public.ledger_operations
      WHERE store_id = $1 AND customer_id = $2 AND type <> 'MERGE_TRANSFER'
        AND ($3::date IS NULL OR (effective_date, coalesce(effective_time, time '24:00'), created_at, id)
                                  < ($3::date, $4::time, $5::timestamptz, $6::uuid))
      ORDER BY effective_date DESC, coalesce(effective_time, time '24:00') DESC, created_at DESC, id DESC
      LIMIT ${PAGE_SIZE + 1}`,
      [t.storeId, customerId, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, after?.[3] ?? null]);
    const page = ops.rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      customer,
      operations: page.map(({ sort_time: _s, ...op }) => op),
      next_cursor: ops.rows.length > PAGE_SIZE && last
        ? encodeCursor([last.effective_date, last.sort_time, last.created_at, last.id]) : null,
    };
  });
}

/** R-04 Statement: active operations, oldest first, with a running balance (cast ::bigint, not in the doc). */
export function statement(userId: string, customerId: string) {
  return withStoreTransaction(userId, async (db, t) => {
    const customer = await loadCustomer(db, t, customerId);
    const store = await db.query<{ name: string }>(`SELECT name FROM public.stores WHERE id = $1`, [t.storeId]);
    const rows = await db.query(`
      SELECT effective_date, to_char(effective_time, 'HH24:MI') AS effective_time, type,
             amount_agorot::text AS amount_agorot, description,
             (sum(CASE WHEN type = 'PAYMENT' THEN -amount_agorot ELSE amount_agorot END)
                OVER (ORDER BY effective_date, effective_time NULLS LAST, created_at, id))::bigint::text AS running_agorot
      FROM public.ledger_operations
      WHERE store_id = $1 AND customer_id = $2 AND status = 'ACTIVE'
      ORDER BY effective_date, effective_time NULLS LAST, created_at, id`, [t.storeId, customerId]);
    return {
      store_name: store.rows[0]!.name, customer_name: customer.primary_name,
      rows: rows.rows, balance_agorot: customer.balance_agorot,
    };
  });
}

/** R-05 Activity log: entry time, newest first. from/to are Asia/Jerusalem dates (to is exclusive).
 * customerId (optional) narrows it to one customer, picked with C-06 Search (FR-12 "search by name"). */
export function activity(userId: string, from: string | null, to: string | null, cursor: string | null, customerId: string | null = null) {
  return withStoreTransaction(userId, async (db, t) => {
    const after = cursor ? decodeCursor(cursor, 2) : null;
    const r = await db.query(`
      SELECT o.id, o.customer_id, ${iso('o.created_at')} AS created_at, n.name AS customer_name, o.type, o.status,
             o.amount_agorot::text AS amount_agorot, o.effective_date
      FROM public.ledger_operations o
      JOIN public.customer_names n ON n.store_id = o.store_id AND n.customer_id = o.customer_id AND n.is_primary
      WHERE o.store_id = $1 AND o.type <> 'MERGE_TRANSFER'
        AND ($2::date IS NULL OR o.created_at >= ($2::date)::timestamp AT TIME ZONE 'Asia/Jerusalem')
        AND ($3::date IS NULL OR o.created_at <  ($3::date)::timestamp AT TIME ZONE 'Asia/Jerusalem')
        AND ($4::timestamptz IS NULL OR (o.created_at, o.id) < ($4::timestamptz, $5::uuid))
        AND ($6::uuid IS NULL OR o.customer_id = $6::uuid)
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${PAGE_SIZE + 1}`, [t.storeId, from, to, after?.[0] ?? null, after?.[1] ?? null, customerId]);
    const page = r.rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return { items: page, next_cursor: r.rows.length > PAGE_SIZE && last ? encodeCursor([last.created_at, last.id]) : null };
  });
}

/** R-06: was this Idempotency-Key saved? No row: not saved, safe to retry with the same key. */
export function lookupRequest(userId: string, requestId: string) {
  return withStoreTransaction(userId, async (db, t) => {
    const r = await db.query(`SELECT action, resource_id, response_data AS response, ${iso('created_at')} AS created_at
      FROM public.audit_events WHERE store_id = $1 AND request_id = $2`, [t.storeId, requestId]);
    if (!r.rowCount) throw new AppError('REQUEST_NOT_FOUND');
    return r.rows[0];
  });
}
