/** Loaded before every DB test file (vitest setupFiles). */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

for (const key of ['DATABASE_RUNTIME_URL', 'DATABASE_MIGRATION_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
  if (!process.env[key]) throw new Error(`${key} is missing. Local: run npm run db:local-setup`);
}

// Tests create users and data. Never point them at anything but local Supabase or a
// hosted STAGING project, and the hosted one only on purpose.
const hosts = ['DATABASE_RUNTIME_URL', 'DATABASE_MIGRATION_URL', 'SUPABASE_URL']
  .map((key) => new URL(process.env[key]!).hostname);
const local = hosts.every((h) => h === '127.0.0.1' || h === 'localhost');
if (!local && process.env.SDB_TEST_TARGET !== 'staging')
  throw new Error(`DB tests refuse non-local hosts (${hosts.join(', ')}). Set SDB_TEST_TARGET=staging for hosted staging.`);
