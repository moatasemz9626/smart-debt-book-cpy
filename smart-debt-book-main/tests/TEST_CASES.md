# Mandatory Database Integration Test Cases (Staging)

> لم تُنفذ على قاعدة فعلية في هذه الجلسة. أنشئ هوية Supabase Auth حقيقية لكل محل، واستخدم دور `sdb_app` ومعاملات `SET LOCAL` لا دور الإدارة عند اختبار RLS.

| # | Test | Expected result |
|---|---|---|
| 01 | Create store for authenticated owner | Succeeds; owner cannot create a second store in MVP |
| 02 | Create customer with primary name + account in ONE transaction | Succeeds; balance 0 and ledger_version 0 |
| 03 | Create customer without primary name or without account | COMMIT rejected by deferred guards |
| 04 | Two identical normalized names inside one store | Unique violation, including official vs alias collision |
| 05 | Same name in two different stores | Both allowed |
| 06 | Change an alias | One name row changes, normalized name updates automatically |
| 07 | Delete alias, then attempt deleting only primary name | Alias delete succeeds; primary delete rejects until new primary set in same transaction |
| 08 | Create debt + ledger entry + revision + account update | COMMIT succeeds, all three reconciliation representations equal |
| 09 | Create debt operation but omit its physical ledger posting | COMMIT rejects |
| 10 | Create ledger posting but omit corresponding account change | COMMIT rejects |
| 11 | Record payment exceeding present balance | Rejected by CHECK/deferred balance guard |
| 12 | Backdate a payment before all available debt | Rejected: negative historical prefix |
| 13 | Backdate a debt before a previously recorded payment | Succeeds if all historical prefixes stay nonnegative |
| 14 | Attempt to UPDATE or DELETE an existing ledger entry | Rejected by immutable trigger/permissions |
| 15 | Correct debt 150 to 120 via reversal+correction | Visible operation 120, postings total 120, originals retained |
| 16 | Reverse same entry twice | Unique violation; cannot double-reverse |
| 17 | Reverse entry with wrong amount or wrong customer | Rejected |
| 18 | Change nonfinancial note/date with new revision and no posting | Allowed if historical prefixes remain nonnegative |
| 19 | Change operation amount but omit matching new revision | Rejected |
| 20 | Cancel an earlier debt that funded a later payment | Rejected if historical balance would go negative |
| 21 | Two devices confirm against the same ledger_version | First succeeds; second must refresh/reconfirm |
| 22 | Retried request_id with same request_hash, first already committed | Same saved response; no additional posting |
| 23 | Retried request_id with changed request_hash | 409 and no changes |
| 24 | Commit succeeded but HTTP response was lost | Retry with same request_id safely returns saved outcome |
| 25 | Two concurrent identical request_id transactions | Advisory lock + unique receipt ensures only one effect |
| 26 | Merge customer with positive balance into another | Out/in entries balance; source ends 0, target increases correctly |
| 27 | Merge customer with zero balance | No zero-valued financial posting needed |
| 28 | Merge with alias transfers | Names move; exactly one target primary; source has no names |
| 29 | Attempt customer merge cycle | Rejected |
| 30 | Statement after merge | Includes active original operations from both accounts, excludes MERGE_TRANSFER from visible total |
| 31 | Access store B customers using store A verified session | Returns none / rejected by RLS |
| 32 | Forge customer_id from another tenant in store A ledger | Composite FK prevents operation |
| 33 | Connect using restricted role with no transaction context | No tenant records accessible |
| 34 | Reuse pooled connection after transaction | SET LOCAL context does not leak to next transaction |
| 35 | Change effective_date with effective_time NULL | Time remains NULL; no fabricated clock time |
| 36 | Thousands of operations and aliases | Measure query latency, 30-item keyset scrolling, deferred check cost |
| 37 | Multiple simultaneous name writes within one store | Service-level name advisory lock avoids unreviewed near-duplicates |
| 38 | Try to directly write protected immutable audit_events/revisions | UPDATE/DELETE rejected |
| 39 | Customer account balance altered without ledger operation | COMMIT rejects by reconciliation trigger |
| 40 | Report total and monthly payments after corrections | Dashboard uses active operations only; no double count of reversals/merges |

**Additional releases gates:** measure actual PostgreSQL lock/contention behavior (including deadlocks and timeouts), validate permission RLS against actual Supabase credentials and pooling, perform backup & restore exercise, and run repeated concurrency tests before first real shop data.
