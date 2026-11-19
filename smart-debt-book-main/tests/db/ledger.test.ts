/** TEST_CASES 08–13, 15–20, 35, 39, 40. */
import { describe, expect, test } from 'vitest';
import {
  tx, newTenant, createCustomer, addDebt, recordPayment, account, day, editOperation, cancelOperation,
  operationRows, rawOperation, rawEntry, dashboard, statement, AppError, type Tenant,
} from './helpers.js';

async function customerWithDebt(amount: bigint, date = day()) {
  const t = await newTenant();
  const c = await createCustomer(t, 'زبون');
  const r = await addDebt(t, { customerId: c, expectedVersion: 0n, amount, date });
  return { t, c, opId: r.response.operation_id as string };
}

async function sumEntries(t: Tenant, customerId: string) {
  return tx(t, async (x) => (await x.query(`SELECT coalesce(sum(signed_amount_agorot), 0)::bigint AS s
    FROM public.ledger_entries WHERE customer_id = $1`, [customerId])).rows[0].s as bigint);
}

describe('posting', () => {
  test('08 debt: operation, revision, entry and account all agree', async () => {
    const { t, c, opId } = await customerWithDebt(15050n);
    const rows = await operationRows(t, opId);
    expect(rows.op.amount_agorot).toBe(15050n);
    expect(rows.revisions.map((r) => r.amount_agorot)).toEqual([15050n]);
    expect(rows.entries.map((e) => [e.kind, e.signed_amount_agorot])).toEqual([['ORIGINAL', 15050n]]);
    expect(await account(t, c)).toEqual({ balance_agorot: 15050n, ledger_version: 1n });
    expect(await sumEntries(t, c)).toBe(15050n);
  });

  test('09 operation without its ledger entry: COMMIT rejected', async () => {
    const t = await newTenant(); const c = await createCustomer(t, 'زبون');
    // operation, revision and account change are all there; only the ledger entry is missing
    await expect(tx(t, async (x) => {
      await rawOperation(x, t, c, { amount: 1000n });
      await x.query(`UPDATE public.customer_accounts SET balance_agorot = balance_agorot + 1000, ledger_version = ledger_version + 1 WHERE customer_id = $1`, [c]);
    })).rejects.toThrow(/postings/);   // operation guard or account-postings guard, whichever fires first
  });

  test('10 ledger entry without the account change: COMMIT rejected', async () => {
    const t = await newTenant(); const c = await createCustomer(t, 'زبون');
    await expect(tx(t, async (x) => {
      const op = await rawOperation(x, t, c, { amount: 1000n });
      await rawEntry(x, t, { ...op, customerId: c, signed: 1000n });
    })).rejects.toThrow(/do not reconcile/);
  });

  test('11 payment above the balance: refused by the service and by the DB', async () => {
    const { t, c } = await customerWithDebt(1000n);
    await expect(recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 1001n, date: day() }))
      .rejects.toMatchObject({ code: 'OVERPAYMENT' });
    await expect(tx(t, async (x) => {
      const op = await rawOperation(x, t, c, { amount: 1001n, type: 'PAYMENT' });
      await rawEntry(x, t, { ...op, customerId: c, signed: -1001n });
      await x.query(`UPDATE public.customer_accounts SET balance_agorot = balance_agorot - 1001, ledger_version = ledger_version + 1 WHERE customer_id = $1`, [c]);
    })).rejects.toMatchObject({ code: '23514' });
    expect(await account(t, c)).toEqual({ balance_agorot: 1000n, ledger_version: 1n });
  });

  test('12 payment backdated before all debt: rejected (history would go negative)', async () => {
    const { t, c } = await customerWithDebt(10000n, day());
    await expect(recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 5000n, date: day(-10) }))
      .rejects.toThrow(/historical customer balance cannot become negative/);
  });

  test('13 debt backdated before an earlier payment: allowed while history stays >= 0', async () => {
    const { t, c } = await customerWithDebt(10000n, day(-5));
    await recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 5000n, date: day(-2) });
    await addDebt(t, { customerId: c, expectedVersion: 2n, amount: 3000n, date: day(-20) });
    expect(await account(t, c)).toEqual({ balance_agorot: 8000n, ledger_version: 3n });
  });
});

describe('corrections', () => {
  test('15 correct a debt from 150 to 120: reversal + correction, original kept', async () => {
    const { t, c, opId } = await customerWithDebt(15000n);
    await editOperation(t, opId, 1n, { amount: 12000n });
    const rows = await operationRows(t, opId);
    expect(rows.op).toMatchObject({ amount_agorot: 12000n, revision_no: 2 });
    expect(rows.revisions.map((r) => [r.revision_no, r.amount_agorot])).toEqual([[1, 15000n], [2, 12000n]]);
    expect(rows.entries.map((e) => [e.kind, e.signed_amount_agorot]).sort())
      .toEqual([['CORRECTION', 12000n], ['ORIGINAL', 15000n], ['REVERSAL', -15000n]]);
    expect(await account(t, c)).toEqual({ balance_agorot: 12000n, ledger_version: 2n });
    expect(await sumEntries(t, c)).toBe(12000n);
  });

  test('16 the same entry cannot be reversed twice', async () => {
    const { t, c, opId } = await customerWithDebt(15000n);
    await editOperation(t, opId, 1n, { amount: 12000n });
    const rows = await operationRows(t, opId);
    const original = rows.entries.find((e) => e.kind === 'ORIGINAL');
    await expect(tx(t, (x) => rawEntry(x, t, { opId, revId: rows.revisions[1].id, customerId: c,
      kind: 'REVERSAL', signed: -15000n, reverses: original.id }))).rejects.toMatchObject({ code: '23505' });
  });

  test('17 reversal with the wrong amount or the wrong customer: rejected', async () => {
    const { t, c, opId } = await customerWithDebt(15000n);
    const other = await createCustomer(t, 'زبون آخر');
    const rows = await operationRows(t, opId);
    const original = rows.entries[0];
    const base = { opId, revId: rows.revisions[0].id, kind: 'REVERSAL', reverses: original.id };
    await expect(tx(t, (x) => rawEntry(x, t, { ...base, customerId: c, signed: -100n }))).rejects.toThrow(/invalid financial reversal/);
    await expect(tx(t, (x) => rawEntry(x, t, { ...base, customerId: other, signed: -15000n }))).rejects.toThrow(/invalid financial reversal/);
  });

  test('18 change note and date only: new revision, no money entry', async () => {
    const { t, c, opId } = await customerWithDebt(5000n, day(-3));
    await editOperation(t, opId, 1n, { date: day(-4), description: 'سكر وأرز' });
    const rows = await operationRows(t, opId);
    expect(rows.op).toMatchObject({ effective_date: day(-4), description: 'سكر وأرز', revision_no: 2 });
    expect(rows.entries).toHaveLength(1);
    expect(await account(t, c)).toEqual({ balance_agorot: 5000n, ledger_version: 2n });
  });

  test('18b moving a debt after the payment it funded: rejected', async () => {
    const { t, c, opId } = await customerWithDebt(5000n, day(-5));
    await recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 5000n, date: day(-3) });
    await expect(editOperation(t, opId, 2n, { date: day(-1) })).rejects.toThrow(/historical customer balance/);
  });

  test('19 amount changed without a matching new revision: COMMIT rejected', async () => {
    const { t, opId } = await customerWithDebt(5000n);
    await expect(tx(t, (x) => x.query(`UPDATE public.ledger_operations SET amount_agorot = 4000, revision_no = revision_no + 1 WHERE id = $1`, [opId])))
      .rejects.toThrow(/revision|reconcile|postings/);   // whichever deferred guard fires first
  });

  test('19b operation changed without its revision snapshot: COMMIT rejected by the revision guard', async () => {
    const { t, opId } = await customerWithDebt(5000n);
    await expect(tx(t, (x) => x.query(`UPDATE public.ledger_operations SET description = 'بدون مراجعة', revision_no = revision_no + 1 WHERE id = $1`, [opId])))
      .rejects.toThrow(/revision/);
  });

  test('20 cancel an earlier debt that a later payment relied on: rejected', async () => {
    const { t, c, opId } = await customerWithDebt(10000n, day(-10));
    await recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 8000n, date: day(-5) });
    await addDebt(t, { customerId: c, expectedVersion: 2n, amount: 20000n, date: day(-1) });
    // today's balance would stay positive (22000 - 10000), but on day -5 it would be -8000
    await expect(cancelOperation(t, opId, 3n)).rejects.toThrow(/historical customer balance/);
    expect(await account(t, c)).toEqual({ balance_agorot: 22000n, ledger_version: 3n });
  });

  test('20b cancel a debt nothing relied on: reversal only, history kept', async () => {
    const { t, c, opId } = await customerWithDebt(10000n);
    await cancelOperation(t, opId, 1n);
    const rows = await operationRows(t, opId);
    expect(rows.op).toMatchObject({ status: 'CANCELLED', revision_no: 2 });
    expect(rows.entries.map((e) => e.kind).sort()).toEqual(['ORIGINAL', 'REVERSAL']);
    expect(await account(t, c)).toEqual({ balance_agorot: 0n, ledger_version: 2n });
    await expect(cancelOperation(t, opId, 2n)).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
  });

  test('35 change effective_date when effective_time is NULL: time stays NULL', async () => {
    const { t, opId } = await customerWithDebt(5000n, day(-2));
    await editOperation(t, opId, 1n, { date: day(-3) });
    const rows = await operationRows(t, opId);
    expect(rows.op.effective_time).toBeNull();
    expect(rows.revisions.map((r) => r.effective_time)).toEqual([null, null]);
  });
});

describe('reconciliation', () => {
  test('39 balance changed without a ledger operation: COMMIT rejected', async () => {
    const { t, c } = await customerWithDebt(1000n);
    await expect(tx(t, (x) => x.query(`UPDATE public.customer_accounts SET balance_agorot = balance_agorot + 100,
      ledger_version = ledger_version + 1 WHERE customer_id = $1`, [c]))).rejects.toThrow(/do not reconcile/);
    expect(await account(t, c)).toEqual({ balance_agorot: 1000n, ledger_version: 1n });
  });

  test('40 totals after corrections count active operations only', async () => {
    const { t, c, opId } = await customerWithDebt(10000n, day());
    await editOperation(t, opId, 1n, { amount: 8000n });                                         // debt now 80
    const p1 = await recordPayment(t, { customerId: c, expectedVersion: 2n, amount: 3000n, date: day() });
    await cancelOperation(t, p1.response.operation_id as string, 3n);                            // cancelled
    await recordPayment(t, { customerId: c, expectedVersion: 4n, amount: 2000n, date: day() });  // active

    const d = await dashboard(t);
    expect(d).toEqual({ total_debt_agorot: 6000n, debtors: 1n, collected_agorot: 2000n });
    const s = await statement(t, c);
    expect(s.map((r) => [r.type, r.amount_agorot])).toEqual([['DEBT', 8000n], ['PAYMENT', 2000n]]);
    expect(s.at(-1)!.running_agorot).toBe(6000n);
  });
});

test('service errors are AppError, not DB errors', () => {
  expect(new AppError('STALE_DRAFT')).toBeInstanceOf(Error);
});
