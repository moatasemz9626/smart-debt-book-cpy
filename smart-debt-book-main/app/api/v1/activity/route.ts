/** R-05 Activity log. */
import { route, parse } from '@/api/handler';
import { activityQuery, queryOf } from '@/api/schemas';
import { activity } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId, url }) => {
  const q = parse(activityQuery, queryOf(url));
  return { status: 200, body: await activity(userId, q.from ?? null, q.to ?? null, q.cursor ?? null, q.customer_id ?? null) };
});
