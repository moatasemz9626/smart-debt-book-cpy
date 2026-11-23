# Smart Debt Book (دفتر الديون الذكي)

Mobile-first web app that replaces the paper credit ledger in small Arabic-speaking shops in Israel.
The owner records debts and payments by voice, text or manual entry, sees balances, history and
statements. The MVP user is the shop owner only. Currency: ILS only.

## Where things are

All paths are relative to the project root (the folder that holds `migrations/` and `docs/`).

| Path | What it is |
|---|---|
| `docs/Smart_Debt_Book_PRD_v1.1.pdf` | Approved product requirements (v1.1) |
| `docs/Smart_Debt_Book–PRDv1.2changelog.pdf` | PRD v1.2 change log. Overrides v1.1 where they differ |
| `docs/Smart-Debt Book – Tables, operations & queries.pdf` | Every operation with params and full SQL. The contract for the backend |
| `migrations/001–005_*.sql` | Applied schema. Never edit |
| `migrations/006_soft_delete.sql` | Soft delete + ة → ه. Provided ready-made; review, don't re-type it from the PDF |
| `DB_SPEC_v1.0.md` | Database design rationale |
| `docs/API_CONTRACT.md` | Step 4: every operation ID → endpoint, input, output, error codes, money/runtime rules |
| `docs/FRONTEND_GUIDE.md` | Handoff for the mobile screens (people and AI): run, login, API calls, screens → endpoints, rules |
| `src/db/schema.ts` | Drizzle schema (types only; migrations are SQL) |
| `src/db/pool.ts`, `src/db/tenant.ts` | `sdb_app` pool (BigInt parsers); `withUserTransaction`, `withStoreTransaction` |
| `src/money.ts` | `parseShekelsToAgorot`, `parseAgorot`, `formatAgorot`: string maths, no floats |
| `src/ledger/` | LedgerService: one function per operation ID, SQL from the operations doc |
| `src/api/`, `app/api/v1/` | Route wrapper (auth, Idempotency-Key, error mapping), zod schemas, Next.js routes |
| `scripts/migrate.mjs`, `scripts/verify.mjs` | Apply migrations in filename order with checksums; structural check |
| `scripts/local-setup.mjs` | Local only: sets an `sdb_app` password and fills `.env` |
| `supabase/config.toml` | Local Supabase (Docker): phone login with test OTP numbers |
| `tests/TEST_CASES.md` | 40 DB integration cases (26–30 are merge: V2) |
| `tests/db/` | Automated DB tests (vitest). `helpers.ts` holds the operations-doc SQL as fixtures |
| `tests/api/` | API tests: real route handlers, real Supabase sessions, `sdb_app` |

Below, **the PRD**, **the changelog** and **the operations doc** mean these three PDFs.
The file names contain spaces and en dashes (–), so quote them in shell commands.

Source of truth when documents disagree: the changelog > the operations doc > the PRD > `DB_SPEC_v1.0.md`.

**SQL from the operations doc:** PDF text extraction can break lines, drop indentation or swap
quotes. Extract with `pdftotext -layout "<file>.pdf" -`, then check every statement before using it:
balanced parentheses, straight `'` quotes, `$$` pairs intact. When in doubt, ask for the doc
exported as Markdown.

## Stack

Next.js (full-stack) on Vercel · Supabase Postgres + Supabase Auth (SMS OTP) · Drizzle ORM ·
hand-written SQL migrations run by `scripts/migrate.mjs`.

## Local development

```bash
npx supabase start            # Docker; Studio at http://127.0.0.1:54323
npm run db:migrate            # our migrate.mjs, never `supabase db push`
npm run db:verify
npm run db:local-setup        # once per fresh local DB: sdb_app password + .env
npm test                      # unit + DB + API tests (refuse non-local hosts)
npm run lint                  # includes the no-float money rule
npm run typecheck
npm run dev                   # Next.js on :3000, API under /api/v1
```

- Test phone numbers: `+972500000001` / `123456` and `+972500000002` / `654321`. Nothing is sent.
- Tests sign up their own Auth users through the public API (email + password). No service key.
- `.env` is local only. For hosted staging, run tests with `SDB_TEST_TARGET=staging`.

## Rules that must never be broken

1. **Money is integer agorot** (`bigint`). ₪150.50 = `15050`. No floats anywhere in money code.
2. **`ledger_entries`, `operation_revisions`, `audit_events` are append-only.** A correction is a
   REVERSAL entry plus a CORRECTION entry. A saved operation is never deleted; it is cancelled.
3. **Every financial write** locks the customer account `FOR UPDATE` and compares
   `ledger_version` with the version the owner saw on the review card. Mismatch = stale draft:
   reject, never save.
4. **Every write is idempotent** by `request_id`: advisory lock, then look up `audit_events`.
   Same hash returns the saved `response_data`; different hash returns 409.
5. **Tenant context** (`app.user_id`, `app.store_id`) is set with `set_config(..., true)` inside the
   transaction, from the verified Supabase session only. Never from the request body.
6. **Runtime uses the restricted role `sdb_app`** (no BYPASSRLS). Never use `service_role` or the
   migration user at runtime. `DATABASE_RUNTIME_URL` never reaches the browser.
7. **Delete is logical only.** `deleted_at` on `stores` and `customers`; rows are never removed.
   The only real `DELETE` is removing a customer alias.
8. **No success shown before COMMIT.** After a lost response, the client asks for the same
   `request_id` (R-06) before allowing a retry.

## Decisions already made (do not reopen without asking)

1. Merge customers (FR-08) is **out of the MVP**. Merge columns and enum values stay in the schema, unused.
2. Logical delete: stores and customers via `deleted_at`, kept forever, no purge job.
3. A customer can be deleted only at balance 0, and can be restored. Its names stay reserved, so
   creating the same name offers "restore".
4. A store can be deleted even if money is owed, after showing the total owed, a fresh SMS code
   and the store name typed again. It can be restored unless a new store exists.
5. Name normalization treats ة and ه as the same letter (in addition to hamza/alef/ya forms).
6. New-owner flows (S-03, S-04, S-09) use a second wrapper `withUserTransaction` that sets only
   `app.user_id`.
7. Sessions: only "log out other devices" in the MVP. No device list.
8. Export and store delete carry the fresh OTP code in the same request; the server verifies it and
   does the work in that request. No stored "verified" state.
9. Timezone: `Asia/Jerusalem` only.
10. API: money is a JSON string of integer agorot (`"15050"`), `bigint` in code; Node.js runtime,
    never Edge. Another store's id returns 404, not 403. Explicitly supplied amounts are capped
    at ₪1,000,000; L-02 `full: true` omits the amount and pays the whole locked balance even
    above this cap. Limits and the full list: `docs/API_CONTRACT.md`.
11. Statement PDF is rendered in the browser from R-04 JSON.

Open risk: no path for a formal data-erasure request. Needs legal advice before public launch.

## Known gotchas

- `src/db/tenant.ts` requires a store, so it fails for a new user. Add `withUserTransaction`.
- S-08 Delete store: write the audit row **before** setting `deleted_at`, or RLS blocks it.
- Migration 006 replaces `stores_one_per_owner` with a partial unique index, so S-04 uses
  `ON CONFLICT (owner_user_id) WHERE deleted_at IS NULL`.
- The ة → ه change recomputes `normalized_name` for existing rows; on real data it can raise a
  duplicate-name violation. Staging starts empty, so it is safe there.
- R-04 Statement: `sum(...) OVER (...)` over bigint returns `numeric`, which `pg` gives back as a
  string. Cast the running total `::bigint` (the operations doc doesn't).
- Several deferred guards can reject the same broken write; which message fires first depends on
  trigger order. Tests for "rejected" match the guard family, not one exact message.
- Imports inside `src/` have no `.js` extension: Turbopack does not map `./x.js` to `x.ts`.
- R-03 paging: the operations doc's cursor leaves out `effective_time` while ORDER BY uses it. LedgerService
  sorts and pages on `(effective_date, coalesce(effective_time, '24:00'), created_at, id)`.
- `audit_events.response_data` holds the exact API body (money as strings), not the doc's
  `jsonb_build_object` numbers, so a replay returns byte-for-byte what the first call returned.
- The historical-balance guard replays a customer's whole history at COMMIT. Measure it with
  thousands of operations before production.

## Plan (do in order)

Status (2026-11-05): steps 0–3 done on **local** Supabase (53 tests pass). Step 2 and 3 still need
one run on a hosted Supabase staging project. Step 4 draft done (`docs/API_CONTRACT.md`, two items
open: export columns, fresh-OTP check). Step 5 done except S-08 Delete store and FR-18 Export, which wait for the
fresh-OTP decision: every other operation ID runs through `/api/v1` (148 tests pass). Screens (step 6) are
built by a colleague from `docs/FRONTEND_GUIDE.md`. Next: decide the
OTP check, then S-08 + export, then step 6 (UI).

0. **Git** — ✅ `git init`, then commit everything except `.env` (already in `.gitignore`).
1. **Migration 006** — ✅ `migrations/006_soft_delete.sql` is provided. Review it against the
   "Migration 006" section of the operations doc, then add `deletedAt` and `data` to
   `stores` and `customers` in `src/db/schema.ts`. Never edit 001–005.
2. **Staging database** — ✅ local. Run `npm run db:migrate` and `npm run db:verify` against a Supabase
   staging project. Fix what breaks with new migration files, not by editing applied ones.
3. **DB integration tests** — ✅ local. The 40 cases in `TEST_CASES.md` (merge 26–30 skipped as
   V2; 36 benchmark and 37 LedgerService rule still to do) plus AT-51…AT-60 from the changelog,
   with real Supabase Auth users and the `sdb_app` role. When LedgerService exists, point the
   tests at it instead of the SQL fixtures in `tests/db/helpers.ts`.
4. **API contract** — ✅ draft. Map each operation ID (S-, C-, L-, K-, R-) to an endpoint: input, output,
   error codes (stale draft, 409, overpayment, deleted customer).
5. **LedgerService** — 🟡 all but S-08 and export. One server function per operation, taken from the SQL in
   the operations doc, each with tests. First vertical slice:
   login → create store → create customer → add debt → record payment → customer page.
6. **UI** — mobile screens (home, voice, review card, customer page) on top of the working API.
   Voice and AI come after manual entry works end to end.

## Working rules for Claude

- Never run `drizzle-kit push`; it can drop RLS and triggers that only exist in SQL.
- Never commit secrets or real connection strings. `.env` stays out of Git.
- Never touch a production database. Staging only, and ask before anything destructive.
- After every feature, run `npm test`, `npm run lint` and `npm run typecheck`.
- Commit messages: one short line. No `Co-Authored-By` or other Claude attribution, in commits or PRs.
- Repo: https://github.com/ahmadabahiga-invTr/smart-debt-book (private). Never force-push without asking.
- When a requirement is unclear, check the docs above in source-of-truth order, then ask.
