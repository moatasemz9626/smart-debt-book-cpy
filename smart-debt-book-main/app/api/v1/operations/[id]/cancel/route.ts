/** K-02 Cancel saved operation. */
import { route, parse } from '@/api/handler';
import { cancelOperationBody, uuidParam } from '@/api/schemas';
import { cancelOperation } from '@/ledger/corrections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const b = parse(cancelOperationBody, body);
  const r = await cancelOperation(userId, parse(uuidParam, params.id), { expectedVersion: b.expected_version, reason: b.reason }, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
