/** C-05 Delete alias (the only real DELETE). */
import { route, parse } from '@/api/handler';
import { uuidParam } from '@/api/schemas';
import { deleteAlias } from '@/ledger/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = route({ write: true }, async ({ userId, params, key }) => {
  const r = await deleteAlias(userId, parse(uuidParam, params.id), parse(uuidParam, params.nameId), key!);
  return { status: 204, body: null, replayed: r.replayed };
});
