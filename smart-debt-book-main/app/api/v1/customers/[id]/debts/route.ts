/** L-01 Add debt. */
import { route, parse } from '@/api/handler';
import { debtBody, uuidParam } from '@/api/schemas';
import { addDebt } from '@/ledger/operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const customerId = parse(uuidParam, params.id);
  const b = parse(debtBody, body);
  const r = await addDebt(userId, {
    customerId, expectedVersion: b.expected_version, amountAgorot: b.amount_agorot,
    description: b.description, effectiveDate: b.effective_date, effectiveTime: b.effective_time ?? null,
  }, key!);
  return { status: 201, body: r.body, replayed: r.replayed };
});
