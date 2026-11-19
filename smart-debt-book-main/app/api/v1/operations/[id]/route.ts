/** K-01 Edit saved operation. */
import { route, parse } from '@/api/handler';
import { editOperationBody, uuidParam } from '@/api/schemas';
import { editOperation } from '@/ledger/corrections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route({ write: true }, async ({ userId, params, body, key }) => {
  const b = parse(editOperationBody, body);
  const r = await editOperation(userId, parse(uuidParam, params.id), {
    expectedVersion: b.expected_version, amountAgorot: b.amount_agorot, effectiveDate: b.effective_date,
    description: b.description, reason: b.reason,
  }, key!);
  return { status: 200, body: r.body, replayed: r.replayed };
});
