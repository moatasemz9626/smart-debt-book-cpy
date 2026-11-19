/** C-04 Add alias. */
import { route, parse } from '@/api/handler';
import { aliasBody, uuidParam } from '@/api/schemas';
import { addAlias } from '@/ledger/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const r = await addAlias(userId, parse(uuidParam, params.id), parse(aliasBody, body).alias, key!);
  return { status: 201, body: r.body, replayed: r.replayed };
});
