/** Server-only: verify the Supabase session on every request. user_id comes from here and nowhere else. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../ledger/errors';

let client: SupabaseClient | undefined;

function supabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY missing');
    client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

/** Asks Supabase Auth about the token (not just its signature), so a session ended by
 * "log out other devices" stops working here too. */
export async function verifiedUserId(request: Request): Promise<string> {
  const header = request.headers.get('authorization') ?? '';
  const token = /^Bearer (.+)$/.exec(header)?.[1];
  if (!token) throw new AppError('UNAUTHENTICATED');
  const { data, error } = await supabase().auth.getUser(token);
  if (error || !data.user) throw new AppError('UNAUTHENTICATED');
  return data.user.id;
}
