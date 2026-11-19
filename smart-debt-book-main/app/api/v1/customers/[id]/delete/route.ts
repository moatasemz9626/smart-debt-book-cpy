/** C-07 Delete customer (logical; only at balance 0). POST, not HTTP DELETE: it has a body and removes nothing. */
import { route, parse } from '@/api/handler';
import { uuidParam, versionBody } from '@/api/schemas';
import { deleteCustomer } from '@/ledger/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const r = await deleteCustomer(userId, parse(uuidParam, params.id), parse(versionBody, body).expected_version, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
