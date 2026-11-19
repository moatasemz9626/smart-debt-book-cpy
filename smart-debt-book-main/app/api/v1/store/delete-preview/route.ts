/** S-08 step 0: total owed, shown before a store delete. */
import { route } from '@/api/handler';
import { deletePreview } from '@/ledger/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId }) => ({ status: 200, body: await deletePreview(userId) }));
