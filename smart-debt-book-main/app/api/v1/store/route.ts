/** S-03 Resolve my store · S-04 Create store · S-06 Rename store. */
import { route, parse } from '@/api/handler';
import { createStoreBody, renameStoreBody } from '@/api/schemas';
import { getMyStore, createStore, renameStore } from '@/ledger/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId }) => ({ status: 200, body: await getMyStore(userId) }));

export const POST = route({ write: true }, async ({ userId, body, key }) => {
  const input = parse(createStoreBody, body);
  const r = await createStore(userId, input.name, key!);
  return { status: r.created ? 201 : 200, body: { store: r.store } };
});

export const PATCH = route({ write: true }, async ({ userId, body, key }) => {
  const r = await renameStore(userId, parse(renameStoreBody, body).name, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
