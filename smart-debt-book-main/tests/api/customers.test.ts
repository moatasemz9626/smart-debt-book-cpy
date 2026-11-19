/** C-02 … C-08 through the API. */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { today } from './client.js';
import { ownerWithStore, newCustomer, debt, payment } from './fixtures.js';
import { admin } from '../db/helpers.js';

describe('C-02 edit phone & notes', () => {
  test('updates, normalizes the phone, can clear both', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const r = await a.updateCustomer(c.id, { phone: '+972 52-765-4321', notes: 'يدفع آخر الشهر' });
    expect(r.body.customer).toMatchObject({ phone: '+972527654321', notes: 'يدفع آخر الشهر' });
    const cleared = await a.updateCustomer(c.id, { phone: null, notes: '' });
    expect(cleared.body.customer).toMatchObject({ phone: null, notes: null });
    expect((await a.updateCustomer(c.id, { phone: '12345' })).status).toBe(400);
  });

  test('does not change the ledger version (not a money change)', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { balance: '500' });
    const r = await a.updateCustomer(c.id, { phone: null, notes: 'x' });
    expect(r.body.customer.ledger_version).toBe('1');
  });
});

describe('C-03 rename and C-04/C-05 aliases', () => {
  test('rename keeps the old name as an alias by default; both find the customer', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { name: 'أبو أحمد' });
    const r = await a.rename(c.id, { new_name: 'محمود الخطيب' });
    expect(r.body.customer).toMatchObject({ primary_name: 'محمود الخطيب', aliases: [{ name: 'أبو أحمد' }] });
    expect((await a.search('ابو احمد')).body.results.map((x: any) => x.id)).toEqual([c.id]);
    expect((await a.search('الخطيب')).body.results.map((x: any) => x.id)).toEqual([c.id]);
  });

  test('rename without keeping the old name; spelling-only change does not create a twin alias', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { name: 'سامي' });
    expect((await a.rename(c.id, { new_name: 'سامي الحلبي', keep_old_as_alias: false })).body.customer.aliases).toEqual([]);
    const d = await newCustomer(a, { name: 'احمد ياسين' });
    const r = await a.rename(d.id, { new_name: 'أحمد ياسين' });            // only the hamza changed
    expect(r.body.customer).toMatchObject({ primary_name: 'أحمد ياسين', aliases: [] });
  });

  test('rename or alias to a name another customer has → 409 NAME_EXISTS', async () => {
    const { a } = await ownerWithStore();
    await newCustomer(a, { name: 'خالد' });
    const other = await newCustomer(a, { name: 'وليد' });
    expect((await a.rename(other.id, { new_name: 'خالد' })).body.error.code).toBe('NAME_EXISTS');
    expect((await a.addAlias(other.id, 'خالِد')).body.error.code).toBe('NAME_EXISTS');   // tashkeel ignored
  });

  test('add alias 201, delete alias 204, primary name → 422 PRIMARY_NAME, unknown → 404', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { name: 'جميل' });
    const al = await a.addAlias(c.id, 'أبو جمال');
    expect(al).toMatchObject({ status: 201, body: { alias: { name: 'أبو جمال' } } });
    expect((await a.deleteAlias(c.id, al.body.alias.id)).status).toBe(204);
    expect((await a.customerPage(c.id)).body.customer.aliases).toEqual([]);

    const primary = await admin.query(`SELECT id FROM public.customer_names WHERE customer_id = $1 AND is_primary`, [c.id]);
    expect(await a.deleteAlias(c.id, primary.rows[0].id)).toMatchObject({ status: 422, body: { error: { code: 'PRIMARY_NAME' } } });
    expect((await a.deleteAlias(c.id, randomUUID())).status).toBe(404);
    expect((await a.customerPage(c.id)).body.customer.primary_name).toBe('جميل');
  });

  test('delete alias replays as 204 with the same key', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    const al = await a.addAlias(c.id, `لقب ${randomUUID().slice(0, 4)}`);
    const key = randomUUID();
    expect((await a.deleteAlias(c.id, al.body.alias.id, key)).status).toBe(204);
    expect(await a.deleteAlias(c.id, al.body.alias.id, key)).toMatchObject({ status: 204, replayed: true });
  });
});

describe('C-07 delete and C-08 restore (AT-51 … AT-55)', () => {
  test('delete at balance 0: gone from list, marked last in search, history kept; restore brings it back', async () => {
    const { a } = await ownerWithStore();
    const keep = await newCustomer(a, { name: 'سليم أ' });
    const c = await newCustomer(a, { name: 'سليم ب', balance: '700' });
    const p = await payment(a, c.id, '1', '700');
    const del = await a.deleteCustomer(c.id, p.ledger_version);
    expect(del).toMatchObject({ status: 200, body: { customer_id: c.id, balance_agorot: '0', ledger_version: '3' } });

    expect((await a.listCustomers({ filter: 'all' })).body.customers.map((x: any) => x.id)).toEqual([keep.id]);
    const found = (await a.search('سليم')).body.results;
    expect(found.map((x: any) => x.id)).toEqual([keep.id, c.id]);           // deleted last
    expect(found[1].deleted_at).not.toBeNull();
    expect((await a.customerPage(c.id)).body.operations).toHaveLength(2);    // history kept

    const back = await a.restoreCustomer(c.id);
    expect(back.body.customer).toMatchObject({ id: c.id, deleted_at: null, ledger_version: '4' });
    expect((await a.listCustomers({ filter: 'all' })).body.customers).toHaveLength(2);
  });

  test('delete while money is owed → 422 BALANCE_NOT_ZERO with the balance', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { balance: '4200' });
    expect(await a.deleteCustomer(c.id, '1')).toMatchObject({ status: 422, body: { error: { code: 'BALANCE_NOT_ZERO', details: { balance_agorot: '4200' } } } });
  });

  test('a deleted customer keeps its name: create offers restore (NAME_EXISTS, deleted: true)', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a, { name: 'رامي' });
    await a.deleteCustomer(c.id, '0');
    expect(await a.createCustomer({ name: 'رامي', force: true }))
      .toMatchObject({ status: 409, body: { error: { code: 'NAME_EXISTS', details: { customer_id: c.id, deleted: true } } } });
  });

  test('draft confirmed after the customer was deleted elsewhere → 409 CUSTOMER_DELETED; edits too', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    await a.deleteCustomer(c.id, '0');
    expect((await a.addDebt(c.id, { expected_version: '0', amount_agorot: '100', effective_date: today() })).body.error.code).toBe('CUSTOMER_DELETED');
    expect((await a.updateCustomer(c.id, { notes: 'x' })).body.error.code).toBe('CUSTOMER_DELETED');
    expect((await a.addAlias(c.id, 'لقب')).body.error.code).toBe('CUSTOMER_DELETED');
  });

  test('after restore, a draft from before the delete is stale', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    await a.deleteCustomer(c.id, '0');
    await a.restoreCustomer(c.id);
    expect((await a.addDebt(c.id, { expected_version: '0', amount_agorot: '100', effective_date: today() })).body.error.code).toBe('STALE_DRAFT');
    expect((await debt(a, c.id, '2', '100')).ledger_version).toBe('3');
  });

  test('restore a customer that is not deleted → 404', async () => {
    const { a } = await ownerWithStore();
    const c = await newCustomer(a);
    expect((await a.restoreCustomer(c.id)).status).toBe(404);
  });
});
