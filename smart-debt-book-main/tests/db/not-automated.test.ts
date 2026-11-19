/** Cases from TEST_CASES.md that are not DB integration tests in the MVP. Listed so the report shows them. */
import { test } from 'vitest';

// Merge customers (FR-08) is out of the MVP (CLAUDE.md decision 1; changelog moves AT-20 to V2).
test.skip('26 merge customer with positive balance (V2)', () => {});
test.skip('27 merge customer with zero balance (V2)', () => {});
test.skip('28 merge with alias transfers (V2)', () => {});
test.skip('29 customer merge cycle (V2)', () => {});
test.skip('30 statement after merge (V2)', () => {});

// Not pass/fail tests: a benchmark, and a LedgerService rule.
test.todo('36 thousands of operations and aliases: latency, keyset paging, deferred-check cost (benchmark)');
test.todo('37 simultaneous name writes: service-level name advisory lock (LedgerService, plan step 5)');

// Backend parts of the changelog cases whose DB part is covered elsewhere.
test.todo('AT-56 store delete needs a fresh SMS code with the request (API tests)');
