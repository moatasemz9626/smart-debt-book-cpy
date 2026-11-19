/** Request schemas. Limits: docs/API_CONTRACT.md section 2 (decision D2). */
import { z } from 'zod';
import { AGOROT_PATTERN, MAX_OPERATION_AGOROT } from '../money';

/** Money on the wire: a string of integer agorot, 1 … ₪1,000,000.00. Never a JSON number. */
export const amountAgorot = z.string()
  .regex(AGOROT_PATTERN, 'integer agorot as a string')
  .transform((s) => BigInt(s))
  .refine((v) => v >= 1n && v <= MAX_OPERATION_AGOROT, 'between 1 and 100000000 agorot');

export const version = z.string().regex(AGOROT_PATTERN, 'ledger_version as a string').transform((s) => BigInt(s));

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, 'a real date');

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((s) => (s ? s : null));

/** Israeli number → E.164 (+972…). 05X-XXXXXXX, 972…, +972…, spaces and dashes allowed. */
export const phone = z.string().nullish().transform((s, ctx) => {
  if (!s || !s.trim()) return null;
  const digits = s.replace(/[\s-]/g, '');
  const m = /^(?:\+?972|0)([2-9]\d{7,8})$/.exec(digits);
  if (!m) { ctx.addIssue({ code: 'custom', message: 'Israeli phone number' }); return z.NEVER; }
  return `+972${m[1]}`;
});

export const createStoreBody = z.object({ name: trimmed(1, 120) }).strict();

export const createCustomerBody = z.object({
  name: trimmed(1, 180),
  phone,
  notes: optionalText(1000),
  opening_balance_agorot: amountAgorot.nullish(),
  opening_date: isoDate.nullish(),
  force: z.boolean().optional().default(false),
}).strict();

const postBase = {
  expected_version: version,
  description: optionalText(500),
  effective_date: isoDate,
  effective_time: hhmm.nullish(),
};

export const debtBody = z.object({ ...postBase, amount_agorot: amountAgorot }).strict();

export const openingBalanceBody = z.object({
  expected_version: version, amount_agorot: amountAgorot, description: optionalText(500), effective_date: isoDate,
}).strict();

export const paymentBody = z.object({
  ...postBase,
  amount_agorot: amountAgorot.optional(),
  full: z.boolean().optional().default(false),
}).strict().refine((b) => b.full !== (b.amount_agorot !== undefined), {
  message: 'send amount_agorot, or full: true without an amount', path: ['amount_agorot'],
});

export const uuidParam = z.uuid();

export const renameStoreBody = createStoreBody;
export const restoreStoreBody = z.object({ store_id: z.uuid() }).strict();

export const updateCustomerBody = z.object({ phone, notes: optionalText(1000) }).strict();
export const renameCustomerBody = z.object({
  new_name: trimmed(1, 180),
  keep_old_as_alias: z.boolean().optional().default(true),
}).strict();
export const aliasBody = z.object({ alias: trimmed(1, 180) }).strict();
export const versionBody = z.object({ expected_version: version }).strict();
export const emptyBody = z.object({}).strict();

const reason = trimmed(1, 500);

export const editOperationBody = z.object({
  expected_version: version,
  amount_agorot: amountAgorot.optional(),
  effective_date: isoDate.optional(),
  description: z.string().trim().max(500).nullable().optional()
    .transform((s) => (s === undefined ? undefined : s ? s : null)),
  reason,
}).strict().refine((b) => b.amount_agorot !== undefined || b.effective_date !== undefined || b.description !== undefined, {
  message: 'change at least one of amount_agorot, effective_date, description', path: ['amount_agorot'],
});
export const cancelOperationBody = z.object({ expected_version: version, reason }).strict();

export const listQuery = z.object({
  filter: z.enum(['debtors', 'all']).default('debtors'),
  sort: z.enum(['debt', 'name']).default('debt'),
});
export const searchQuery = z.object({ q: trimmed(1, 180) });
export const activityQuery = z.object({
  from: isoDate.optional(), to: isoDate.optional(), cursor: z.string().optional(), customer_id: z.uuid().optional(),
});

/** URLSearchParams → plain object (first value per key). */
export const queryOf = (url: URL) => Object.fromEntries(url.searchParams.entries());

/** Today in Asia/Jerusalem as YYYY-MM-DD. */
export function todayJerusalem(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}
