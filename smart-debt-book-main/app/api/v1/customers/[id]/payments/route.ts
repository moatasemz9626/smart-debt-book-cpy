/** L-02 Record payment. */
import { route, parse } from '@/api/handler';
import { paymentBody, uuidParam } from '@/api/schemas';
import { recordPayment } from '@/ledger/operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const customerId = parse(uuidParam, params.id);
  const b = parse(paymentBody, body);
  const r = await recordPayment(userId, {
    customerId, expectedVersion: b.expected_version, amountAgorot: b.amount_agorot ?? null, full: b.full,
    description: b.description, effectiveDate: b.effective_date, effectiveTime: b.effective_time ?? null,
  }, key!);
  return { status: 201, body: r.body, replayed: r.replayed };
});
