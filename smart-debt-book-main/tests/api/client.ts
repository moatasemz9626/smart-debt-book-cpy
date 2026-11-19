/** Calls Next.js route handlers directly with real Request objects and real Supabase tokens. */
import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { closePool } from '@/db/pool';
import * as store from '../../app/api/v1/store/route';
import * as storePreview from '../../app/api/v1/store/delete-preview/route';
import * as storeRestore from '../../app/api/v1/store/restore/route';
import * as customers from '../../app/api/v1/customers/route';
import * as search from '../../app/api/v1/customers/search/route';
import * as customer from '../../app/api/v1/customers/[id]/route';
import * as rename from '../../app/api/v1/customers/[id]/rename/route';
import * as aliases from '../../app/api/v1/customers/[id]/aliases/route';
import * as alias from '../../app/api/v1/customers/[id]/aliases/[nameId]/route';
import * as customerDelete from '../../app/api/v1/customers/[id]/delete/route';
import * as customerRestore from '../../app/api/v1/customers/[id]/restore/route';
import * as statement from '../../app/api/v1/customers/[id]/statement/route';
import * as debts from '../../app/api/v1/customers/[id]/debts/route';
import * as payments from '../../app/api/v1/customers/[id]/payments/route';
import * as opening from '../../app/api/v1/customers/[id]/opening-balance/route';
import * as operation from '../../app/api/v1/operations/[id]/route';
import * as cancel from '../../app/api/v1/operations/[id]/cancel/route';
import * as dashboard from '../../app/api/v1/dashboard/route';
import * as activity from '../../app/api/v1/activity/route';
import * as requests from '../../app/api/v1/requests/[id]/route';

afterAll(closePool);

type Handler = (r: Request, c?: { params: Promise<Record<string, string>> }) => Promise<Response>;

export type ApiReply = { status: number; body: any; replayed: boolean; raw: string };

export async function call(handler: Handler, opts: {
  method: string; path: string; token?: string | null; body?: unknown; rawBody?: string;
  key?: string | null; params?: Record<string, string>;
}): Promise<ApiReply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers['idempotency-key'] = opts.key;
  const req = new Request(`http://localhost/api/v1${opts.path}`, {
    method: opts.method, headers,
    body: opts.method === 'GET' || opts.method === 'DELETE' ? undefined : (opts.rawBody ?? JSON.stringify(opts.body ?? {})),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null, replayed: res.headers.get('idempotent-replayed') === 'true', raw };
}

const qs = (q: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]).toString();
  return p ? `?${p}` : '';
};

/** Every endpoint, as the mobile app will call it. Writes get a fresh Idempotency-Key unless one is given. */
export function api(token: string) {
  const w = (h: Handler, method: string, path: string, body: unknown, params?: Record<string, string>, key: string = randomUUID()) =>
    call(h, { method, path, token, body, key, params });
  const r = (h: Handler, path: string, params?: Record<string, string>) => call(h, { method: 'GET', path, token, params });
  return {
    getStore: () => r(store.GET, '/store'),
    createStore: (name: string, key?: string) => w(store.POST, 'POST', '/store', { name }, undefined, key),
    renameStore: (name: string, key?: string) => w(store.PATCH, 'PATCH', '/store', { name }, undefined, key),
    deletePreview: () => r(storePreview.GET, '/store/delete-preview'),
    restoreStore: (storeId: string, key?: string) => w(storeRestore.POST, 'POST', '/store/restore', { store_id: storeId }, undefined, key),

    listCustomers: (q: { filter?: string; sort?: string } = {}) => r(customers.GET, `/customers${qs(q)}`),
    search: (q: string) => r(search.GET, `/customers/search${qs({ q })}`),
    createCustomer: (body: Record<string, unknown>, key?: string) => w(customers.POST, 'POST', '/customers', body, undefined, key),
    customerPage: (id: string, cursor?: string) => r(customer.GET, `/customers/${id}${qs({ cursor })}`, { id }),
    updateCustomer: (id: string, body: Record<string, unknown>, key?: string) => w(customer.PATCH, 'PATCH', `/customers/${id}`, body, { id }, key),
    rename: (id: string, body: Record<string, unknown>, key?: string) => w(rename.POST, 'POST', `/customers/${id}/rename`, body, { id }, key),
    addAlias: (id: string, aliasName: string, key?: string) => w(aliases.POST, 'POST', `/customers/${id}/aliases`, { alias: aliasName }, { id }, key),
    deleteAlias: (id: string, nameId: string, key?: string) =>
      w(alias.DELETE, 'DELETE', `/customers/${id}/aliases/${nameId}`, undefined, { id, nameId }, key),
    deleteCustomer: (id: string, expectedVersion: string, key?: string) =>
      w(customerDelete.POST, 'POST', `/customers/${id}/delete`, { expected_version: expectedVersion }, { id }, key),
    restoreCustomer: (id: string, key?: string) => w(customerRestore.POST, 'POST', `/customers/${id}/restore`, {}, { id }, key),
    statement: (id: string) => r(statement.GET, `/customers/${id}/statement`, { id }),

    addDebt: (id: string, body: Record<string, unknown>, key?: string) => w(debts.POST, 'POST', `/customers/${id}/debts`, body, { id }, key),
    pay: (id: string, body: Record<string, unknown>, key?: string) => w(payments.POST, 'POST', `/customers/${id}/payments`, body, { id }, key),
    openingBalance: (id: string, body: Record<string, unknown>, key?: string) =>
      w(opening.POST, 'POST', `/customers/${id}/opening-balance`, body, { id }, key),
    edit: (opId: string, body: Record<string, unknown>, key?: string) => w(operation.PATCH, 'PATCH', `/operations/${opId}`, body, { id: opId }, key),
    cancel: (opId: string, body: Record<string, unknown>, key?: string) => w(cancel.POST, 'POST', `/operations/${opId}/cancel`, body, { id: opId }, key),

    dashboard: () => r(dashboard.GET, '/dashboard'),
    activity: (q: { from?: string; to?: string; cursor?: string; customer_id?: string } = {}) => r(activity.GET, `/activity${qs(q)}`),
    lookup: (key: string) => r(requests.GET, `/requests/${key}`, { id: key }),
  };
}

export type Api = ReturnType<typeof api>;

export const handlers = { store, customers, customer, debts, payments, requests };

/** No JSON number may carry money or a version anywhere in a response (API contract rule A). */
export function assertNoMoneyNumbers(raw: string) {
  const bad = [...raw.matchAll(/"([a-z_]*(?:_agorot|version))":\s*(-?\d)/g)].map((m) => m[1]);
  if (bad.length) throw new Error(`money/version sent as a JSON number: ${bad.join(', ')}`);
}

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
export const daysAgo = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' })
  .format(new Date(Date.now() - n * 86_400_000));
