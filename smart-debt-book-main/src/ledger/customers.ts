/** C-01 … C-05, C-07, C-08: customer writes. C-06 Search is in reads.ts. */
import { randomUUID } from 'node:crypto';
import { withStoreTransaction } from '../db/tenant';
import { AppError } from './errors';
import { lockAccount, post } from './operations';
import { loadCustomer, lockActiveCustomer } from './customer-dto';
import { idempotentWrite, type RequestKey } from './write';

export type CreateCustomerInput = {
  name: string;
  phone: string | null;
  notes: string | null;
  openingBalanceAgorot: bigint | null;
  openingDate: string;               // YYYY-MM-DD; today in Asia/Jerusalem when not given
  force: boolean;                    // true: owner saw the similar names and still wants a new customer
};

export function createCustomer(userId: string, input: CreateCustomerInput, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    // Same normalized name already in the store (deleted customers keep theirs): never a duplicate.
    const exact = await db.query<{ customer_id: string; deleted: boolean }>(`
      SELECT n.customer_id, c.deleted_at IS NOT NULL AS deleted
      FROM public.customer_names n
      JOIN public.customers c ON c.store_id = n.store_id AND c.id = n.customer_id
      WHERE n.store_id = $1 AND n.normalized_name = public.sdb_normalize_name($2)`, [t.storeId, input.name]);
    if (exact.rowCount) throw new AppError('NAME_EXISTS', exact.rows[0]);

    // C-01 step 1: similar names, deleted included. Stop unless the owner forces a new customer.
    if (!input.force) {
      const similar = await db.query<{ customer_id: string; name: string; deleted: boolean; score: number }>(`
        SELECT n.customer_id, n.name, c.deleted_at IS NOT NULL AS deleted,
               round(word_similarity(public.sdb_normalize_name($2), n.normalized_name)::numeric, 2)::float8 AS score
        FROM public.customer_names n
        JOIN public.customers c ON c.store_id = n.store_id AND c.id = n.customer_id
        WHERE n.store_id = $1
          AND (n.normalized_name LIKE '%' || public.sdb_normalize_name($2) || '%'
               OR word_similarity(public.sdb_normalize_name($2), n.normalized_name) >= 0.3)
        ORDER BY score DESC LIMIT 5`, [t.storeId, input.name]);
      if (similar.rowCount) throw new AppError('SIMILAR_NAMES', { matches: similar.rows });
    }

    // C-01 step 2: the three rows.
    const customerId = randomUUID();
    await db.query(`INSERT INTO public.customers (id, store_id, phone, notes) VALUES ($1, $2, $3, $4)`,
      [customerId, t.storeId, input.phone, input.notes]);
    await db.query(`INSERT INTO public.customer_accounts (store_id, customer_id) VALUES ($1, $2)`, [t.storeId, customerId]);
    const name = await db.query<{ id: string; name: string }>(`INSERT INTO public.customer_names
      (store_id, customer_id, name, is_primary) VALUES ($1, $2, btrim($3), true) RETURNING id, name`,
      [t.storeId, customerId, input.name]);

    // C-01 step 3: opening balance as its own OPENING_BALANCE operation.
    let balance = '0', version = '0';
    if (input.openingBalanceAgorot !== null && input.openingBalanceAgorot > 0n) {
      const opening = await post(db, t, 'OPENING_BALANCE', {
        customerId, expectedVersion: 0n, amountAgorot: input.openingBalanceAgorot, description: null,
        effectiveDate: input.openingDate, effectiveTime: null,
      });
      balance = opening.body.balance_agorot as string;
      version = opening.body.ledger_version as string;
    }

    return {
      action: 'CUSTOMER_CREATE', resourceType: 'customer', resourceId: customerId,
      details: { name: name.rows[0]!.name, opening_balance_agorot: input.openingBalanceAgorot?.toString() ?? null },
      body: {
        customer: {
          id: customerId, primary_name: name.rows[0]!.name, aliases: [], phone: input.phone, notes: input.notes,
          deleted_at: null, balance_agorot: balance, ledger_version: version,
        },
      },
    };
  }));
}

/** C-02 Edit phone & notes. */
export function updateCustomer(userId: string, customerId: string, input: { phone: string | null; notes: string | null }, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    await lockActiveCustomer(db, t, customerId);
    await db.query(`UPDATE public.customers SET phone = $3, notes = $4, updated_at = now()
      WHERE store_id = $1 AND id = $2 AND deleted_at IS NULL`, [t.storeId, customerId, input.phone, input.notes]);
    return { action: 'CUSTOMER_UPDATE', resourceType: 'customer', resourceId: customerId,
      body: { customer: await loadCustomer(db, t, customerId) } };
  }));
}

/** C-03 Rename: the primary name changes; the old one can stay as an alias (it still finds the customer). */
export function renameCustomer(userId: string, customerId: string, input: { newName: string; keepOldAsAlias: boolean }, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    await lockActiveCustomer(db, t, customerId);
    const old = await db.query<{ name: string; same: boolean }>(`
      SELECT name, normalized_name = public.sdb_normalize_name($3) AS same FROM public.customer_names
      WHERE store_id = $1 AND customer_id = $2 AND is_primary FOR UPDATE`, [t.storeId, customerId, input.newName]);
    const oldName = old.rows[0]!.name;
    await db.query(`UPDATE public.customer_names SET name = btrim($3)
      WHERE store_id = $1 AND customer_id = $2 AND is_primary`, [t.storeId, customerId, input.newName]);
    // Same normalized form (e.g. only a hamza changed): the old spelling cannot be a separate alias.
    if (input.keepOldAsAlias && !old.rows[0]!.same) {
      await db.query(`INSERT INTO public.customer_names (store_id, customer_id, name, is_primary) VALUES ($1, $2, $3, false)`,
        [t.storeId, customerId, oldName]);
    }
    return { action: 'CUSTOMER_RENAME', resourceType: 'customer', resourceId: customerId,
      details: { old_name: oldName, new_name: input.newName.trim(), kept_as_alias: input.keepOldAsAlias },
      body: { customer: await loadCustomer(db, t, customerId) } };
  }));
}

/** C-04 Add alias. A name already used in the store (deleted customers included) → NAME_EXISTS. */
export function addAlias(userId: string, customerId: string, alias: string, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    await lockActiveCustomer(db, t, customerId);
    const ins = await db.query<{ id: string; name: string }>(`INSERT INTO public.customer_names
      (store_id, customer_id, name, is_primary) VALUES ($1, $2, btrim($3), false) RETURNING id, name`,
      [t.storeId, customerId, alias]);
    const row = ins.rows[0]!;
    return { action: 'ALIAS_ADD', resourceType: 'customer_name', resourceId: row.id,
      details: { customer_id: customerId, alias: row.name }, body: { alias: row } };
  }));
}

/** C-05 Delete alias: the only real DELETE in the app. A primary name cannot be deleted (rename it, C-03). */
export function deleteAlias(userId: string, customerId: string, nameId: string, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    await lockActiveCustomer(db, t, customerId);
    const del = await db.query<{ name: string }>(`DELETE FROM public.customer_names
      WHERE store_id = $1 AND customer_id = $2 AND id = $3 AND NOT is_primary RETURNING name`, [t.storeId, customerId, nameId]);
    if (!del.rowCount) {
      const primary = await db.query(`SELECT 1 FROM public.customer_names WHERE store_id = $1 AND customer_id = $2 AND id = $3`,
        [t.storeId, customerId, nameId]);
      throw new AppError(primary.rowCount ? 'PRIMARY_NAME' : 'NOT_FOUND');
    }
    return { action: 'ALIAS_DELETE', resourceType: 'customer_name', resourceId: nameId,
      details: { customer_id: customerId, alias: del.rows[0]!.name }, body: {} };
  }));
}

/** C-07 Delete customer: only at balance 0. History, names and account stay. Bumps ledger_version to kill drafts. */
export function deleteCustomer(userId: string, customerId: string, expectedVersion: bigint, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    const account = await lockAccount(db, t, customerId, expectedVersion);
    if (account.balance_agorot !== 0n) throw new AppError('BALANCE_NOT_ZERO', { balance_agorot: account.balance_agorot.toString() });
    await db.query(`UPDATE public.customers SET deleted_at = now(), updated_at = now() WHERE store_id = $1 AND id = $2`, [t.storeId, customerId]);
    const a = await db.query<{ ledger_version: bigint }>(`UPDATE public.customer_accounts SET ledger_version = ledger_version + 1
      WHERE store_id = $1 AND customer_id = $2 RETURNING ledger_version`, [t.storeId, customerId]);
    return { action: 'CUSTOMER_DELETE', resourceType: 'customer', resourceId: customerId,
      body: { customer_id: customerId, balance_agorot: '0', ledger_version: a.rows[0]!.ledger_version.toString() } };
  }));
}

/** C-08 Restore customer: back with full history; bumps ledger_version so older drafts are stale. */
export function restoreCustomer(userId: string, customerId: string, key: RequestKey) {
  return withStoreTransaction(userId, (db, t) => idempotentWrite(db, t, key, async () => {
    await db.query(`SELECT ledger_version FROM public.customer_accounts WHERE store_id = $1 AND customer_id = $2 FOR UPDATE`,
      [t.storeId, customerId]);
    const u = await db.query(`UPDATE public.customers SET deleted_at = NULL, updated_at = now()
      WHERE store_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, [t.storeId, customerId]);
    if (!u.rowCount) throw new AppError('NOT_FOUND', { reason: 'no deleted customer with this id' });
    await db.query(`UPDATE public.customer_accounts SET ledger_version = ledger_version + 1
      WHERE store_id = $1 AND customer_id = $2`, [t.storeId, customerId]);
    return { action: 'CUSTOMER_RESTORE', resourceType: 'customer', resourceId: customerId,
      body: { customer: await loadCustomer(db, t, customerId) } };
  }));
}
