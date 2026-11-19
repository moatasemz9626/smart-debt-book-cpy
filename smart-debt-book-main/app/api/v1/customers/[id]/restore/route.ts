/** C-08 Restore customer. */
import { route, parse } from '@/api/handler';
import { emptyBody, uuidParam } from '@/api/schemas';
import { restoreCustomer } from '@/ledger/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  parse(emptyBody, body);
  const r = await restoreCustomer(userId, parse(uuidParam, params.id), key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
