/** R-02 Customer list · C-01 Create customer. */
import { route, parse } from '@/api/handler';
import { createCustomerBody, listQuery, queryOf, todayJerusalem } from '@/api/schemas';
import { createCustomer } from '@/ledger/customers';
import { customerList } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId, url }) => {
  const q = parse(listQuery, queryOf(url));
  return { status: 200, body: await customerList(userId, q.filter, q.sort) };
});

export const POST = route({ write: true }, async ({ userId, body, key }) => {
  const b = parse(createCustomerBody, body);
  const r = await createCustomer(userId, {
    name: b.name, phone: b.phone ?? null, notes: b.notes, force: b.force,
    openingBalanceAgorot: b.opening_balance_agorot ?? null, openingDate: b.opening_date ?? todayJerusalem(),
  }, key!);
  return { status: 201, body: r.body, replayed: r.replayed };
});
