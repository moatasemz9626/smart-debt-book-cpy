/** LOCAL ONLY. Give sdb_app a random password and write the local runtime/Auth settings to .env.
 * Refuses to run unless DATABASE_MIGRATION_URL points at localhost.
 * Run after `npx supabase start` and `npm run db:migrate`.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required');
const url = new URL(migrationUrl);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error(`Refusing: ${url.hostname} is not local. This script is for local Supabase only.`);

const status = JSON.parse(execFileSync('npx', ['-y', 'supabase@3.0.0', 'status', '-o', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

const password = randomBytes(24).toString('hex');
const db = new pg.Client({ connectionString: migrationUrl });
await db.connect();
try {
  const { rows } = await db.query(`SELECT format('ALTER ROLE sdb_app PASSWORD %L', $1::text) AS q`, [password]);
  await db.query(rows[0].q);
} finally { await db.end(); }

const runtime = new URL(migrationUrl);
runtime.username = 'sdb_app';
runtime.password = password;

const settings = {
  DATABASE_RUNTIME_URL: runtime.toString(),
  SUPABASE_URL: status.API_URL,
  // Public by design (same key a browser gets). Local default, not a secret.
  SUPABASE_ANON_KEY: status.ANON_KEY,
};
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
let env = await readFile(envPath, 'utf8');
for (const [key, value] of Object.entries(settings)) {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${env.replace(/\n?$/, '\n')}${line}\n`;
}
await writeFile(envPath, env, { mode: 0o600 });
console.log('Local setup done: sdb_app password set, .env updated (DATABASE_RUNTIME_URL, SUPABASE_URL, SUPABASE_ANON_KEY).');
