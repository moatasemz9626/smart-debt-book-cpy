/** R-06 Look up a request (after a lost response, before any retry). */
import { route, parse } from '@/api/handler';
import { uuidParam } from '@/api/schemas';
import { lookupRequest } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId, params }) => ({
  status: 200, body: await lookupRequest(userId, parse(uuidParam, params.id).toLowerCase()),
}));
