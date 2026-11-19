/** First vertical slice: login → create store → create customer → add debt → record payment → customer page.
 * Through the real route handlers, as sdb_app, with real Supabase sessions. */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { api, call, handlers, assertNoMoneyNumbers } from './client.js';
import { newOwner, signIn, logoutOthers } from '../db/helpers.js';
import { todayJerusalem } from '@/api/schemas';

const today = todayJerusalem();
const daysAgo = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' })
  .format(new Date(Date.now() - n * 86_400_000));

async function ownerWithStore(name = 'بقالة الأمل') {
  const owner = await newOwner();
  const a = api(owner.accessToken);
  expect((await a.createStore(name)).status).toBe(201);
  return { owner, a };
}

async function customerWithBalance(a: ReturnType<typeof api>, agorot: string) {
  const r = await a.createCustomer({ name: `زبون ${randomUUID().slice(0, 6)}`, opening_balance_agorot: agorot, force: true });
  expect(r.status).toBe(201);
  return r.body.customer as { id: string; ledger_version: string; balance_agorot: string };
}

describe('the slice, end to end', () => {
  test('login → store → customer → debt → payment → customer page', async () => {
    const owner = await newOwner();                                   // real Supabase sign-up = login
    const a = api(owner.accessToken);

    expect((await a.getStore()).body).toEqual({ store: null, deleted_store: null });

    const s = await a.createStore('  بقالة النور ');
    expect(s.status).toBe(201);
    expect(s.body.store).toMatchObject({ name: 'بقالة النور', timezone: 'Asia/Jerusalem', deleted_at: null });
    expect((await a.getStore()).body.store.id).toBe(s.body.store.id);

    const c = await a.createCustomer({ name: 'حمزة', phone: '050-123 4567', opening_balance_agorot: '5000', opening_date: daysAgo(30) });
    expect(c.status).toBe(201);
    expect(c.body.customer).toMatchObject({ primary_name: 'حمزة', phone: '+972501234567', balance_agorot: '5000', ledger_version: '1' });
    const id = c.body.customer.id;

    const d = await a.addDebt(id, { expected_version: '1', amount_agorot: '10070', description: 'سكر وأرز', effective_date: today, effective_time: '09:15' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ amount_agorot: '10070', balance_agorot: '15070', ledger_version: '2' });   // ₪100.70 = 10070

    const p = await a.pay(id, { expected_version: '2', amount_agorot: '5070', effective_date: today });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ amount_agorot: '5070', balance_agorot: '10000', ledger_version: '3' });

    const page = await a.customerPage(id);
    expect(page.status).toBe(200);
    assertNoMoneyNumbers(page.raw);
    expect(page.body.customer).toMatchObject({ id, primary_name: 'حمزة', balance_agorot: '10000', ledger_version: '3', aliases: [] });
    expect(page.body.operations.map((o: any) => [o.type, o.amount_agorot, o.effective_time])).toEqual([
      ['PAYMENT', '5070', null],            // today, no time (NULL sorts first in DESC)
      ['DEBT', '10070', '09:15'],           // today 09:15
      ['OPENING_BALANCE', '5000', null],    // 30 days ago
    ]);
    expect(page.body.next_cursor).toBeNull();
  });
});

describe('money rule: integer agorot as strings', () => {
  test.each([
    ['a JSON number', 10070], ['shekels with decimals', '100.70'], ['zero', '0'], ['negative', '-5'],
    ['leading zero', '010'], ['over ₪1,000,000', '100000001'], ['empty', ''],
  ])('amount as %s → 400', async (_what, amount) => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1000');
    const r = await a.addDebt(c.id, { expected_version: '1', amount_agorot: amount, effective_date: today });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'amount_agorot' } });
  });

  test('exactly ₪1,000,000.00 is accepted', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1000');
    expect((await a.addDebt(c.id, { expected_version: '1', amount_agorot: '100000000', effective_date: today })).status).toBe(201);
  });

  test('expected_version as a JSON number → 400', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1000');
    expect((await a.addDebt(c.id, { expected_version: 1, amount_agorot: '100', effective_date: today })).status).toBe(400);
  });
});

describe('auth and tenant', () => {
  test('no token or a bad token → 401', async () => {
    for (const token of [null, 'not-a-jwt']) {
      const r = await call(handlers.store.GET, { method: 'GET', path: '/store', token });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  test('a session ended by "log out other devices" is refused by the API', async () => {
    const owner = await newOwner();
    const phone = await signIn(owner.email, owner.password);
    const laptop = await signIn(owner.email, owner.password);
    expect((await api(laptop.access_token).getStore()).status).toBe(200);
    await logoutOthers(phone.access_token);
    expect((await api(laptop.access_token).getStore()).status).toBe(401);
    expect((await api(phone.access_token).getStore()).status).toBe(200);
  });

  test('user without a store → 404 NO_STORE', async () => {
    const owner = await newOwner();
    const r = await api(owner.accessToken).createCustomer({ name: 'زبون' });
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'NO_STORE' } } });
  });

  test('another store’s customer → 404 NOT_FOUND, read and write (decision D1)', async () => {
    const A = await ownerWithStore('محل أ');
    const B = await ownerWithStore('محل ب');
    const ca = await customerWithBalance(A.a, '1000');
    expect((await B.a.customerPage(ca.id)).body.error.code).toBe('NOT_FOUND');
    const w = await B.a.addDebt(ca.id, { expected_version: '1', amount_agorot: '100', effective_date: today });
    expect(w).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
    expect((await A.a.customerPage(ca.id)).body.customer.balance_agorot).toBe('1000');
  });

  test('a store_id in the body is rejected, never used', async () => {
    const { a } = await ownerWithStore();
    const r = await a.createCustomer({ name: 'زبون', store_id: randomUUID() });
    expect(r.status).toBe(400);
  });
});

describe('writes: idempotency, stale drafts, rules', () => {
  test('missing Idempotency-Key → 400', async () => {
    const owner = await newOwner();
    const r = await call(handlers.store.POST, { method: 'POST', path: '/store', token: owner.accessToken, body: { name: 'x' } });
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'Idempotency-Key' } });
  });

  test('same key + same body → saved response replayed; same key + other body → 409', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1000');
    const key = randomUUID();
    const body = { expected_version: '1', amount_agorot: '250', effective_date: today };
    const first = await a.addDebt(c.id, body, key);
    const again = await a.addDebt(c.id, body, key);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ status: 201, replayed: true, body: first.body });
    const other = await a.addDebt(c.id, { ...body, amount_agorot: '999' }, key);
    expect(other).toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } });
    expect((await a.customerPage(c.id)).body.customer.balance_agorot).toBe('1250');
  });

  test('lost response: R-06 finds the saved result; unknown key → 404 REQUEST_NOT_FOUND', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1000');
    const key = randomUUID();
    const saved = await a.addDebt(c.id, { expected_version: '1', amount_agorot: '300', effective_date: today }, key);
    const found = await a.lookup(key);
    expect(found).toMatchObject({ status: 200, body: { action: 'OPERATION_CREATE', response: saved.body } });
    expect((await a.lookup(randomUUID())).body.error.code).toBe('REQUEST_NOT_FOUND');
  });

  test('stale draft → 409 with the current account', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1000');
    await a.addDebt(c.id, { expected_version: '1', amount_agorot: '100', effective_date: today });
    const stale = await a.addDebt(c.id, { expected_version: '1', amount_agorot: '100', effective_date: today });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'STALE_DRAFT', details: { balance_agorot: '1100', ledger_version: '2' } } } });
  });

  test('overpayment → 422 with balance; full payment pays exactly; then nothing to pay', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '1234');
    const over = await a.pay(c.id, { expected_version: '1', amount_agorot: '1235', effective_date: today });
    expect(over).toMatchObject({ status: 422, body: { error: { code: 'OVERPAYMENT', details: { balance_agorot: '1234' } } } });
    const full = await a.pay(c.id, { expected_version: '1', full: true, effective_date: today });
    expect(full).toMatchObject({ status: 201, body: { amount_agorot: '1234', balance_agorot: '0' } });
    const none = await a.pay(c.id, { expected_version: '2', full: true, effective_date: today });
    expect(none.body.error.code).toBe('NOTHING_TO_PAY');
    expect((await a.pay(c.id, { expected_version: '2', full: true, amount_agorot: '5', effective_date: today })).status).toBe(400);
  });

  test('payment backdated before the debt → 422 HISTORY_NEGATIVE (deferred guard at COMMIT)', async () => {
    const { a } = await ownerWithStore();
    const c = await a.createCustomer({ name: 'متأخر', opening_balance_agorot: '1000', opening_date: today });
    const r = await a.pay(c.body.customer.id, { expected_version: '1', amount_agorot: '500', effective_date: daysAgo(3) });
    expect(r).toMatchObject({ status: 422, body: { error: { code: 'HISTORY_NEGATIVE' } } });
  });

  test('similar name → 409 SIMILAR_NAMES with matches; force creates; ة/ه twin → 409 NAME_EXISTS', async () => {
    const { a } = await ownerWithStore();
    const first = await a.createCustomer({ name: 'محمد العلي' });
    const similar = await a.createCustomer({ name: 'محمد' });
    expect(similar).toMatchObject({ status: 409, body: { error: { code: 'SIMILAR_NAMES' } } });
    expect(similar.body.error.details.matches[0]).toMatchObject({ customer_id: first.body.customer.id, deleted: false });
    expect((await a.createCustomer({ name: 'محمد', force: true })).status).toBe(201);

    await a.createCustomer({ name: 'حمزة' });
    const twin = await a.createCustomer({ name: 'حمزه', force: true });
    expect(twin).toMatchObject({ status: 409, body: { error: { code: 'NAME_EXISTS', details: { deleted: false } } } });
  });
});

describe('customer page paging', () => {
  test('two pages: no row skipped or repeated, same order as one big list', async () => {
    const { a } = await ownerWithStore();
    const c = await customerWithBalance(a, '100000');
    let v = 1n;
    // 59 more operations, many on the same day, some with a time and some without
    for (let i = 0; i < 59; i++) {
      const r = await a.addDebt(c.id, {
        expected_version: String(v), amount_agorot: String(100 + i), effective_date: daysAgo(i % 4),
        ...(i % 3 === 0 ? { effective_time: `1${i % 10}:00` } : {}),
      });
      expect(r.status).toBe(201);
      v = BigInt(r.body.ledger_version);
    }
    const p1 = await a.customerPage(c.id);
    expect(p1.body.operations).toHaveLength(50);
    expect(p1.body.next_cursor).toBeTypeOf('string');
    const p2 = await a.customerPage(c.id, p1.body.next_cursor);
    expect(p2.body.operations).toHaveLength(10);
    expect(p2.body.next_cursor).toBeNull();

    const ids = [...p1.body.operations, ...p2.body.operations].map((o: any) => o.id);
    expect(new Set(ids).size).toBe(60);
    const keys = [...p1.body.operations, ...p2.body.operations]
      .map((o: any) => `${o.effective_date} ${o.effective_time ?? '24:00'} ${o.created_at}`);
    expect(keys).toEqual([...keys].sort().reverse());

    expect((await a.customerPage(c.id, 'garbage')).status).toBe(400);
  });
});
