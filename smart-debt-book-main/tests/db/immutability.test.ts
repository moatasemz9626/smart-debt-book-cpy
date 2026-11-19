/** TEST_CASES 14, 38: append-only tables, for sdb_app and even for the table owner. */
import { describe, expect, test } from 'vitest';
import { tx, admin, newTenant, createCustomer, addDebt, day } from './helpers.js';

const APPEND_ONLY = ['ledger_entries', 'operation_revisions', 'audit_events'];

describe.each(APPEND_ONLY)('%s is append-only', (table) => {
  test('14/38 sdb_app cannot UPDATE or DELETE', async () => {
    const t = await newTenant(); const c = await createCustomer(t, 'زبون');
    await addDebt(t, { customerId: c, expectedVersion: 0n, amount: 1000n, date: day() });
    await expect(tx(t, (x) => x.query(`UPDATE public.${table} SET created_at = now()`))).rejects.toMatchObject({ code: '42501' });
    await expect(tx(t, (x) => x.query(`DELETE FROM public.${table}`))).rejects.toMatchObject({ code: '42501' });
  });

  test('14/38 even the migration user is stopped by the trigger', async () => {
    const t = await newTenant(); const c = await createCustomer(t, 'زبون');
    await addDebt(t, { customerId: c, expectedVersion: 0n, amount: 1000n, date: day() });
    const client = await admin.connect();
    try {
      for (const sql of [`UPDATE public.${table} SET created_at = now() WHERE store_id = $1`,
                         `DELETE FROM public.${table} WHERE store_id = $1`]) {
        await client.query('BEGIN');
        await expect(client.query(sql, [t.storeId])).rejects.toThrow(/append-only/);
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
  });
});
