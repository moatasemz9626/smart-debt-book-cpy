# Smart Debt Book (دفتر الديون الذكي)

A mobile web app for small shops. It replaces the paper notebook where the shop owner writes
what customers owe. The owner adds debts and payments, sees each customer's balance and history,
and can share a statement.

- Users: the shop owner only (MVP).
- Language: Arabic, right to left.
- Money: Israeli shekels (₪) only.
- Time zone: Asia/Jerusalem.

## Status

| Part | Status |
|---|---|
| Database (Supabase Postgres) | Done. Migrations 001–006. |
| Backend API (`/api/v1`) | Done, except store delete and data export. |
| Tests | 148 tests pass on local Supabase. |
| Mobile screens | Not started. See `docs/FRONTEND_GUIDE.md`. |
| Voice and AI | Later, after manual entry works. |

Not built yet:
- **Store delete** and **data export.** Both need a fresh SMS code, and we have not decided how
  the server checks it.
- A test run on a **hosted** Supabase staging project. So far we only test on local Supabase.

## Tech stack

- Next.js 16 (app and API in one project), TypeScript, Node.js runtime
- Supabase: Postgres database and Auth (login with an SMS code)
- `pg` for database access, Drizzle for table types
- Plain SQL migrations, run by our own script
- Vitest for tests, ESLint, zod for input checks

## Run it on your computer

You need **Docker** and **Node.js 22 or newer**.

```bash
npm install
npx supabase start          # starts local Supabase in Docker
npm run db:migrate          # creates the tables
npm run db:verify           # quick check of the database
npm run db:local-setup      # creates .env for local use
npm run dev                 # app at http://localhost:3000, API at /api/v1
```

Local Supabase has two test phone numbers. No real SMS is sent.

| Phone | Code |
|---|---|
| `+972500000001` | `123456` |
| `+972500000002` | `654321` |

Supabase Studio (a database browser) is at http://127.0.0.1:54323.
Stop Supabase with `npx supabase stop`. Your data stays.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app in development mode |
| `npm test` | Run all tests (unit, database, API) |
| `npm run lint` | Check the code, including the "no floats for money" rule |
| `npm run typecheck` | Check TypeScript types |
| `npm run build` | Build for production |
| `npm run db:migrate` | Apply new migrations |
| `npm run db:verify` | Check that tables, security rules and key functions exist |
| `npm run db:local-setup` | Local only: set a password for the app's database user and fill `.env` |

Run `npm test`, `npm run lint` and `npm run typecheck` before every push.

## Project layout

| Path | What is there |
|---|---|
| `app/api/v1/` | API endpoints (one folder per endpoint) |
| `src/ledger/` | Business logic: one function per operation |
| `src/api/` | Shared code for endpoints: login check, input rules, error codes |
| `src/db/` | Database connection and transaction helpers |
| `src/auth/` | Checks the Supabase login token |
| `src/money.ts` | Convert between ₪ text and agorot. Used by server and browser |
| `migrations/` | SQL migrations. Never edit a migration that already ran |
| `supabase/config.toml` | Local Supabase settings |
| `scripts/` | Migration, check and local setup scripts |
| `tests/` | Unit, database and API tests |
| `docs/` | Product documents, API contract, frontend guide |

## Documents

| File | Read it when |
|---|---|
| `docs/FRONTEND_GUIDE.md` | You build the screens. Written for people and for AI assistants |
| `docs/API_CONTRACT.md` | You need the exact input, output or error of an endpoint |
| `docs/Smart_Debt_Book_PRD_v1.1.pdf` | You need to know what a screen must do |
| `docs/Smart_Debt_Book–PRDv1.2changelog.pdf` | Changes to the PRD. It wins when they disagree |
| `docs/Smart-Debt Book – Tables, operations & queries.pdf` | You need the SQL behind an operation |
| `DB_SPEC_v1.0.md` | You want the reasons behind the database design (Arabic) |
| `tests/TEST_CASES.md` | The database test cases |
| `CLAUDE.md` | Project rules, decisions and plan (also read by Claude Code) |

## Important rules

1. **Money is whole agorot.** ₪150.50 is stored as `15050`. In JSON it is a string (`"15050"`),
   in code a `BigInt`. Never use floating-point numbers for money.
2. **Money history is never changed or deleted.** A correction adds new rows. A cancelled
   operation stays in the history, marked as cancelled.
3. **Every money change checks the version** the owner saw on the screen. If the customer changed
   in the meantime (for example on another phone), the save is refused and the owner confirms again.
4. **Every save can be safely retried.** The app sends an `Idempotency-Key`. Sending the same
   request again does not save it twice.
5. **Each shop sees only its own data.** The database enforces this with row-level security.
   The app connects as a limited user (`sdb_app`), never as an admin.
6. **Nothing is really deleted.** Shops and customers get a `deleted_at` date and can be restored.
   The only real delete is removing a customer's extra name (alias).

## Why plain SQL migrations?

Drizzle describes the tables for TypeScript, but our security rules, triggers and money checks
only exist in SQL. Tools that generate the schema could remove them. So:

- Migrations are hand-written SQL files in `migrations/`, applied in order by `scripts/migrate.mjs`.
- The script saves a checksum of each file. It refuses to run if an applied file was changed.
  To change the database, add a new migration file.
- **Never run `drizzle-kit push`.**

## Running on a hosted Supabase project (staging)

1. Create a Supabase project for testing. Never use production for this.
2. Set `DATABASE_MIGRATION_URL` to the admin connection, then run `npm run db:migrate` and
   `npm run db:verify`.
3. In the Supabase dashboard, set a strong password for the `sdb_app` user. Keep it out of Git.
4. Set `DATABASE_RUNTIME_URL` (as `sdb_app`, through the pooler on port 6543), `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` as **server** settings in Vercel.
5. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the browser.
6. Set up a real SMS provider in Supabase Auth for login.
7. Run the tests against it with `SDB_TEST_TARGET=staging npm test`. Without that setting the
   tests refuse to run against anything but local Supabase.

## Security notes

- Never use the Supabase `service_role` key or the `postgres` user in the running app.
- Never commit passwords or real connection strings. `.env` is in `.gitignore`.
- `DATABASE_RUNTIME_URL` must never reach the browser. Only `NEXT_PUBLIC_*` settings do.
- The `__sdb_migrations` table belongs to the migration script. It is not an app table.
- Turn on backups and point-in-time restore for production in Supabase, and test a restore.
- Open question: there is no way yet to fully erase a person's data on legal request.
  This needs legal advice before the public launch.
