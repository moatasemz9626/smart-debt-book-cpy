/** TEST_CASES 21–25. */
import { describe, expect, test } from 'vitest';
import { tx, newTenant, createCustomer, addDebt, account, day, req, lookupRequest, type Tenant } from './helpers.js';

async function setup() {
  const t = await newTenant();
  const c = await createCustomer(t, 'زبون');
  return { t, c, draft: { customerId: c, expectedVersion: 0n, amount: 2500n, date: day() } };
}

const operationCount = (t: Tenant, c: string) =>
  tx(t, async (x) => (await x.query(`SELECT count(*) AS n FROM public.ledger_operations WHERE customer_id = $1`, [c])).rows[0].n as bigint);

describe('stale drafts', () => {
  test('21 two devices confirm against the same ledger_version: first wins, second is stale', async () => {
    const { t, c, draft } = await setup();
    await addDebt(t, draft);
    await expect(addDebt(t, { ...draft, amount: 999n })).rejects.toMatchObject({ code: 'STALE_DRAFT' });
    expect(await account(t, c)).toEqual({ balance_agorot: 2500n, ledger_version: 1n });
  });

  test('21b same thing, truly concurrent', async () => {
    const { t, c, draft } = await setup();
    const results = await Promise.allSettled([addDebt(t, draft), addDebt(t, { ...draft, amount: 999n })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_DRAFT' } });
    expect((await account(t, c))!.ledger_version).toBe(1n);
    expect(await operationCount(t, c)).toBe(1n);
  });
});

describe('idempotency by request_id', () => {
  test('22 retry with the same request_id and hash returns the saved response, no new posting', async () => {
    const { t, c, draft } = await setup();
    const r = req(draft);
    const first = await addDebt(t, draft, r);
    const retry = await addDebt(t, draft, r);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.response).toEqual(JSON.parse(JSON.stringify(first.response, (_k, v) => typeof v === 'bigint' ? v.toString() : v)));
    expect(await operationCount(t, c)).toBe(1n);
  });

  test('23 same request_id with a different hash: 409, nothing changes', async () => {
    const { t, c, draft } = await setup();
    const r = req(draft);
    await addDebt(t, draft, r);
    await expect(addDebt(t, { ...draft, amount: 9999n }, { id: r.id, hash: req({ other: 1 }).hash }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await account(t, c)).toEqual({ balance_agorot: 2500n, ledger_version: 1n });
  });

  test('24 response lost after COMMIT: R-06 finds it, retry returns the saved outcome', async () => {
    const { t, c, draft } = await setup();
    const r = req(draft);
    await addDebt(t, draft, r);                       // the client never saw this answer
    const found = await lookupRequest(t, r.id);       // R-06
    expect(found).toMatchObject({ action: 'OPERATION_CREATE' });
    const retry = await addDebt(t, draft, r);
    expect(retry).toMatchObject({ replayed: true, response: found.response_data });
    expect(await operationCount(t, c)).toBe(1n);

    expect(await lookupRequest(t, req().id)).toBeUndefined();   // unknown id: not saved, safe to retry
  });

  test('25 two concurrent transactions with the same request_id: one effect', async () => {
    const { t, c, draft } = await setup();
    const r = req(draft);
    const results = await Promise.all([addDebt(t, draft, r), addDebt(t, draft, r), addDebt(t, draft, r)]);
    expect(results.map((x) => x.replayed).sort()).toEqual([false, true, true]);
    expect(await operationCount(t, c)).toBe(1n);
    expect(await account(t, c)).toEqual({ balance_agorot: 2500n, ledger_version: 1n });
  });
});
