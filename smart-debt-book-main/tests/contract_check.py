"""Offline structural checks; not a replacement for PostgreSQL integration tests."""
from pathlib import Path
import re
r=Path(__file__).resolve().parents[1]
core=(r/'migrations/001_schema.sql').read_text()
schema=(r/'src/db/schema.ts').read_text()
tables=re.findall(r'CREATE TABLE public\.(\w+)',core)
assert len(tables)==8 and len(set(tables))==8, tables
for table in tables:
    assert re.search(rf"pgTable\('{re.escape(table)}'",schema), f'Drizzle missing table: {table}'
for migration in sorted((r/'migrations').glob('*.sql')):
    body=migration.read_text()
    assert body.count('$$')%2 == 0, f'Unpaired dollar delimiter: {migration}'
for token in ['customer_names_unique_within_store','audit_events_request_once',
              'ledger_entries_reverse_once','customer_accounts_positive_balance',
              'sdb_operation_history_guard','sdb_account_history_guard',
              'sdb_operation_snapshot_guard','sdb_customer_names_guard',
              'sdb_operations_tenant','sdb_audit_tenant']:
    assert any(token in f.read_text() for f in (r/'migrations').glob('*.sql')), token
print('Static contract checks passed:',len(tables),'domain tables and required safeguards found.')
print('SQL is NOT tested against a live PostgreSQL server.')
