/** R-01 Dashboard. */
import { route } from '@/api/handler';
import { dashboard } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId }) => ({ status: 200, body: await dashboard(userId) }));
