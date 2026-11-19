/** Structural smoke check. Full business tests require seed data and Auth users. */
import pg from 'pg';
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL is required');
const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const expected = ['stores','customers','customer_names','customer_accounts',
    'ledger_operations','ledger_entries','operation_revisions','audit_events'];
  const { rows: tables } = await db.query(`
    SELECT c.relname,c.relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`, [expected]);
  for (const name of expected) {
    const row = tables.find((x)=>x.relname===name);
    if (!row) throw new Error(`Missing table ${name}`);
    if (!row.relrowsecurity) throw new Error(`RLS is not enabled on ${name}`);
  }
  const { rows: functions } = await db.query(`
    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND proname LIKE 'sdb_%'`);
  for (const name of ['sdb_verify_historical_balance','sdb_verify_operation',
    'sdb_verify_customer_structure','sdb_verify_reversal']) {
    if (!functions.some((x)=>x.proname===name)) throw new Error(`Missing function ${name}`);
  }
  const { rows: policies } = await db.query(`SELECT tablename FROM pg_policies
    WHERE schemaname='public' AND policyname LIKE 'sdb_%'`);
  for (const name of expected) {
    if (!policies.some((x)=>x.tablename===name)) throw new Error(`Missing policy for ${name}`);
  }
  console.log('Structural verification passed: eight domain tables, RLS and key functions.');
  console.log('NOT a substitute for transaction, merge, conflict and tenant isolation tests.');
} finally { await db.end(); }
