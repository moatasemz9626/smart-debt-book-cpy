/** K-01 Edit and K-02 Cancel through the API. */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { daysAgo, today } from './client.js';
import { ownerWithStore, newCustomer, debt, payment } from './fixtures.js';
import { admin } from '../db/helpers.js';

async function entriesOf(opId: string) {
  return (await admin.query(`SELECT kind, signed_amount_agorot::text AS s FROM public.ledger_entries
    WHERE operation_id = $1 ORDER BY created_at, kind`, [opId])).rows.map((r) => [r.kind, r.s]);
}

describe('K-01 edit', () => {
  test('debt ₪150 → ₪120: reversal + correction, balance follows, page shows revision 2', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const d = await debt(a, c.id, '0', '15000');
    const r = await a.edit(d.operation_id, { expected_version: '1', amount_agorot: '12000', reason: 'خطأ في المبلغ' });
    expect(r).toMatchObject({ status: 200, body: { operation_id: d.operation_id, balance_agorot: '12000', ledger_version: '2' } });
    expect(await entriesOf(d.operation_id)).toEqual(expect.arrayContaining([['ORIGINAL', '15000'], ['REVERSAL', '-15000'], ['CORRECTION', '12000']]));
    const op = (await a.customerPage(c.id)).body.operations[0];
    expect(op).toMatchObject({ amount_agorot: '12000', revision_no: 2, status: 'ACTIVE' });
  });

  test('edit a payment amount down; second edit reverses the correction, not the original', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { balance: '10000' });
    const p = await payment(a, c.id, '1', '4000');
    await a.edit(p.operation_id, { expected_version: '2', amount_agorot: '3000', reason: 'دفع أقل' });
    const r = await a.edit(p.operation_id, { expected_version: '3', amount_agorot: '2500', reason: 'تصحيح ثانٍ' });
    expect(r.body).toMatchObject({ balance_agorot: '7500', ledger_version: '4' });
    expect(await entriesOf(p.operation_id)).toHaveLength(5);
  });

  test('description and date only: no money entry; description can be cleared; time never invented', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const d = await debt(a, c.id, '0', '500', daysAgo(2));
    await a.edit(d.operation_id, { expected_version: '1', effective_date: daysAgo(3), description: 'خبز', reason: 'تاريخ' });
    await a.edit(d.operation_id, { expected_version: '2', description: null, reason: 'مسح الوصف' });
    const op = (await a.customerPage(c.id)).body.operations[0];
    expect(op).toMatchObject({ effective_date: daysAgo(3), description: null, effective_time: null, revision_no: 3 });
    expect(await entriesOf(d.operation_id)).toEqual([['ORIGINAL', '500']]);
  });

  test('raising a payment above the balance → 422 OVERPAYMENT', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { balance: '1000' });
    const p = await payment(a, c.id, '1', '600');
    expect((await a.edit(p.operation_id, { expected_version: '2', amount_agorot: '1001', reason: 'x' })).body.error.code).toBe('OVERPAYMENT');
  });

  test('moving a debt after the payment it funded → 422 HISTORY_NEGATIVE', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const d = await debt(a, c.id, '0', '5000', daysAgo(5));
    await payment(a, c.id, '1', '5000', daysAgo(3));
    expect((await a.edit(d.operation_id, { expected_version: '2', effective_date: today(), reason: 'x' })).body.error.code).toBe('HISTORY_NEGATIVE');
  });

  test('validation: no change → 400; reason required; stale → 409; unknown op → 404', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const d = await debt(a, c.id, '0', '500');
    expect((await a.edit(d.operation_id, { expected_version: '1', reason: 'x' })).status).toBe(400);
    expect((await a.edit(d.operation_id, { expected_version: '1', amount_agorot: '400' })).status).toBe(400);
    expect((await a.edit(d.operation_id, { expected_version: '0', amount_agorot: '400', reason: 'x' })).body.error.code).toBe('STALE_DRAFT');
    expect((await a.edit(randomUUID(), { expected_version: '1', amount_agorot: '400', reason: 'x' })).status).toBe(404);
  });
});

describe('K-02 cancel', () => {
  test('cancel reverses the money, keeps the row (marked), statement drops it, cannot cancel twice', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { balance: '1000' });
    const d = await debt(a, c.id, '1', '300');
    const r = await a.cancel(d.operation_id, { expected_version: '2', reason: 'سُجّل بالخطأ' });
    expect(r.body).toMatchObject({ balance_agorot: '1000', ledger_version: '3' });
    expect((await a.customerPage(c.id)).body.operations.find((o: any) => o.id === d.operation_id).status).toBe('CANCELLED');
    expect((await a.statement(c.id)).body.rows).toHaveLength(1);
    expect(await a.cancel(d.operation_id, { expected_version: '3', reason: 'x' }))
      .toMatchObject({ status: 422, body: { error: { code: 'OPERATION_NOT_ACTIVE' } } });
    expect((await a.edit(d.operation_id, { expected_version: '3', amount_agorot: '1', reason: 'x' })).body.error.code).toBe('OPERATION_NOT_ACTIVE');
  });

  test('cancel an earlier debt a later payment relied on → 422 HISTORY_NEGATIVE', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const d1 = await debt(a, c.id, '0', '10000', daysAgo(10));
    await payment(a, c.id, '1', '8000', daysAgo(5));
    await debt(a, c.id, '2', '20000', daysAgo(1));
    expect((await a.cancel(d1.operation_id, { expected_version: '3', reason: 'x' })).body.error.code).toBe('HISTORY_NEGATIVE');
  });

  test('cancel the only debt after a payment against it → 422 (would go below zero)', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const d = await debt(a, c.id, '0', '1000');
    await payment(a, c.id, '1', '400');
    const r = await a.cancel(d.operation_id, { expected_version: '2', reason: 'x' });
    expect(r.status).toBe(422);
    expect(['OVERPAYMENT', 'HISTORY_NEGATIVE']).toContain(r.body.error.code);
  });
});

describe('L-03 opening balance on an existing customer', () => {
  test('separate OPENING_BALANCE operation, never a time; time in the body is rejected', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const r = await a.openingBalance(c.id, { expected_version: '0', amount_agorot: '85000', description: 'من الدفتر الورقي', effective_date: daysAgo(60) });
    expect(r).toMatchObject({ status: 201, body: { amount_agorot: '85000', balance_agorot: '85000', ledger_version: '1' } });
    const op = (await a.customerPage(c.id)).body.operations[0];
    expect(op).toMatchObject({ type: 'OPENING_BALANCE', effective_time: null, description: 'من الدفتر الورقي' });
    expect((await a.openingBalance(c.id, { expected_version: '1', amount_agorot: '1', effective_date: today(), effective_time: '10:00' })).status).toBe(400);
    expect((await a.openingBalance(c.id, { expected_version: '0', amount_agorot: '1', effective_date: today() })).body.error.code).toBe('STALE_DRAFT');
  });
});
