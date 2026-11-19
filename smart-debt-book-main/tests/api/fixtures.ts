import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { api, today, type Api } from './client.js';
import { newOwner } from '../db/helpers.js';

export async function ownerWithStore(name = 'بقالة الأمل') {
  const owner = await newOwner();
  const a = api(owner.accessToken);
  const s = await a.createStore(name);
  expect(s.status).toBe(201);
  return { owner, a, store: s.body.store as { id: string; name: string } };
}

export async function newCustomer(a: Api, opts: { name?: string; balance?: string; date?: string } = {}) {
  const r = await a.createCustomer({
    name: opts.name ?? `زبون ${randomUUID().slice(0, 8)}`, force: true,
    ...(opts.balance ? { opening_balance_agorot: opts.balance, opening_date: opts.date ?? today() } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.customer as { id: string; primary_name: string; ledger_version: string; balance_agorot: string };
}

/** Add a debt and return the operation id and the new version. */
export async function debt(a: Api, customerId: string, version: string, amount: string, date = today()) {
  const r = await a.addDebt(customerId, { expected_version: version, amount_agorot: amount, effective_date: date });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { operation_id: string; balance_agorot: string; ledger_version: string };
}

export async function payment(a: Api, customerId: string, version: string, amount: string, date = today()) {
  const r = await a.pay(customerId, { expected_version: version, amount_agorot: amount, effective_date: date });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { operation_id: string; balance_agorot: string; ledger_version: string };
}
