/** TEST_CASES 01, 31–34 · changelog AT-56, AT-57, AT-58 (DB part). */
import { describe, expect, test } from 'vitest';
import {
  app, tx, newOwner, newTenant, createStore, createCustomer, addDebt, account, day,
  storeOwed, deleteStore, restoreStore, customerList, AppError,
} from './helpers.js';

const TABLES = ['stores', 'customers', 'customer_names', 'customer_accounts',
  'ledger_operations', 'ledger_entries', 'operation_revisions', 'audit_events'];

describe('stores', () => {
  test('01 one active store per owner', async () => {
    const owner = await newOwner();
    const first = await createStore(owner, 'دكان أ');
    expect(first.created).toBe(true);
    // S-04 again: ON CONFLICT ... DO NOTHING, returns the existing store
    const again = await createStore(owner, 'دكان ب');
    expect(again).toEqual({ created: false, tenant: first.tenant });
    // and the DB itself refuses a second active store
    await expect(tx({ userId: owner.userId }, (c) =>
      c.query(`INSERT INTO public.stores (owner_user_id, name) VALUES ($1, 'دكان ج')`, [owner.userId])))
      .rejects.toMatchObject({ code: '23505' });
  });
});

describe('tenant isolation', () => {
  test('31 store A session cannot see store B', async () => {
    const A = await newTenant(); const B = await newTenant();
    const cb = await createCustomer(B, 'زبون المحل ب');
    await addDebt(B, { customerId: cb, expectedVersion: 0n, amount: 1000n, date: day() });

    for (const table of TABLES) {
      const r = await tx(A, (c) => c.query(`SELECT 1 FROM public.${table} WHERE ${table === 'stores' ? 'id' : 'store_id'} = $1`, [B.storeId]));
      expect(r.rowCount, table).toBe(0);
    }
    // forged context: user A claims store B -> sdb_is_current_store is false
    const forged = { userId: A.userId, storeId: B.storeId };
    expect((await tx(forged, (c) => c.query(`SELECT 1 FROM public.customers`))).rowCount).toBe(0);
    await expect(tx(forged, (c) => c.query(`INSERT INTO public.customers (store_id) VALUES ($1)`, [B.storeId])))
      .rejects.toMatchObject({ code: '42501' });
  });

  test('32 store A cannot post against a store B customer', async () => {
    const A = await newTenant(); const B = await newTenant();
    const cb = await createCustomer(B, 'زبون غريب');
    await expect(tx(A, (c) => c.query(`INSERT INTO public.ledger_operations
        (store_id, customer_id, type, amount_agorot, effective_date, created_by)
      VALUES ($1, $2, 'DEBT', 1000, $3, $4)`, [A.storeId, cb, day(), A.userId])))
      .rejects.toMatchObject({ code: '23503' });
  });

  test('33 sdb_app with no transaction context sees nothing and writes nothing', async () => {
    const A = await newTenant();
    await createCustomer(A, 'زبون');
    for (const table of TABLES) {
      const r = await app.query(`SELECT count(*) AS n FROM public.${table}`);
      expect(r.rows[0].n, table).toBe(0n);
    }
    await expect(app.query(`INSERT INTO public.stores (owner_user_id, name) VALUES ($1, 'x')`, [A.userId]))
      .rejects.toMatchObject({ code: '42501' });
  });

  test('34 context does not leak to the next transaction on a pooled connection', async () => {
    const A = await newTenant();
    await createCustomer(A, 'زبون');
    const client = await app.connect();
    try {
      const inside = await tx(A, (c) => c.query(`SELECT count(*) AS n FROM public.customers`), client);
      expect(inside.rows[0].n).toBe(1n);
      const after = await client.query(`SELECT coalesce(current_setting('app.user_id', true), '') AS u,
        coalesce(current_setting('app.store_id', true), '') AS s, (SELECT count(*) FROM public.customers) AS n`);
      expect(after.rows[0]).toEqual({ u: '', s: '', n: 0n });
    } finally { client.release(); }
  });
});

describe('store delete and restore', () => {
  test('AT-56 delete a store that is still owed money: total shown, name must match', async () => {
    const A = await newTenant('بقالة النور');
    const c1 = await createCustomer(A, 'زبون ١');
    const c2 = await createCustomer(A, 'زبون ٢');
    await addDebt(A, { customerId: c1, expectedVersion: 0n, amount: 15050n, date: day() });
    await addDebt(A, { customerId: c2, expectedVersion: 0n, amount: 2000n, date: day() });

    expect(await storeOwed(A)).toEqual({ customers_owing: 2n, total_owed_agorot: 17050n });
    await expect(deleteStore(A, 'بقالة')).rejects.toThrow(AppError);
    await deleteStore(A, 'بقالة النور');
    // the fresh OTP check is the backend's (FR-23); covered in the API tests, not here
  });

  test('AT-57 after store delete nothing is readable or writable', async () => {
    const A = await newTenant('دكان سيُحذف');
    const c1 = await createCustomer(A, 'زبون');
    await addDebt(A, { customerId: c1, expectedVersion: 0n, amount: 500n, date: day() });
    await deleteStore(A, 'دكان سيُحذف');

    for (const table of TABLES.filter((x) => x !== 'stores')) {
      expect((await tx(A, (c) => c.query(`SELECT 1 FROM public.${table}`))).rowCount, table).toBe(0);
    }
    await expect(addDebt(A, { customerId: c1, expectedVersion: 1n, amount: 100n, date: day() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(tx(A, (c) => c.query(`INSERT INTO public.customers (store_id) VALUES ($1)`, [A.storeId])))
      .rejects.toMatchObject({ code: '42501' });
    // the owner can still see the deleted store itself, to offer restore (S-03)
    const s3 = await tx({ userId: A.userId }, (c) => c.query(
      `SELECT id, deleted_at FROM public.stores WHERE owner_user_id = $1 ORDER BY deleted_at NULLS FIRST`, [A.userId]));
    expect(s3.rows).toHaveLength(1);
    expect(s3.rows[0].deleted_at).not.toBeNull();
  });

  test('AT-58 restore brings everything back unchanged; refused once a new store exists', async () => {
    const A = await newTenant('دكان قديم');
    const c1 = await createCustomer(A, 'زبون');
    await addDebt(A, { customerId: c1, expectedVersion: 0n, amount: 777n, date: day() });
    const before = { list: await customerList(A), acc: await account(A, c1) };

    await deleteStore(A, 'دكان قديم');
    await restoreStore(A);
    expect({ list: await customerList(A), acc: await account(A, c1) }).toEqual(before);

    // delete again, open a new store, then try to bring the old one back
    await deleteStore(A, 'دكان قديم');
    const fresh = await createStore(A.owner, 'دكان جديد');
    expect(fresh.created).toBe(true);
    await expect(restoreStore(A)).rejects.toMatchObject({ code: '23505' });
  });
});
