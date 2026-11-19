/** S-09 Restore store. */
import { route, parse } from '@/api/handler';
import { restoreStoreBody } from '@/api/schemas';
import { restoreStore } from '@/ledger/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, body, key }) => {
  const r = await restoreStore(userId, parse(restoreStoreBody, body).store_id, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
