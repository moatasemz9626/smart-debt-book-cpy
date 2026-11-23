# Smart Debt Book — API contract v0.1 (plan step 4)

Maps every operation ID in the operations doc (S-, C-, L-, K-, R-) to one HTTP endpoint: input,
output and error codes. LedgerService (step 5) implements one server function per row; the SQL
for each is in the operations doc and already runs in `tests/db/helpers.ts`.

Source of truth stays: changelog > operations doc > PRD > this file. Section 5 lists the decisions
taken on 2026-11-05 and the items still **OPEN**.

---

## 1. Three rules for the TypeScript backend

### Rule A — Money is a string of integer agorot in JSON, `bigint` in code

JavaScript `number` is a float. It must never hold money.

| Where | Type | Example ₪150.50 |
|---|---|---|
| JSON (request and response) | string, `^(0\|[1-9][0-9]*)$` | `"15050"` |
| TypeScript | `bigint` | `15050n` |
| Postgres | `bigint` | `15050` |

- Every money field name ends in `_agorot`. No decimals, no sign, no `₪`, no spaces. The client
  converts ₪ input to agorot before sending (`"150.50"` → `"15050"`) with string maths, not floats.
- The server parses with `BigInt(s)` after the regex check, and serializes with `.toString()`.
  A number, a decimal, an empty string or a negative value is `400 VALIDATION_FAILED`.
- `ledger_version` is a `bigint` column too, so it travels as a string: `"expected_version": "7"`.
- `pg` returns `bigint` as a string by default and `numeric` (any `sum()`) as a string. LedgerService
  sets the `bigint` parser to `BigInt` and casts every money `sum()` to `::bigint` in SQL.
- Lint (step 5): forbid `Number(`, `parseFloat(`, `parseInt(`, `+x` and `Math.*` in files under
  `src/ledger/` and in any expression whose name ends in `Agorot`.

### Rule B — Node.js runtime, pooled and small

- Every route handler: `export const runtime = 'nodejs'`. Never Edge (`pg` needs TCP).
- `DATABASE_RUNTIME_URL` is the Supabase **transaction pooler** (port 6543) as `sdb_app`.
  Transaction mode fits: all tenant state is `set_config(..., true)` inside the transaction.
  Use unnamed queries only (no named prepared statements); `pg` does this by default.
- One `pg.Pool` per function instance, `max: 3`, `idleTimeoutMillis: 10_000`.
- Every transaction starts with `SET LOCAL lock_timeout = '3s'` and `SET LOCAL statement_timeout = '8s'`.
  A timeout is `503 BUSY_RETRY`; the client retries with the **same** `Idempotency-Key`.

### Rule C — Every request finishes inside the function time limit

- Targets from the PRD (NFR-01): save a debt/payment < 2 s, open a customer < 1 s, search < 0.5 s.
- Writes are short transactions; no network calls inside a transaction **except** the OTP check,
  which runs **before** `BEGIN` (S-08, export).
- Export (FR-18) runs in the same request (decision 8) and streams the ZIP. If a store's export
  ever gets near the limit, move it to a background job with a one-time download link — that is a
  contract change, not a silent one.
- Voice and AI are not in this contract. They will call the same endpoints after the review card.

---

## 2. Common conventions

| Item | Rule |
|---|---|
| Base path | `/api/v1` |
| Auth | `Authorization: Bearer <Supabase access token>` (or the Supabase SSR cookie). The server verifies it with Supabase Auth and takes `user_id` from the verified session only. |
| Tenant | The server resolves the store from the user (S-03). **No endpoint takes a store id**, except S-09 restore, where the SQL also checks `owner_user_id`. |
| Write idempotency | Every write sends `Idempotency-Key: <uuid v4>` = `request_id`. The server computes `request_hash = sha256(method + " " + path + "\n" + canonical JSON body)`. Same key + same hash → the saved response, with header `Idempotent-Replayed: true`. Same key + other hash → `409 IDEMPOTENCY_CONFLICT`. |
| Lost response | Before retrying, the client calls R-06 with the same key (rule 8 in CLAUDE.md). |
| Versions | Every write that touches a customer's money or status sends `expected_version` (the `ledger_version` shown on the review card). |
| Dates | `effective_date`: `YYYY-MM-DD` in `Asia/Jerusalem`. `effective_time`: `HH:MM`, optional, never invented. Timestamps: ISO 8601 UTC. |
| IDs | UUID strings. |
| Language | Error `code` is stable English; `message_ar` is for display. |
| Limits | Explicitly supplied `amount_agorot`: 1 … `100000000` (₪1,000,000.00) per operation. **Exception:** L-02 `full: true` omits `amount_agorot`; the backend uses the customer's entire locked outstanding balance, even when it exceeds ₪1,000,000. `description` ≤ 500 chars, `notes` ≤ 1000, `reason` ≤ 500. Customer name / alias 1–180, store name 1–120 (DB checks). `phone`: Israeli number, stored as E.164 (`+9725XXXXXXXX`), optional. An explicitly supplied amount over the limit → `400 VALIDATION_FAILED`. |

### Shared objects

```ts
type Agorot = string;            // ^(0|[1-9][0-9]*)$  — integer agorot, never a JSON number
type Version = string;           // ledger_version as a string

type Store    = { id: string; name: string; timezone: 'Asia/Jerusalem'; deleted_at: string | null };
type Account  = { balance_agorot: Agorot; ledger_version: Version };
type Customer = { id: string; primary_name: string; aliases: { id: string; name: string }[];
                  phone: string | null; notes: string | null; deleted_at: string | null } & Account;
type Operation = { id: string; type: 'DEBT' | 'PAYMENT' | 'OPENING_BALANCE';
                   status: 'ACTIVE' | 'CANCELLED'; amount_agorot: Agorot; description: string | null;
                   effective_date: string; effective_time: string | null; revision_no: number; created_at: string };
type LedgerResult = { operation_id: string } & Account;      // every L- and K- response
```

### Error body

```json
{ "error": { "code": "STALE_DRAFT", "message_ar": "…", "details": { "ledger_version": "8", "balance_agorot": "4200" } } }
```

---

## 3. Error codes

| HTTP | `code` | When | `details` |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad JSON, bad money string, bad date, missing field | `{ field, rule }` |
| 401 | `UNAUTHENTICATED` | No session, or it failed verification | — |
| 401 | `OTP_INVALID` | Fresh SMS code wrong or expired (S-08, export) | — |
| 404 | `NO_STORE` | User has no active store (new user, or store deleted: offer S-04 / S-09) | `{ deleted_store }` |
| 404 | `NOT_FOUND` | Id not visible in this store: wrong id **or another store's id** (decision D1) | — |
| 404 | `REQUEST_NOT_FOUND` | R-06: nothing saved for this key; safe to retry with it | — |
| 409 | `STALE_DRAFT` | `expected_version` ≠ current `ledger_version`. Refresh and re-confirm | current `Account` |
| 409 | `IDEMPOTENCY_CONFLICT` | Key reused with a different body | — |
| 409 | `CUSTOMER_DELETED` | Write to a deleted customer (LOCK-ACCOUNT found none, the customer exists with `deleted_at`) | `{ customer_id }` → offer C-08 |
| 409 | `SIMILAR_NAMES` | C-01 found close names and `force` is false | `{ matches: [{ customer_id, name, deleted, score }] }` |
| 409 | `NAME_EXISTS` | Normalized name already in the store (DB `23505`), deleted customers included | `{ customer_id, deleted }` → if deleted, offer C-08 |
| 409 | `ACTIVE_STORE_EXISTS` | S-09 while a newer active store exists | — |
| 422 | `OVERPAYMENT` | Payment > balance (no credit balances in the MVP) | `{ balance_agorot }` |
| 422 | `NOTHING_TO_PAY` | Payment when balance is 0 | — |
| 422 | `BALANCE_NOT_ZERO` | C-07 with money still owed | `{ balance_agorot }` |
| 422 | `HISTORY_NEGATIVE` | Backdate / edit / cancel would make an earlier day negative (DB `23514`, historical guard) | — |
| 422 | `OPERATION_NOT_ACTIVE` | K-01/K-02 on a cancelled operation | — |
| 422 | `PRIMARY_NAME` | C-05 on the primary name (rename it with C-03) | — |
| 422 | `CONFIRM_NAME_MISMATCH` | S-08 typed name ≠ store name | — |
| 429 | `TOO_MANY_ATTEMPTS` | OTP attempts limit (Supabase Auth) | `{ retry_after_s }` |
| 503 | `BUSY_RETRY` | `lock_timeout`, `statement_timeout`, deadlock (`40P01`), serialization (`40001`), pool exhausted | — retry with the same key |
| 500 | `INTERNAL` | Anything else, including any other DB guard firing. Logged with `request_id`; nothing saved | — |

**DB error mapping** (LedgerService, by SQLSTATE and constraint, never by English message alone):
`23505` on `customer_names_unique_within_store` → `NAME_EXISTS`; on `stores_one_active_per_owner` → `ACTIVE_STORE_EXISTS`.
`23514` from `sdb_verify_historical_balance` → `HISTORY_NEGATIVE`; from `sdb_customer_delete_guard` → `BALANCE_NOT_ZERO`;
from `sdb_no_money_on_deleted` → `CUSTOMER_DELETED`; `customer_accounts_positive_balance` → `OVERPAYMENT`.
Any other guard (reconciliation, revisions, reversal, append-only) means a LedgerService bug → `500 INTERNAL`.

---

## 4. Endpoints

`W` = write: needs `Idempotency-Key`, writes an `audit_events` row, response replayable via R-06.

### Owner & store

| Op | Method & path | W | Input | Output | Errors |
|---|---|---|---|---|---|
| — | Login, OTP, sessions | | Supabase Auth from the client (`signInWithOtp`, `verifyOtp`) | session | Supabase |
| FR-01 | Log out other devices | | Supabase Auth `signOut({ scope: 'others' })` from the client | — | Supabase |
| S-03 | `GET /store` | | — | `{ store: Store \| null, deleted_store: Store \| null }` | 401 |
| S-04 | `POST /store` | W | `{ name }` (1–120) | `201 { store }`; if an active store exists: `200 { store }` | 400 |
| S-06 | `PATCH /store` | W | `{ name }` | `{ store }` | 400, 404 `NO_STORE` |
| S-08a | `GET /store/delete-preview` | | — | `{ customers_owing: number, total_owed_agorot }` | 404 `NO_STORE` |
| S-08 | `POST /store/delete` (**not built yet**: open item 2) | W | `{ confirm_name, otp_code }` | `{ deleted_at }` | 401 `OTP_INVALID`, 422 `CONFIRM_NAME_MISMATCH`, 429 |
| S-09 | `POST /store/restore` | W | `{ store_id }` (from S-03 `deleted_store`) | `{ store }` | 404, 409 `ACTIVE_STORE_EXISTS` |

S-03, S-04, S-09 run in `withUserTransaction` (only `app.user_id`). S-08 checks the OTP with
Supabase **before** `BEGIN`, writes the audit row **before** setting `deleted_at`.

### Customers

| Op | Method & path | W | Input | Output | Errors |
|---|---|---|---|---|---|
| R-02 | `GET /customers?filter=debtors\|all&sort=debt\|name` | | default `debtors`, `debt` | `{ customers: [{ id, primary_name } & Account] }` | |
| C-06 | `GET /customers/search?q=` | | `q` 1–180 | `{ results: [{ id, primary_name, matched_name, balance_agorot, deleted_at, rank }] }` (deleted last, max 10) | 400 |
| C-01 | `POST /customers` | W | `{ name, phone?, notes?, opening_balance_agorot?, opening_date?, force? }` | `201 { customer }` (with `OPENING_BALANCE` if given) | 409 `SIMILAR_NAMES`, 409 `NAME_EXISTS` |
| R-03 | `GET /customers/{id}?cursor=` | | `cursor` from the previous page | `{ customer: Customer, operations: Operation[], next_cursor: string \| null }` (50 per page, cancelled included) | 404 |
| R-04 | `GET /customers/{id}/statement` | | — (the browser renders the PDF, decision D3) | `{ store_name, customer_name, rows: [{ effective_date, effective_time, type, amount_agorot, description, running_agorot }], balance_agorot }` (active only) | 404 |
| C-02 | `PATCH /customers/{id}` | W | `{ phone, notes }` | `{ customer }` | 404, 409 `CUSTOMER_DELETED` |
| C-03 | `POST /customers/{id}/rename` | W | `{ new_name, keep_old_as_alias? }` (default `true`) | `{ customer }` | 409 `NAME_EXISTS` |
| C-04 | `POST /customers/{id}/aliases` | W | `{ alias }` | `201 { alias: { id, name } }` | 409 `NAME_EXISTS` |
| C-05 | `DELETE /customers/{id}/aliases/{name_id}` | W | — | `204` | 404, 422 `PRIMARY_NAME` |
| C-07 | `POST /customers/{id}/delete` | W | `{ expected_version }` | `{ customer_id } & Account` | 409 `STALE_DRAFT`, 422 `BALANCE_NOT_ZERO` |
| C-08 | `POST /customers/{id}/restore` | W | — | `{ customer }` | 404 |

C-07 is `POST …/delete`, not HTTP `DELETE`: it carries a body and nothing is removed.
C-06 returns one row per customer (its best-matching name); the operations doc's query can return a
customer twice when an alias also matches. R-01 recent, R-03 and R-05 leave out `MERGE_TRANSFER` (merge is V2).
C-02 … C-05 on a deleted customer → `409 CUSTOMER_DELETED`.
`cursor` is opaque (base64 of `effective_date, effective_time, created_at, id`).

**MVP frontend scope decision (2026-11-23):** Customer merge (`FR-08`), data export (`FR-18`), customer deletion (`C-07`), and store deletion (`S-08`) are **not supported in the MVP frontend**. Keep the backend/schema/API implementation and documented contracts as-is; this is a frontend scope decision, not an instruction to remove or disable endpoints. Some endpoints may already exist while others are not implemented; their individual statuses below remain authoritative. Customer alias removal (`C-05`) is not customer deletion. Enforce authorization on the server independently of UI visibility.

### Ledger

| Op | Method & path | W | Input | Output | Errors |
|---|---|---|---|---|---|
| L-01 | `POST /customers/{id}/debts` | W | `{ expected_version, amount_agorot, description?, effective_date, effective_time? }` | `201 LedgerResult` | 409 `STALE_DRAFT`, 409 `CUSTOMER_DELETED`, 422 `HISTORY_NEGATIVE` |
| L-02 | `POST /customers/{id}/payments` | W | same as L-01, plus `full?: boolean` (then omit `amount_agorot`) | `201 LedgerResult & { amount_agorot }` | as L-01, plus 422 `OVERPAYMENT`, 422 `NOTHING_TO_PAY` |
| L-03 | `POST /customers/{id}/opening-balance` | W | `{ expected_version, amount_agorot, description?, effective_date }` (no time) | `201 LedgerResult` | as L-01 |
| K-01 | `PATCH /operations/{id}` | W | `{ expected_version, amount_agorot?, effective_date?, description?, reason }` (at least one change) | `LedgerResult` | 404, 409 `STALE_DRAFT`, 422 `OPERATION_NOT_ACTIVE`, 422 `HISTORY_NEGATIVE` |
| K-02 | `POST /operations/{id}/cancel` | W | `{ expected_version, reason }` | `LedgerResult` | 404, 409 `STALE_DRAFT`, 422 `OPERATION_NOT_ACTIVE`, 422 `HISTORY_NEGATIVE` |

`amount_agorot` > 0. `full: true` pays exactly the locked balance; the response returns the amount used.

**Full-payment limit exception (L-02):** The ₪1,000,000 cap applies only to explicitly supplied amounts. With `full: true`, the request **must omit** `amount_agorot`; the server locks the customer account and sets the payment amount to its current balance. A balance of ₪1,200,000 (`"120000000"` agorot), for example, is payable in one full-payment request, returning `amount_agorot: "120000000"` and `balance_agorot: "0"`. Sending `amount_agorot: "120000000"` explicitly instead is rejected with `400 VALIDATION_FAILED`. A zero balance still returns `422 NOTHING_TO_PAY`. The usual `expected_version` and historical-balance rules still apply.

`expected_version` for K-01/K-02 is the version of the operation's customer account.

### Reads, lookup, export

| Op | Method & path | W | Input | Output | Errors |
|---|---|---|---|---|---|
| R-01 | `GET /dashboard` | | — | `{ total_debt_agorot, debtors: number, collected_this_month_agorot, recent: [{ type, status, amount_agorot, customer_name, effective_date, created_at }] }` (last 5) | |
| R-05 | `GET /activity?from=&to=&cursor=&customer_id=` | | dates `YYYY-MM-DD`; `customer_id` from C-06 | `{ items: [{ created_at, customer_name, type, status, amount_agorot, effective_date }], next_cursor }` (50) | 400 |
| R-06 | `GET /requests/{request_id}` | | — | `{ action, resource_id, response, created_at }` | 404 `REQUEST_NOT_FOUND` |
| FR-18 | `POST /export` (**not built yet**: open items 1–2) | W | `{ otp_code }` | `200 application/zip`: `Customers.csv`, `Transactions.csv` (UTF-8 with BOM, Arabic, entry date + effective date + status) | 401 `OTP_INVALID`, 429 |

---

## 5. Decisions and open items

Decided 2026-11-05:

- **D1 — Another store's id returns `404 NOT_FOUND`, not 403.** With RLS the server cannot tell
  "another store's customer" from "no such customer" without a privileged lookup, and 403 would
  confirm the id exists. PRD AT-04 ("403") is read as "blocked, nothing leaked".
- **D2 — Limits** (the earlier docs set none): max ₪1,000,000.00 (`"100000000"`) for
  **explicitly supplied** operation amounts. L-02 full payment (`full: true`) is an exception:
  it omits `amount_agorot` and pays the entire locked balance, including balances above this cap.
  Description 500, notes 1000, reason 500 characters; phone Israeli and stored as E.164.
  See "Limits" in section 2 and the L-02 full-payment note.
- **D3 — Statement PDF (FR-17) is rendered in the browser** from the R-04 JSON. No PDF on the server.

Still OPEN (no proposal yet):

1. **Export content (FR-18):** the operations doc has no SQL for it. Columns of `Customers.csv`
   and `Transactions.csv`, and the audit row (`action: 'STORE_EXPORT'`), need a short spec.
2. **Fresh OTP for S-08 and export:** which Supabase Auth call verifies the code on the server
   (reauthentication nonce vs. `verifyOtp` on the owner's phone). Decide with the Auth setup in step 5.
