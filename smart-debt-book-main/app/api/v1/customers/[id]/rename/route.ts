/** C-03 Rename customer. */
import { route, parse } from '@/api/handler';
import { renameCustomerBody, uuidParam } from '@/api/schemas';
import { renameCustomer } from '@/ledger/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const b = parse(renameCustomerBody, body);
  const r = await renameCustomer(userId, parse(uuidParam, params.id), { newName: b.new_name, keepOldAsAlias: b.keep_old_as_alias }, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
