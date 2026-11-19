/** The Customer object of the API contract, read inside an open store transaction. */
import type { Db } from '../db/pool';
import type { Tenant } from '../db/tenant';
import { AppError } from './errors';
import { iso } from './write';

export type CustomerDto = {
  id: string; primary_name: string; aliases: { id: string; name: string }[];
  phone: string | null; notes: string | null; deleted_at: string | null;
  balance_agorot: string; ledger_version: string;
};

export async function loadCustomer(db: Db, t: Tenant, customerId: string): Promise<CustomerDto> {
  const head = await db.query(`
    SELECT c.id, c.phone, c.notes, ${iso('c.deleted_at')} AS deleted_at,
           a.balance_agorot::text AS balance_agorot, a.ledger_version::text AS ledger_version
    FROM public.customers c
    JOIN public.customer_accounts a ON a.store_id = c.store_id AND a.customer_id = c.id
    WHERE c.store_id = $1 AND c.id = $2`, [t.storeId, customerId]);
  if (!head.rowCount) throw new AppError('NOT_FOUND');
  const names = await db.query<{ id: string; name: string; is_primary: boolean }>(`
    SELECT id, name, is_primary FROM public.customer_names
    WHERE store_id = $1 AND customer_id = $2 ORDER BY is_primary DESC, created_at, id`, [t.storeId, customerId]);
  const h = head.rows[0];
  return {
    id: h.id, primary_name: names.rows.find((n) => n.is_primary)?.name ?? '',
    aliases: names.rows.filter((n) => !n.is_primary).map(({ id, name }) => ({ id, name })),
    phone: h.phone, notes: h.notes, deleted_at: h.deleted_at,
    balance_agorot: h.balance_agorot, ledger_version: h.ledger_version,
  };
}

/** For writes that need an existing, not deleted customer (C-02, C-03, C-04, C-05). Locks the customer row. */
export async function lockActiveCustomer(db: Db, t: Tenant, customerId: string) {
  const c = await db.query<{ deleted: boolean }>(`SELECT deleted_at IS NOT NULL AS deleted FROM public.customers
    WHERE store_id = $1 AND id = $2 FOR UPDATE`, [t.storeId, customerId]);
  if (!c.rowCount) throw new AppError('NOT_FOUND');
  if (c.rows[0]!.deleted) throw new AppError('CUSTOMER_DELETED', { customer_id: customerId });
}
