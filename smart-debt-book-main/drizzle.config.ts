// Schema is Drizzle-typed; migrations are intentionally hand-written SQL because
// PostgreSQL RLS, triggers, and deferred constraints require explicit review.
// Use `npm run db:migrate` to apply the tracked SQL migrations; do not use db:push.
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle-generated',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL || '' },
});
