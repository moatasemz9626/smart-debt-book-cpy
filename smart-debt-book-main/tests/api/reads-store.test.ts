/** R-01, R-02, R-04, R-05, C-06 and S-06, S-08a, S-09 through the API. */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assertNoMoneyNumbers, daysAgo, today } from './client.js';
import { ownerWithStore, newCustomer, debt, payment } from './fixtures.js';
import { deleteStore } from '../db/helpers.js';

describe('reads', () => {
  test('R-01 dashboard: totals as strings, collected this month counts active payments only', async () => {
    const { a } = await ownerWithStore();
    const c1 = await newCustomer(a, { name: 'أ', balance: '10000' });
    const c2 = await newCustomer(a, { name: 'ب', balance: '2550' });
    await newCustomer(a, { name: 'ج' });
    const p = await payment(a, c1.id, '1', '3000');
    await a.cancel(p.operation_id, { expected_version: p.ledger_version, reason: 'x' });
    await payment(a, c2.id, '1', '50');
    const d = await a.dashboard();
    assertNoMoneyNumbers(d.raw);
    expect(d.body).toMatchObject({ total_debt_agorot: '12500', debtors: 2, collected_this_month_agorot: '50' });
    expect(d.body.recent).toHaveLength(4);             // 2 opening balances, 2 payments (one cancelled, still listed)
    expect(d.body.recent[0]).toMatchObject({ type: 'PAYMENT', amount_agorot: '50', customer_name: 'ب' });
  });

  test('R-02 list: debtors by debt by default; all by name', async () => {
    const { a } = await ownerWithStore();
    await newCustomer(a, { name: 'زياد', balance: '100' });
    await newCustomer(a, { name: 'باسل', balance: '900' });
    await newCustomer(a, { name: 'أمين' });
    expect((await a.listCustomers()).body.customers.map((c: any) => [c.primary_name, c.balance_agorot])).toEqual([['باسل', '900'], ['زياد', '100']]);
    expect((await a.listCustomers({ filter: 'all', sort: 'name' })).body.customers.map((c: any) => c.primary_name)).toEqual(['أمين', 'باسل', 'زياد']);
    expect((await a.listCustomers({ filter: 'some' })).status).toBe(400);
  });

  test('C-06 search: ة/ه, hamza and tashkeel insensitive; one row per customer; empty q → 400', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { name: 'فاطمة' });
    await a.addAlias(c.id, 'أم فاطمة');
    const r = await a.search('فاطمه');
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ id: c.id, primary_name: 'فاطمة', matched_name: 'فاطمة', rank: 1 });
    expect((await a.search('  ')).status).toBe(400);
  });

  test('R-04 statement: oldest first, running total as a string, active only', async () => {
    const { a } = await ownerWithStore('دكان الحي');
    const c = await newCustomer(a, { name: 'نادر', balance: '1000', date: daysAgo(10) });
    await debt(a, c.id, '1', '550', daysAgo(5));
    const p = await payment(a, c.id, '2', '300', daysAgo(1));
    const s = await a.statement(c.id);
    assertNoMoneyNumbers(s.raw);
    expect(s.body).toMatchObject({ store_name: 'دكان الحي', customer_name: 'نادر', balance_agorot: '1250' });
    expect(s.body.rows.map((r: any) => [r.type, r.amount_agorot, r.running_agorot]))
      .toEqual([['OPENING_BALANCE', '1000', '1000'], ['DEBT', '550', '1550'], ['PAYMENT', '300', '1250']]);
    await a.cancel(p.operation_id, { expected_version: p.ledger_version, reason: 'x' });
    expect((await a.statement(c.id)).body.rows.at(-1).running_agorot).toBe('1550');
  });

  test('R-05 activity: newest entry first, date filter, paging without gaps', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { balance: '100' });
    let v = '1';
    for (let i = 0; i < 54; i++) v = (await debt(a, c.id, v, String(i + 1))).ledger_version;
    const p1 = await a.activity();
    expect(p1.body.items).toHaveLength(50);
    expect(p1.body.items[0].amount_agorot).toBe('54');
    const p2 = await a.activity({ cursor: p1.body.next_cursor });
    expect(p2.body.items).toHaveLength(5);                      // 54 debts + 1 opening balance
    expect(p2.body.next_cursor).toBeNull();
    expect(new Set([...p1.body.items, ...p2.body.items].map((x: any) => x.id)).size).toBe(55);
    expect((await a.activity({ from: daysAgo(-1) })).body.items).toHaveLength(0);   // tomorrow onwards
    expect((await a.activity({ from: today(), to: daysAgo(-1) })).body.items.length).toBe(50);
    expect((await a.activity({ from: '2026-02-30' })).status).toBe(400);
    const other = await newCustomer(a, { balance: '5' });
    expect((await a.activity({ customer_id: other.id })).body.items.map((x: any) => x.customer_id)).toEqual([other.id]);
  });
});

describe('store', () => {
  test('S-06 rename', async () => {
    const { a } = await ownerWithStore('اسم قديم');
    const r = await a.renameStore('  اسم جديد ');
    expect(r.body.store.name).toBe('اسم جديد');
    expect((await a.getStore()).body.store.name).toBe('اسم جديد');
    expect((await a.renameStore('')).status).toBe(400);
  });

  test('S-08a delete preview: customers owing and total owed', async () => {
    const { a } = await ownerWithStore();
    await newCustomer(a, { balance: '15050' });
    await newCustomer(a, { balance: '2000' });
    await newCustomer(a);
    expect((await a.deletePreview()).body).toEqual({ customers_owing: 2, total_owed_agorot: '17050' });
  });

  test('S-09 restore: data back; retry replays; refused once a new store exists', async () => {
    const { a, owner, store } = await ownerWithStore('دكان قديم');
    const c = await newCustomer(a, { balance: '777' });
    await deleteStore({ userId: owner.userId, storeId: store.id }, 'دكان قديم');     // S-08 waits for the OTP decision
    expect((await a.getStore()).body).toMatchObject({ store: null, deleted_store: { id: store.id } });
    expect((await a.listCustomers()).body.error.code).toBe('NO_STORE');

    const key = randomUUID();
    const r = await a.restoreStore(store.id, key);
    expect(r).toMatchObject({ status: 200, body: { store: { id: store.id, deleted_at: null } } });
    expect(await a.restoreStore(store.id, key)).toMatchObject({ status: 200, replayed: true, body: r.body });
    expect((await a.customerPage(c.id)).body.customer.balance_agorot).toBe('777');

    await deleteStore({ userId: owner.userId, storeId: store.id }, 'دكان قديم');
    expect((await a.createStore('دكان جديد')).status).toBe(201);
    expect((await a.restoreStore(store.id)).body.error.code).toBe('ACTIVE_STORE_EXISTS');
  });

  test('S-09 with someone else’s store id → 404', async () => {
    const A = await ownerWithStore();
    const B = await ownerWithStore();
    expect((await B.a.restoreStore(A.store.id)).status).toBe(404);
  });
});
