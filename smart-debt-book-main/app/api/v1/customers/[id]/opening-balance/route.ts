/** L-03 Add opening balance (separate operation type; no time). */
import { route, parse } from '@/api/handler';
import { openingBalanceBody, uuidParam } from '@/api/schemas';
import { addOpeningBalance } from '@/ledger/operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route({ write: true }, async ({ userId, params, body, key }) => {
  const customerId = parse(uuidParam, params.id);
  const b = parse(openingBalanceBody, body);
  const r = await addOpeningBalance(userId, {
    customerId, expectedVersion: b.expected_version, amountAgorot: b.amount_agorot,
    description: b.description, effectiveDate: b.effective_date, effectiveTime: null,
  }, key!);
  return { status: 201, body: r.body, replayed: r.replayed };
});
