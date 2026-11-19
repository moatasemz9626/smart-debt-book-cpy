/** TEST_CASES 02–07 · changelog AT-51…AT-55, AT-59. */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  tx, newTenant, createCustomer, addAlias, account, addDebt, recordPayment, day, search, similarNames,
  deleteCustomer, restoreCustomer, customerList, dashboard, statement, rawOperation, rawEntry, admin,
} from './helpers.js';

describe('customer structure', () => {
  test('02 customer + account + primary name in one transaction', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, '  أبو   محمد ');
    expect(await account(t, c)).toEqual({ balance_agorot: 0n, ledger_version: 0n });
    const names = await tx(t, (x) => x.query(`SELECT name, normalized_name, is_primary FROM public.customer_names WHERE customer_id = $1`, [c]));
    expect(names.rows).toEqual([{ name: 'أبو   محمد', normalized_name: 'ابو محمد', is_primary: true }]);
  });

  test('03 customer without primary name, or without account, is rejected at COMMIT', async () => {
    const t = await newTenant();
    await expect(tx(t, async (x) => {
      const id = randomUUID();
      await x.query(`INSERT INTO public.customers (id, store_id) VALUES ($1, $2)`, [id, t.storeId]);
      await x.query(`INSERT INTO public.customer_accounts (store_id, customer_id) VALUES ($1, $2)`, [t.storeId, id]);
    })).rejects.toThrow(/exactly one primary name/);
    await expect(tx(t, async (x) => {
      const id = randomUUID();
      await x.query(`INSERT INTO public.customers (id, store_id) VALUES ($1, $2)`, [id, t.storeId]);
      await x.query(`INSERT INTO public.customer_names (store_id, customer_id, name, is_primary) VALUES ($1, $2, 'بلا حساب', true)`, [t.storeId, id]);
    })).rejects.toThrow(/one financial account/);
  });

  test('04 two names with the same normalized form in one store: rejected (primary and alias)', async () => {
    const t = await newTenant();
    await createCustomer(t, 'أحمد');
    await expect(createCustomer(t, 'احمد')).rejects.toMatchObject({ code: '23505' });
    const other = await createCustomer(t, 'سمير');
    await expect(addAlias(t, other, ' إحمد ')).rejects.toMatchObject({ code: '23505' });
  });

  test('05 same name in two stores is allowed', async () => {
    const A = await newTenant(); const B = await newTenant();
    await createCustomer(A, 'محمود');
    await expect(createCustomer(B, 'محمود')).resolves.toBeTypeOf('string');
  });

  test('06 changing an alias updates one row and its normalized name', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'خليل');
    const alias = await addAlias(t, c, 'أبو خليل');
    const r = await tx(t, (x) => x.query(`UPDATE public.customer_names SET name = 'أبو إبراهيم' WHERE id = $1 RETURNING normalized_name`, [alias]));
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].normalized_name).toBe('ابو ابراهيم');
  });

  test('07 alias delete works; deleting the only primary name needs a new primary in the same transaction', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'يوسف');
    const alias1 = await addAlias(t, c, 'أبو يوسف');
    await tx(t, (x) => x.query(`DELETE FROM public.customer_names WHERE store_id = $1 AND id = $2 AND NOT is_primary`, [t.storeId, alias1]));

    await expect(tx(t, (x) => x.query(`DELETE FROM public.customer_names WHERE customer_id = $1 AND is_primary`, [c])))
      .rejects.toThrow(/exactly one primary name/);

    const alias2 = await addAlias(t, c, 'جو');
    await tx(t, async (x) => {
      await x.query(`DELETE FROM public.customer_names WHERE customer_id = $1 AND is_primary`, [c]);
      await x.query(`UPDATE public.customer_names SET is_primary = true WHERE id = $1`, [alias2]);
    });
    const names = await tx(t, (x) => x.query(`SELECT name FROM public.customer_names WHERE customer_id = $1 AND is_primary`, [c]));
    expect(names.rows).toEqual([{ name: 'جو' }]);
  });
});

describe('customer delete and restore', () => {
  test('AT-51 delete at balance 0: hidden from lists and dashboard, marked in search, history kept', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'سليم');
    await addDebt(t, { customerId: c, expectedVersion: 0n, amount: 3000n, date: day() });
    await recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 0n, full: true, date: day() });
    const history = await statement(t, c);
    expect(history).toHaveLength(2);

    await deleteCustomer(t, c, 2n);
    expect(await customerList(t)).toEqual([]);
    expect((await dashboard(t)).debtors).toBe(0n);
    const found = await search(t, 'سليم');
    expect(found).toHaveLength(1);
    expect(found[0].deleted_at).not.toBeNull();
    expect(await statement(t, c)).toEqual(history);
  });

  test('AT-52 delete a customer who still owes: refused (service and DB trigger)', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'مديون');
    await addDebt(t, { customerId: c, expectedVersion: 0n, amount: 4200n, date: day() });
    await expect(deleteCustomer(t, c, 1n)).rejects.toMatchObject({ code: 'BALANCE_NOT_ZERO', message: 'BALANCE_NOT_ZERO: 4200' });
    // even if the service check were skipped, the DB refuses
    await expect(tx(t, async (x) => {
      await x.query(`UPDATE public.customers SET deleted_at = now() WHERE id = $1`, [c]);
    })).rejects.toThrow(/only at balance 0/);
  });

  test('AT-53 a deleted customer keeps its name: similar-name check offers restore, no duplicate', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'رامي');
    await deleteCustomer(t, c, 0n);
    const similar = await similarNames(t, 'رامي');
    expect(similar[0]).toMatchObject({ customer_id: c, name: 'رامي' });
    expect(similar[0].deleted_at).not.toBeNull();
    await expect(createCustomer(t, 'رامي')).rejects.toMatchObject({ code: '23505' });
  });

  test('AT-54 restore: back in lists with full history; drafts from before the delete are stale', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'عادل');
    await addDebt(t, { customerId: c, expectedVersion: 0n, amount: 900n, date: day() });
    await recordPayment(t, { customerId: c, expectedVersion: 1n, amount: 900n, date: day() });
    const history = await statement(t, c);
    const draftVersion = 2n;   // what a review card showed before the delete

    await deleteCustomer(t, c, 2n);
    await restoreCustomer(t, c);
    expect((await customerList(t)).map((x) => x.id)).toEqual([c]);
    expect(await statement(t, c)).toEqual(history);
    await expect(addDebt(t, { customerId: c, expectedVersion: draftVersion, amount: 100n, date: day() }))
      .rejects.toMatchObject({ code: 'STALE_DRAFT' });
    await expect(addDebt(t, { customerId: c, expectedVersion: 4n, amount: 100n, date: day() })).resolves.toBeDefined();
  });

  test('AT-55 draft on one device, customer deleted on another: confirm is rejected', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'منير');
    const draft = { customerId: c, expectedVersion: 0n, amount: 1500n, date: day() };
    await deleteCustomer(t, c, 0n);
    await expect(addDebt(t, draft)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // and the DB refuses money for a deleted customer even without LOCK-ACCOUNT
    await expect(tx(t, async (x) => {
      const op = await rawOperation(x, t, c, { amount: 1500n });
      await rawEntry(x, t, { ...op, customerId: c, signed: 1500n });
    })).rejects.toThrow(/deleted customers take no ledger entries/);
  });
});

describe('ة and ه', () => {
  test('AT-59 "حمزه" when "حمزة" exists: duplicate; search with either finds it', async () => {
    const t = await newTenant();
    const c = await createCustomer(t, 'حمزة');
    await expect(createCustomer(t, 'حمزه')).rejects.toMatchObject({ code: '23505' });
    expect((await search(t, 'حمزه')).map((x) => x.id)).toEqual([c]);
    expect((await search(t, 'حمزة')).map((x) => x.id)).toEqual([c]);
  });

  test('migration 006 refilled normalized_name for every stored name', async () => {
    const stale = await admin.query(`SELECT count(*) AS n FROM public.customer_names
      WHERE normalized_name <> public.sdb_normalize_name(name)`);
    expect(stale.rows[0].n).toBe(0n);
  });
});
