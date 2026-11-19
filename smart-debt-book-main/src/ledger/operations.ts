/** LOCK-ACCOUNT and POST (L-01 Add debt, L-02 Record payment, L-03 Add opening balance). */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { withStoreTransaction, type Tenant } from '../db/tenant';
import { AppError } from './errors';
import { idempotentWrite, type Effect, type RequestKey } from './write';

export type OperationType = 'DEBT' | 'PAYMENT' | 'OPENING_BALANCE';

export type PostInput = {
  customerId: string;
  expectedVersion: bigint;
  amountAgorot: bigint | null;     // null only for a full payment
  description: string | null;
  effectiveDate: string;           // YYYY-MM-DD, Asia/Jerusalem
  effectiveTime: string | null;    // HH:MM, never invented
  full?: boolean;
};

/** LOCK-ACCOUNT. No row: not this store, or deleted (told apart for the error code). */
export async function lockAccount(db: Db, t: Tenant, customerId: string, expectedVersion: bigint) {
  const a = await db.query<{ balance_agorot: bigint; ledger_version: bigint }>(`
    SELECT a.balance_agorot, a.ledger_version
    FROM public.customer_accounts a
    JOIN public.customers c ON c.store_id = a.store_id AND c.id = a.customer_id
    WHERE a.store_id = $1 AND a.customer_id = $2 AND c.deleted_at IS NULL
    FOR UPDATE OF a`, [t.storeId, customerId]);
  if (!a.rowCount) {
    const deleted = await db.query(`SELECT 1 FROM public.customers WHERE store_id = $1 AND id = $2 AND deleted_at IS NOT NULL`,
      [t.storeId, customerId]);
    throw new AppError(deleted.rowCount ? 'CUSTOMER_DELETED' : 'NOT_FOUND', deleted.rowCount ? { customer_id: customerId } : undefined);
  }
  const row = a.rows[0]!;
  if (row.ledger_version !== expectedVersion) {
    throw new AppError('STALE_DRAFT', { balance_agorot: row.balance_agorot.toString(), ledger_version: row.ledger_version.toString() });
  }
  return row;
}

/** POST: operation, first revision, ORIGINAL entry, account update. Runs inside an open store transaction. */
export async function post(db: Db, t: Tenant, type: OperationType, p: PostInput): Promise<Effect> {
  const account = await lockAccount(db, t, p.customerId, p.expectedVersion);
  let amount = p.amountAgorot;
  if (type === 'PAYMENT') {
    if (account.balance_agorot === 0n) throw new AppError('NOTHING_TO_PAY');
    if (p.full) amount = account.balance_agorot;
    if (amount !== null && amount > account.balance_agorot) {
      throw new AppError('OVERPAYMENT', { balance_agorot: account.balance_agorot.toString() });
    }
  }
  if (amount === null || amount <= 0n) throw new AppError('VALIDATION_FAILED', { field: 'amount_agorot', rule: 'positive' });

  const signed = type === 'PAYMENT' ? -amount : amount;
  const time = type === 'OPENING_BALANCE' ? null : p.effectiveTime;
  const opId = randomUUID();
  const revId = randomUUID();

  await db.query(`INSERT INTO public.ledger_operations
      (id, store_id, customer_id, type, amount_agorot, description, effective_date, effective_time, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [opId, t.storeId, p.customerId, type, amount.toString(), p.description, p.effectiveDate, time, t.userId]);
  await db.query(`INSERT INTO public.operation_revisions
      (id, store_id, operation_id, revision_no, customer_id, type, status, amount_agorot, description,
       effective_date, effective_time, changed_by)
    VALUES ($1, $2, $3, 1, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10)`,
    [revId, t.storeId, opId, p.customerId, type, amount.toString(), p.description, p.effectiveDate, time, t.userId]);
  await db.query(`INSERT INTO public.ledger_entries
      (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot)
    VALUES ($1, $2, $3, $4, 'ORIGINAL', $5)`, [t.storeId, opId, revId, p.customerId, signed.toString()]);
  const u = await db.query<{ balance_agorot: bigint; ledger_version: bigint }>(`UPDATE public.customer_accounts
    SET balance_agorot = balance_agorot + $3, ledger_version = ledger_version + 1
    WHERE store_id = $1 AND customer_id = $2
    RETURNING balance_agorot, ledger_version`, [t.storeId, p.customerId, signed.toString()]);

  return {
    action: 'OPERATION_CREATE', resourceType: 'ledger_operation', resourceId: opId,
    details: { type, amount_agorot: amount.toString(), customer_id: p.customerId, ...(type === 'PAYMENT' ? { full: !!p.full } : {}) },
    body: {
      operation_id: opId,
      amount_agorot: amount.toString(),
      balance_agorot: u.rows[0]!.balance_agorot.toString(),
      ledger_version: u.rows[0]!.ledger_version.toString(),
    },
  };
}

/** L-01 Add debt. */
export function addDebt(userId: string, p: PostInput, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, () => post(db, t, 'DEBT', p)));
}

/** L-02 Record payment. `full` pays exactly the locked balance. */
export function recordPayment(userId: string, p: PostInput, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, () => post(db, t, 'PAYMENT', p)));
}

/** L-03 Add opening balance to an existing customer (also used inside C-01). No time, ever. */
export function addOpeningBalance(userId: string, p: PostInput, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, () => post(db, t, 'OPENING_BALANCE', { ...p, effectiveTime: null })));
}
