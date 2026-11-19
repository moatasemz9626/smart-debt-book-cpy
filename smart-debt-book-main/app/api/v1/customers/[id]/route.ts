/** R-03 Customer page · C-02 Edit phone & notes. */
import { route, parse } from '@/api/handler';
import { updateCustomerBody, uuidParam } from '@/api/schemas';
import { updateCustomer } from '@/ledger/customers';
import { customerPage } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId, params, url }) => {
  const id = parse(uuidParam, params.id);
  return { status: 200, body: await customerPage(userId, id, url.searchParams.get('cursor')) };
});

export const PATCH = route({ write: true }, async ({ userId, params, body, key }) => {
  const b = parse(updateCustomerBody, body);
  const r = await updateCustomer(userId, parse(uuidParam, params.id), { phone: b.phone ?? null, notes: b.notes }, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
