/** Smart Debt Book — canonical Drizzle table/type definitions.
 * Raw SQL migrations add security policies, triggers and deferred invariants.
 * Monetary columns use bigint (agorot), NEVER JavaScript floating point.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, varchar, integer, bigint, boolean,
  date, time, timestamp, jsonb, index, uniqueIndex, unique,
  foreignKey, primaryKey, check,
} from 'drizzle-orm/pg-core';

export const operationType = pgEnum('sdb_operation_type', [
  'DEBT', 'PAYMENT', 'OPENING_BALANCE', 'MERGE_TRANSFER',
]);
export const operationStatus = pgEnum('sdb_operation_status', [
  'ACTIVE', 'CANCELLED', 'INTERNAL',
]);
export const entryKind = pgEnum('sdb_entry_kind', [
  'ORIGINAL', 'REVERSAL', 'CORRECTION', 'MERGE_OUT', 'MERGE_IN',
]);

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  // FK to auth.users(id) is declared in migration SQL (Supabase-managed schema).
  ownerUserId: uuid('owner_user_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Jerusalem'),
  // Extra fields without a migration. Never money or balances (migration 006).
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
  // Logical delete (migration 006). Rows are never removed.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One ACTIVE store per owner; replaces stores_one_per_owner (migration 006).
  uniqueIndex('stores_one_active_per_owner').on(t.ownerUserId).where(sql`${t.deletedAt} IS NULL`),
  check('stores_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
  check('stores_timezone_check', sql`${t.timezone} = 'Asia/Jerusalem'`),
]);

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),
  phone: text('phone'),
  notes: text('notes'),
  mergedIntoCustomerId: uuid('merged_into_customer_id'),
  // Extra fields without a migration. Never money or balances (migration 006).
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
  // Logical delete, only at balance 0; DB trigger sdb_customer_delete_guard enforces it.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('customers_tenant_id').on(t.storeId, t.id),
  foreignKey({ name: 'customers_merge_same_store',
    columns: [t.storeId, t.mergedIntoCustomerId],
    foreignColumns: [t.storeId, t.id],
  }),
  check('customers_no_self_merge', sql`${t.mergedIntoCustomerId} IS NULL OR ${t.mergedIntoCustomerId} <> ${t.id}`),
]);

export const customerNames = pgTable('customer_names', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  name: text('name').notNull(),
  // DB trigger is authoritative, recomputes normalization on name/customer changes.
  normalizedName: text('normalized_name').notNull().default(''),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('customer_names_tenant_id').on(t.storeId, t.id),
  unique('customer_names_unique_within_store').on(t.storeId, t.normalizedName),
  uniqueIndex('customer_names_one_primary_per_customer').on(t.storeId,t.customerId).where(sql`${t.isPrimary}`),
  index('customer_names_customer_idx').on(t.storeId,t.customerId),
  // pg_trgm GIN index lives in migration 001_schema.sql.
  foreignKey({ name: 'customer_names_customer_fk',
    columns: [t.storeId,t.customerId],
    foreignColumns: [customers.storeId,customers.id],
  }),
  check('customer_names_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 180`),
]);

export const customerAccounts = pgTable('customer_accounts', {
  storeId: uuid('store_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  balanceAgorot: bigint('balance_agorot', { mode: 'bigint' }).notNull().default(0n),
  ledgerVersion: bigint('ledger_version', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.storeId,t.customerId] }),
  foreignKey({ name:'customer_accounts_customer_fk',
    columns:[t.storeId,t.customerId], foreignColumns:[customers.storeId,customers.id] }),
  check('customer_accounts_positive_balance',sql`${t.balanceAgorot} >= 0`),
  check('customer_accounts_nonnegative_version',sql`${t.ledgerVersion} >= 0`),
  index('customer_accounts_debtors_idx').on(t.storeId,t.balanceAgorot,t.customerId)
    .where(sql`${t.balanceAgorot} > 0`),
]);

export const ledgerOperations = pgTable('ledger_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  type: operationType('type').notNull(),
  status: operationStatus('status').notNull().default('ACTIVE'),
  amountAgorot: bigint('amount_agorot', { mode: 'bigint' }).notNull(),
  description: text('description'),
  effectiveDate: date('effective_date').notNull(),
  effectiveTime: time('effective_time', { precision: 0 }),
  revisionNo: integer('revision_no').notNull().default(1),
  // FK to auth.users is in migrations.
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ledger_operations_tenant_id').on(t.storeId,t.id),
  foreignKey({ name:'ledger_operations_customer_fk',
    columns:[t.storeId,t.customerId], foreignColumns:[customers.storeId,customers.id] }),
  check('ledger_operations_positive_amount',sql`${t.amountAgorot} > 0`),
  check('ledger_operations_positive_revision',sql`${t.revisionNo} >= 1`),
  check('ledger_operations_internal_status',sql`
    (${t.type} = 'MERGE_TRANSFER' AND ${t.status} = 'INTERNAL') OR
    (${t.type} <> 'MERGE_TRANSFER' AND ${t.status} IN ('ACTIVE','CANCELLED'))`),
  index('ledger_operations_store_created_idx').on(t.storeId,t.createdAt,t.id),
]);

export const operationRevisions = pgTable('operation_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull(),
  operationId: uuid('operation_id').notNull(),
  revisionNo: integer('revision_no').notNull(),
  customerId: uuid('customer_id').notNull(),
  type: operationType('type').notNull(),
  status: operationStatus('status').notNull(),
  amountAgorot: bigint('amount_agorot', { mode: 'bigint' }).notNull(),
  description: text('description'),
  effectiveDate: date('effective_date').notNull(),
  effectiveTime: time('effective_time', { precision: 0 }),
  changeReason: text('change_reason'),
  changedBy: uuid('changed_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('operation_revisions_tenant_id').on(t.storeId,t.id),
  unique('operation_revisions_version_unique').on(t.storeId,t.operationId,t.revisionNo),
  unique('operation_revisions_operation_version_fk').on(t.storeId,t.operationId,t.id),
  foreignKey({ name:'operation_revisions_operation_fk',
    columns:[t.storeId,t.operationId],foreignColumns:[ledgerOperations.storeId,ledgerOperations.id] }),
  foreignKey({ name:'operation_revisions_customer_fk',
    columns:[t.storeId,t.customerId],foreignColumns:[customers.storeId,customers.id] }),
  check('operation_revisions_positive_amount',sql`${t.amountAgorot} > 0`),
  check('operation_revisions_positive_version',sql`${t.revisionNo} >= 1`),
]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull(),
  operationId: uuid('operation_id').notNull(),
  revisionId: uuid('revision_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  kind: entryKind('kind').notNull(),
  signedAmountAgorot: bigint('signed_amount_agorot', { mode:'bigint' }).notNull(),
  reversesEntryId: uuid('reverses_entry_id'),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
}, (t) => [
  unique('ledger_entries_tenant_id').on(t.storeId,t.id),
  foreignKey({name:'ledger_entries_operation_revision_fk',
    columns:[t.storeId,t.operationId,t.revisionId],
    foreignColumns:[operationRevisions.storeId,operationRevisions.operationId,operationRevisions.id] }),
  foreignKey({name:'ledger_entries_customer_fk',
    columns:[t.storeId,t.customerId],foreignColumns:[customers.storeId,customers.id] }),
  foreignKey({name:'ledger_entries_reversal_fk',
    columns:[t.storeId,t.reversesEntryId], foreignColumns:[t.storeId,t.id] }),
  uniqueIndex('ledger_entries_reverse_once').on(t.storeId,t.reversesEntryId)
    .where(sql`${t.reversesEntryId} IS NOT NULL`),
  check('ledger_entries_nonzero',sql`${t.signedAmountAgorot} <> 0`),
  check('ledger_entries_reversal_shape',sql`
    (${t.kind}='REVERSAL' AND ${t.reversesEntryId} IS NOT NULL) OR
    (${t.kind}<>'REVERSAL' AND ${t.reversesEntryId} IS NULL)`),
  index('ledger_entries_operation_idx').on(t.storeId,t.operationId),
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),
  requestId: uuid('request_id').notNull(),
  requestHash: varchar('request_hash',{length:64}).notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id'),
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
  responseData: jsonb('response_data').notNull().default(sql`'{}'::jsonb`),
  actorUserId: uuid('actor_user_id').notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
}, (t) => [
  unique('audit_events_tenant_id').on(t.storeId,t.id),
  unique('audit_events_request_once').on(t.storeId,t.requestId),
  check('audit_events_request_hash_check',sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`),
  index('audit_events_resource_idx').on(t.storeId,t.resourceType,t.resourceId,t.createdAt),
]);
