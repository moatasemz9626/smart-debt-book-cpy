/** K-01 Edit saved operation · K-02 Cancel saved operation.
 * Saved entries are never edited and operations are never deleted. An amount change reverses the
 * entry in force and adds a CORRECTION; a cancel only reverses it. Every correction writes a new
 * revision and raises ledger_version. The historical-balance guard checks it all at COMMIT. */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { withStoreTransaction, type Tenant } from '../db/tenant';
import { AppError } from './errors';
import { lockAccount } from './operations';
import { idempotentWrite, type RequestKey } from './write';

type OperationRow = {
  id: string; customer_id: string; type: string; status: string; amount_agorot: bigint;
  description: string | null; effective_date: string; effective_time: string | null; revision_no: number;
};

export type EditInput = {
  expectedVersion: bigint;
  amountAgorot?: bigint;
  effectiveDate?: string;
  description?: string | null;      // undefined: unchanged · null: cleared
  reason: string;
};

async function lockOperation(db: Db, t: Tenant, operationId: string): Promise<OperationRow> {
  const o = await db.query<OperationRow>(`SELECT id, customer_id, type, status, amount_agorot, description,
      effective_date, effective_time, revision_no
    FROM public.ledger_operations WHERE store_id = $1 AND id = $2 FOR UPDATE`, [t.storeId, operationId]);
  if (!o.rowCount) throw new AppError('NOT_FOUND');
  const op = o.rows[0]!;
  if (op.status !== 'ACTIVE') throw new AppError('OPERATION_NOT_ACTIVE', { status: op.status });
  return op;
}

/** FIND-LIVE-ENTRY: the entry still in force for an operation. */
async function liveEntry(db: Db, t: Tenant, operationId: string) {
  const e = await db.query<{ id: string; signed_amount_agorot: bigint }>(`
    SELECT e.id, e.signed_amount_agorot FROM public.ledger_entries e
    WHERE e.store_id = $1 AND e.operation_id = $2 AND e.kind <> 'REVERSAL'
      AND NOT EXISTS (SELECT 1 FROM public.ledger_entries r WHERE r.store_id = e.store_id AND r.reverses_entry_id = e.id)`,
    [t.storeId, operationId]);
  if (e.rowCount !== 1) throw new Error(`operation ${operationId}: expected one live entry, found ${e.rowCount}`);
  return e.rows[0]!;
}

/** The revision snapshot of the operation as it now stands. */
async function writeRevision(db: Db, t: Tenant, op: OperationRow, reason: string) {
  const revId = randomUUID();
  await db.query(`INSERT INTO public.operation_revisions
      (id, store_id, operation_id, revision_no, customer_id, type, status, amount_agorot, description,
       effective_date, effective_time, change_reason, changed_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [revId, t.storeId, op.id, op.revision_no, op.customer_id, op.type, op.status, op.amount_agorot.toString(),
      op.description, op.effective_date, op.effective_time, reason, t.userId]);
  return revId;
}

const snapshot = (op: OperationRow) => ({
  amount_agorot: op.amount_agorot.toString(), effective_date: op.effective_date, description: op.description,
});

/** K-01 Edit saved operation (amount, date, description). Time is never changed or invented. */
export function editOperation(userId: string, operationId: string, input: EditInput, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    const before = await lockOperation(db, t, operationId);
    await lockAccount(db, t, before.customer_id, input.expectedVersion);

    const u = await db.query<OperationRow>(`UPDATE public.ledger_operations
      SET amount_agorot = $3, effective_date = $4, description = $5, revision_no = revision_no + 1
      WHERE store_id = $1 AND id = $2
      RETURNING id, customer_id, type, status, amount_agorot, description, effective_date, effective_time, revision_no`,
      [t.storeId, operationId, (input.amountAgorot ?? before.amount_agorot).toString(),
        input.effectiveDate ?? before.effective_date,
        input.description === undefined ? before.description : input.description]);
    const after = u.rows[0]!;
    const revId = await writeRevision(db, t, after, input.reason);

    let delta = 0n;
    if (after.amount_agorot !== before.amount_agorot) {
      const live = await liveEntry(db, t, operationId);
      const newSigned = after.type === 'PAYMENT' ? -after.amount_agorot : after.amount_agorot;
      await db.query(`INSERT INTO public.ledger_entries
          (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot, reverses_entry_id)
        VALUES ($1, $2, $3, $4, 'REVERSAL', $5, $6), ($1, $2, $3, $4, 'CORRECTION', $7, NULL)`,
        [t.storeId, operationId, revId, after.customer_id, (-live.signed_amount_agorot).toString(), live.id, newSigned.toString()]);
      delta = newSigned - live.signed_amount_agorot;
    }
    const a = await db.query<{ balance_agorot: bigint; ledger_version: bigint }>(`UPDATE public.customer_accounts
      SET balance_agorot = balance_agorot + $3, ledger_version = ledger_version + 1
      WHERE store_id = $1 AND customer_id = $2 RETURNING balance_agorot, ledger_version`,
      [t.storeId, after.customer_id, delta.toString()]);

    return {
      action: 'OPERATION_EDIT', resourceType: 'ledger_operation', resourceId: operationId,
      details: { before: snapshot(before), after: snapshot(after), reason: input.reason },
      body: { operation_id: operationId, balance_agorot: a.rows[0]!.balance_agorot.toString(),
        ledger_version: a.rows[0]!.ledger_version.toString() },
    };
  }));
}

/** K-02 Cancel saved operation: reverses its money, keeps the history. */
export function cancelOperation(userId: string, operationId: string, input: { expectedVersion: bigint; reason: string }, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    const op = await lockOperation(db, t, operationId);
    await lockAccount(db, t, op.customer_id, input.expectedVersion);
    const u = await db.query<OperationRow>(`UPDATE public.ledger_operations
      SET status = 'CANCELLED', revision_no = revision_no + 1
      WHERE store_id = $1 AND id = $2
      RETURNING id, customer_id, type, status, amount_agorot, description, effective_date, effective_time, revision_no`,
      [t.storeId, operationId]);
    const revId = await writeRevision(db, t, u.rows[0]!, input.reason);
    const live = await liveEntry(db, t, operationId);
    await db.query(`INSERT INTO public.ledger_entries
        (store_id, operation_id, revision_id, customer_id, kind, signed_amount_agorot, reverses_entry_id)
      VALUES ($1, $2, $3, $4, 'REVERSAL', $5, $6)`,
      [t.storeId, operationId, revId, op.customer_id, (-live.signed_amount_agorot).toString(), live.id]);
    const a = await db.query<{ balance_agorot: bigint; ledger_version: bigint }>(`UPDATE public.customer_accounts
      SET balance_agorot = balance_agorot - $3, ledger_version = ledger_version + 1
      WHERE store_id = $1 AND customer_id = $2 RETURNING balance_agorot, ledger_version`,
      [t.storeId, op.customer_id, live.signed_amount_agorot.toString()]);
    return {
      action: 'OPERATION_CANCEL', resourceType: 'ledger_operation', resourceId: operationId,
      details: { before: snapshot(op), reason: input.reason },
      body: { operation_id: operationId, balance_agorot: a.rows[0]!.balance_agorot.toString(),
        ledger_version: a.rows[0]!.ledger_version.toString() },
    };
  }));
}
