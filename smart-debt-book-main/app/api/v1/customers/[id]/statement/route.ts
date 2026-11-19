/** R-04 Statement (the browser renders the PDF, decision D3). */
import { route, parse } from '@/api/handler';
import { uuidParam } from '@/api/schemas';
import { statement } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId, params }) => ({
  status: 200, body: await statement(userId, parse(uuidParam, params.id)),
}));
