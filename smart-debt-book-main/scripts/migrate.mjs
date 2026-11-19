/** Apply reviewed SQL migrations, tracking SHA256 checksums. Admin credentials only. */
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (await readdir(path.join(root, 'migrations')))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
const client = new pg.Client({ connectionString: migrationUrl });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS public.__sdb_migrations (
    filename text PRIMARY KEY,
    sha256 char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const filename of files) {
    const source = await readFile(path.join(root, 'migrations', filename), 'utf8');
    const sha256 = createHash('sha256').update(source).digest('hex');
    await client.query('BEGIN');
    try {
      const prior = await client.query(
        'SELECT sha256 FROM public.__sdb_migrations WHERE filename=$1 FOR UPDATE', [filename]);
      if (prior.rowCount) {
        if (prior.rows[0].sha256.trim() !== sha256)
          throw new Error(`Applied migration changed: ${filename}`);
        await client.query('COMMIT');
        console.log(`SKIP ${filename}`);
        continue;
      }
      await client.query(source);
      await client.query('INSERT INTO public.__sdb_migrations (filename,sha256) VALUES ($1,$2)',
        [filename,sha256]);
      await client.query('COMMIT');
      console.log(`APPLIED ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally { await client.end(); }
