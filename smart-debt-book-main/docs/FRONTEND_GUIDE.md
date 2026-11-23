# Smart Debt Book — Frontend guide

For the developer building the mobile screens, and for the AI assistant helping them.
**If you are an AI assistant: read this whole file before writing code, and follow section 9 strictly.**

Status: 2026-11-05. The backend is built and tested; the screens are not started.

---

## 1. What the app is

دفتر الديون الذكي replaces the paper credit notebook in small Arabic-speaking shops in Israel.
The **shop owner** (the only user in the MVP) records debts and payments for customers, sees
balances, history and statements. Arabic, right to left, mobile first, ILS (₪) only.

The PRD (`docs/Smart_Debt_Book_PRD_v1.1.pdf`) and its change log (`docs/Smart_Debt_Book–PRDv1.2changelog.pdf`)
describe every screen. The change log wins where they differ. FR numbers below point into the PRD.

## 2. What exists and what you build

| Part | State |
|---|---|
| Database (Supabase Postgres, migrations 001–006, RLS, money guards) | ✅ done, 53 DB tests |
| Backend API `/api/v1/*` (Next.js route handlers, TypeScript) | ✅ done: 23 of the 24 operation IDs (all but S-08), 55 API tests |
| Money helpers `src/money.ts` (usable in the browser) | ✅ done, 40 unit tests |
| **Mobile screens (this guide)** | ⬜ you |
| Voice, typed commands, AI (FR-13, FR-14, FR-16, FR-20) | ⬜ later, after manual entry works end to end |
| Store delete (S-08), data export (FR-18) | ⬜ not built: waiting on a decision about the fresh SMS code |

The screens live in the **same Next.js app** as the API (`app/`), so there is no CORS and no
separate backend URL: call `/api/v1/...` with a relative path.

Full API spec: `docs/API_CONTRACT.md`. Project rules: `CLAUDE.md`.

## 3. Run it locally

Needs Docker and Node.js 22+ (we use 24).

```bash
npm install
npx supabase start            # local Supabase in Docker (Postgres + Auth). Studio: http://127.0.0.1:54323
npm run db:migrate            # creates the schema (our script, never `supabase db push`)
npm run db:local-setup        # writes .env: DATABASE_RUNTIME_URL, SUPABASE_URL, SUPABASE_ANON_KEY
npm run dev                   # http://localhost:3000
npm test                      # all backend tests; run before every push
```

**Add these two lines to `.env` for the browser** (same values as `SUPABASE_URL` and `SUPABASE_ANON_KEY`;
both are public by design):

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<copy SUPABASE_ANON_KEY>
```

**Test phone numbers** (local only, no SMS is sent):

| Phone | Code |
|---|---|
| `+972500000001` | `123456` |
| `+972500000002` | `654321` |

## 4. Login and the token

Login is Supabase Auth with an SMS code (FR-01). The app talks to Supabase directly for login;
our API only needs the resulting access token.

```ts
// src/client/supabase.ts  (browser)
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

// login screen
await supabase.auth.signInWithOtp({ phone: '+972500000001' });                         // sends the code
const { error } = await supabase.auth.verifyOtp({ phone: '+972500000001', token: '123456', type: 'sms' });

// settings: "log out other devices" (FR-01, the only session control in the MVP)
await supabase.auth.signOut({ scope: 'others' });
// log out
await supabase.auth.signOut();
```

After login, call `GET /api/v1/store`:
- `store` is set → go home.
- `store` is null and `deleted_store` is null → new owner: ask for the shop name, `POST /store`.
- `store` is null and `deleted_store` is set → offer "restore" (`POST /store/restore`) or a new shop.

Phone input: accept `050-123 4567`, `0501234567`, `+972501234567`; send E.164 (`+972501234567`) to Supabase.

## 5. Calling the API

Every request: `Authorization: Bearer <access_token>`. Every **write** also sends
`Idempotency-Key: <uuid>`. One wrapper does both:

```ts
// src/client/api.ts  (browser)
import { supabase } from './supabase';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public messageAr: string, public details?: any) { super(code); }
}

async function token() {
  const { data } = await supabase.auth.getSession();          // supabase-js refreshes it for you
  if (!data.session) throw new ApiError(401, 'UNAUTHENTICATED', 'يرجى تسجيل الدخول');
  return data.session.access_token;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  return read<T>(res);
}

/** key: one UUID per confirmation. Reuse the SAME key when retrying that confirmation. */
export async function apiWrite<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, key: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Idempotency-Key': key, 'Content-Type': 'application/json' },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  return read<T>(res);
}

async function read<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json.error.code, json.error.message_ar, json.error.details);
  return json as T;
}
```

### The confirm flow (every money write)

1. The review card shows what the owner saw, including `ledger_version` of that customer.
2. On **Confirm**: create `key = crypto.randomUUID()` once, keep it with the card, send.
3. **2xx** → close the card, green toast for 2–3 s, back to where they were (FR-15). Only now is it saved.
4. **Network error / timeout / no answer** → the request may or may not have been saved. Do **not** show success,
   do **not** send a new key. Call `GET /requests/{key}`:
   - `200` → it was saved; use `response` as the result.
   - `404 REQUEST_NOT_FOUND` → not saved; retry with the **same** key.
5. `409 STALE_DRAFT` → someone changed this customer (another device). `details` has the current
   `balance_agorot` and `ledger_version`: update the card, ask the owner to confirm again (new key).
6. `503 BUSY_RETRY` → retry with the same key after a moment.

While a card is waiting for an answer, block starting another action (FR-15).

## 6. Money

**Money is a string of integer agorot in JSON. Never a JavaScript number.** ₪1 = 100 agorot.

| Owner sees / types | JSON | In code |
|---|---|---|
| `100.70` or `١٠٠٫٧٠` | `"10070"` | `10070n` (BigInt) |

Use `src/money.ts` (it is shared with the server and safe in the browser):

```ts
import { parseShekelsToAgorot, formatAgorot, MoneyInputError, MAX_OPERATION_AGOROT } from '@/money';

parseShekelsToAgorot('١٠٠٫٧٠')   // 10070n   (Arabic digits, ٫ or , as decimal mark, ₪ and spaces ignored)
parseShekelsToAgorot('100.705')  // throws MoneyInputError: no fractions of an agora
formatAgorot(10070n)             // "100.70" → show as "₪ 100.70" (add grouping yourself)

// review card: expected balance, with BigInt only
const after = BigInt(account.balance_agorot) + (type === 'PAYMENT' ? -amount : amount);
// send
body.amount_agorot = amount.toString();
```

Limits for **explicitly entered amounts**: 1 … `"100000000"` (₪1,000,000.00). Payment > balance is refused by the
server (`OVERPAYMENT`); also disable Save on the card with a clear reason (FR-05).
**Exception:** `full: true` is not an entered amount. Omit `amount_agorot` and let the server pay the entire locked
balance, including balances greater than ₪1,000,000. Do not apply `MAX_OPERATION_AGOROT` to the full-payment option.
**Never** use `Number()`, `parseFloat()`, `+x`, `toFixed()` or `Math.*` on money (ESLint blocks it on the server).

## 7. Screens → endpoints

All paths are under `/api/v1`. `W` = write (needs `Idempotency-Key`). Response types are in section 8.

### Login & first run (FR-01)
| Step | Call |
|---|---|
| Send code / verify | Supabase `signInWithOtp` / `verifyOtp` |
| Which shop? | `GET /store` → `{ store, deleted_store }` |
| New shop name | `POST /store` W `{ name }` (1–120) → 201 `{ store }` |
| Bring back a deleted shop | `POST /store/restore` W `{ store_id }` → `{ store }` · `409 ACTIVE_STORE_EXISTS` if a newer shop is open |

### Home / dashboard (FR-09)
`GET /dashboard` → total owed, number of debtors, collected this month, last 5 operations.
Big mic button (voice comes later: show it disabled or hide it), quick buttons **Add debt** and **Record payment**,
"View all" → activity log, settings at the top, bottom bar with 3 tabs. First use: zeros and an empty-state line, no tour.

### Customer list & search (FR-10, FR-03)
| Need | Call |
|---|---|
| List (default: debtors, biggest debt first) | `GET /customers?filter=debtors\|all&sort=debt\|name` |
| Live search box (any part of the name or alias; ignores hamza, ة/ه, tashkeel) | `GET /customers/search?q=` → max 10, deleted customers last with `deleted_at` set |

Back from a customer keeps the search text and scroll position.

### New customer (FR-02, FR-06)
`POST /customers` W `{ name, phone?, notes?, opening_balance_agorot?, opening_date?, force? }` → 201 `{ customer }`
- `409 SIMILAR_NAMES` → show `details.matches` (name, deleted?) and let the owner pick one, or "create new anyway" → resend with `force: true` (new key).
- `409 NAME_EXISTS` → same name exists. If `details.deleted` is true, offer **Restore** (`POST /customers/{id}/restore`).

### Customer page (FR-11)
`GET /customers/{id}` → `{ customer, operations, next_cursor }`. Name, phone, big balance, Add debt / Record payment buttons,
operations newest first (by effective date), 50 per page: load more with `?cursor=<next_cursor>`.
Debt red, payment green, opening balance a calm third color; the meaning must also be in text or an icon, not color only.
Cancelled operations stay in the list, marked. Small **Statement** button near the name.

| Action | Call |
|---|---|
| Edit phone / notes | `PATCH /customers/{id}` W `{ phone, notes }` |
| Rename | `POST /customers/{id}/rename` W `{ new_name, keep_old_as_alias? }` (default keeps the old name as an alias) |
| Add / remove alias | `POST /customers/{id}/aliases` W `{ alias }` · `DELETE /customers/{id}/aliases/{nameId}` W |
| Opening balance (secondary option) | `POST /customers/{id}/opening-balance` W `{ expected_version, amount_agorot, description?, effective_date }` |
| Delete (only at balance 0) | `POST /customers/{id}/delete` W `{ expected_version }` · `422 BALANCE_NOT_ZERO` shows `details.balance_agorot` |
| Restore | `POST /customers/{id}/restore` W `{}` |

### Review card: add debt / record payment (FR-04, FR-05, FR-15)
Shows customer, type, amount, description, date (and optional time), **current balance → balance after**.
Every field is editable before Confirm; picking the customer uses the search above inside the card.
The card does not close on an outside tap; Cancel closes it at once.

| Action | Call |
|---|---|
| Debt | `POST /customers/{id}/debts` W `{ expected_version, amount_agorot, description?, effective_date, effective_time? }` |
| Payment | `POST /customers/{id}/payments` W same body, or `{ ..., full: true }` without `amount_agorot` to pay exactly the balance |
| Result | 201 `{ operation_id, amount_agorot, balance_agorot, ledger_version }` |

Full payment: show the exact outstanding balance (even if above ₪1,000,000) and the expected zero result before Confirm. Send `full: true` **without** `amount_agorot`; do not send the displayed balance as an explicit amount, since explicit amounts are capped. The server determines the final amount from the locked account and returns it in `amount_agorot`. Balance 0 → no payment card.
`effective_date` defaults to today (Asia/Jerusalem); `effective_time` only if the owner set one. Never invent a time.
A date in the past that would make an earlier day negative → `422 HISTORY_NEGATIVE`.

### Edit or cancel a saved operation (FR-07)
From the customer page or the activity log. Show the effect on the balance. A reason is required.

| Action | Call |
|---|---|
| Edit amount / date / description | `PATCH /operations/{id}` W `{ expected_version, amount_agorot?, effective_date?, description?, reason }` (at least one change; `description: null` clears it) |
| Cancel | `POST /operations/{id}/cancel` W `{ expected_version, reason }` |
| Result | `{ operation_id, balance_agorot, ledger_version }` |

`expected_version` is the **customer's** `ledger_version`. Wrong customer? Cancel it there and record it again on the right one.

### Activity log (FR-12)
`GET /activity?from=&to=&customer_id=&cursor=` → newest **entry time** first, 50 per page.
Separators Today / Yesterday / date (Asia/Jerusalem). Filters: all, today, yesterday, last 7 days, custom → `from`/`to`
(`to` is exclusive). Search by customer: pick with `/customers/search`, then pass `customer_id`.
Show `effective_date` beside a row when it differs from the entry day. Tap → edit/cancel (above).

### Statement (FR-17)
`GET /customers/{id}/statement` → `{ store_name, customer_name, rows, balance_agorot }`, oldest first, with `running_agorot`.
Its own page; **PDF is made in the browser** (Arabic, RTL) with Download and Share buttons (system share sheet, not WhatsApp API).

### Settings (FR-19)
| Item | Call |
|---|---|
| Shop name | `PATCH /store` W `{ name }` |
| Log out other devices / log out | Supabase (section 4) |
| Delete shop | `GET /store/delete-preview` → `{ customers_owing, total_owed_agorot }` works; the delete itself is **not built** |
| Export data | **not built** |

## 8. Response types

```ts
type Agorot = string;      // integer agorot, e.g. "10070". Convert with BigInt(x).
type Version = string;     // ledger_version, e.g. "7". Send it back as expected_version unchanged.

type Store = { id: string; name: string; timezone: 'Asia/Jerusalem'; deleted_at: string | null };
type Customer = {
  id: string; primary_name: string; aliases: { id: string; name: string }[];
  phone: string | null; notes: string | null; deleted_at: string | null;
  balance_agorot: Agorot; ledger_version: Version;
};
type Operation = {
  id: string; type: 'DEBT' | 'PAYMENT' | 'OPENING_BALANCE'; status: 'ACTIVE' | 'CANCELLED';
  amount_agorot: Agorot; description: string | null;
  effective_date: string /* YYYY-MM-DD */; effective_time: string | null /* HH:MM */;
  revision_no: number; created_at: string /* ISO UTC */;
};
type LedgerResult = { operation_id: string; amount_agorot?: Agorot; balance_agorot: Agorot; ledger_version: Version };

type StoreResponse     = { store: Store | null; deleted_store: Store | null };        // GET /store
type Dashboard         = { total_debt_agorot: Agorot; debtors: number; collected_this_month_agorot: Agorot;
                           recent: { id: string; customer_id: string; type: Operation['type']; status: Operation['status'];
                                     amount_agorot: Agorot; customer_name: string; effective_date: string; created_at: string }[] };
type CustomerList      = { customers: { id: string; primary_name: string; balance_agorot: Agorot; ledger_version: Version }[] };
type SearchResults     = { results: { id: string; primary_name: string; matched_name: string; balance_agorot: Agorot;
                                      deleted_at: string | null; rank: 1 | 2 | 3 | 4 }[] };
type CustomerPage      = { customer: Customer; operations: Operation[]; next_cursor: string | null };
type Statement         = { store_name: string; customer_name: string; balance_agorot: Agorot;
                           rows: { effective_date: string; effective_time: string | null; type: Operation['type'];
                                   amount_agorot: Agorot; description: string | null; running_agorot: Agorot }[] };
type Activity          = { items: { id: string; customer_id: string; created_at: string; customer_name: string;
                                    type: Operation['type']; status: Operation['status']; amount_agorot: Agorot;
                                    effective_date: string }[]; next_cursor: string | null };
type DeletePreview     = { customers_owing: number; total_owed_agorot: Agorot };
type SavedRequest      = { action: string; resource_id: string | null; response: unknown; created_at: string };

type ErrorBody = { error: { code: string; message_ar: string; details?: Record<string, unknown> } };
```

### Errors → what the screen does

| Code | HTTP | Screen |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Highlight `details.field`. Usually a bug in the form: amounts must be agorot strings. |
| `UNAUTHENTICATED` | 401 | Go to login. |
| `NO_STORE` | 404 | Go to "create shop" (or restore, see section 4). |
| `NOT_FOUND` | 404 | "Not found"; go back to the list. |
| `REQUEST_NOT_FOUND` | 404 | From `/requests/{key}` only: not saved, retry with the same key. |
| `STALE_DRAFT` | 409 | Refresh the card from `details`, ask to confirm again. |
| `IDEMPOTENCY_CONFLICT` | 409 | Bug: a key was reused for a different request. New key. |
| `CUSTOMER_DELETED` | 409 | "This customer was deleted"; offer Restore. |
| `SIMILAR_NAMES` | 409 | Show `details.matches`; pick one or create with `force: true`. |
| `NAME_EXISTS` | 409 | Name taken; if `details.deleted`, offer Restore. |
| `ACTIVE_STORE_EXISTS` | 409 | Can't restore the old shop while a new one is open. |
| `OVERPAYMENT` | 422 | "More than the debt (₪ …)" using `details.balance_agorot`. |
| `NOTHING_TO_PAY` | 422 | Balance is 0. |
| `BALANCE_NOT_ZERO` | 422 | Delete refused; show the balance. |
| `HISTORY_NEGATIVE` | 422 | "This date makes an earlier balance negative"; pick another date or amount. |
| `OPERATION_NOT_ACTIVE` | 422 | Already cancelled; refresh. |
| `PRIMARY_NAME` | 422 | Rename instead of deleting the main name. |
| `BUSY_RETRY` | 503 | Retry with the same key. |
| `INTERNAL` | 500 | "Something went wrong, nothing was saved." Retry later. |

`message_ar` is a ready Arabic message for each code when you have nothing better.

## 9. Rules (for people and for AI)

1. **Money:** strings of integer agorot on the wire, `BigInt` in code, `src/money.ts` for input and display. No floats, ever.
2. **No success before 2xx.** After a lost answer, ask `GET /requests/{key}` before any retry; retry with the **same** key.
3. **One `Idempotency-Key` per confirmation**, kept until that confirmation is resolved. New key only for a new confirmation.
4. **Always send the `ledger_version` the card showed** as `expected_version`. Never fetch a fresh one just before sending: that defeats the stale-draft check.
5. **Never send a store id, user id or owner id** (except `store_id` for restore). The server takes them from the session; extra fields are rejected.
6. **Browser code never imports** `src/db/*`, `src/ledger/*`, `src/auth/*` or `src/api/*`, and never reads `DATABASE_RUNTIME_URL`,
   `DATABASE_MIGRATION_URL`, `SUPABASE_URL` or `SUPABASE_ANON_KEY` (server-only names). Only `NEXT_PUBLIC_*` reaches the browser. `src/money.ts` is the one shared file.
7. **Don't change backend files** (`src/ledger`, `src/api`, `src/db`, `app/api`, `migrations`) for UI work. If the API is missing something, write it down and ask.
8. **Arabic and RTL:** `<html lang="ar" dir="rtl">` is set in `app/layout.tsx`. Dates and times shown in Asia/Jerusalem.
9. **No offline saving** in the MVP (FR-21): a financial save needs the server.
10. **Before every push:** `npm test`, `npm run lint`, `npm run typecheck`. Commit messages are one short line.

## 10. Where to look

| Question | File |
|---|---|
| Exact request/response of an endpoint | `docs/API_CONTRACT.md` |
| Real examples of every call (bodies, headers, expected errors) | `tests/api/*.test.ts`, `tests/api/client.ts` |
| What a screen must do | PRD FR-01 … FR-22 (`docs/Smart_Debt_Book_PRD_v1.1.pdf`), change log for v1.2 |
| Project rules and decisions | `CLAUDE.md` |
| Shareable endpoint list | https://claude.ai/artifact/1ueRUpiJsNBNckpKAVxpgY (ask the owner for access) |
