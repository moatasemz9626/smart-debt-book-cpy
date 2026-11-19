/** C-06 Search. */
import { route, parse } from '@/api/handler';
import { queryOf, searchQuery } from '@/api/schemas';
import { searchCustomers } from '@/ledger/reads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ write: false }, async ({ userId, url }) => ({
  status: 200, body: await searchCustomers(userId, parse(searchQuery, queryOf(url)).q),
}));
