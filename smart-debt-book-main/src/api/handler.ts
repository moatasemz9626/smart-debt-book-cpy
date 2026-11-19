/** Shared route-handler wrapper (docs/API_CONTRACT.md sections 2–3). Server-only. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifiedUserId } from '../auth/session';
import { AppError, fromDbError } from '../ledger/errors';
import { bigintToString, type RequestKey } from '../ledger/write';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Ctx = {
  userId: string;
  url: URL;
  body: unknown;
  key: RequestKey | null;     // set for writes
  params: Record<string, string>;
};

export type Reply = { status: number; body: unknown; replayed?: boolean };

type RouteContext = { params: Promise<Record<string, string>> };

/** Stable JSON: keys sorted, so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body, bigintToString), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function errorResponse(e: AppError) {
  return json(e.status, { error: { code: e.code, message_ar: e.messageAr, ...(e.details ? { details: e.details } : {}) } });
}

/** One wrapper for every endpoint. `write: true` requires Idempotency-Key and computes request_hash. */
export function route(opts: { write: boolean }, handle: (ctx: Ctx) => Promise<Reply>) {
  return async (request: Request, context?: RouteContext): Promise<Response> => {
    try {
      const userId = await verifiedUserId(request);
      const url = new URL(request.url);
      const params = (await context?.params) ?? {};

      let body: unknown = undefined;
      if (request.method !== 'GET' && request.method !== 'DELETE') {
        const text = await request.text();
        try { body = text ? JSON.parse(text) : {}; } catch { throw new AppError('VALIDATION_FAILED', { field: 'body', rule: 'JSON' }); }
      }

      let key: RequestKey | null = null;
      if (opts.write) {
        const id = request.headers.get('idempotency-key') ?? '';
        if (!UUID.test(id)) throw new AppError('VALIDATION_FAILED', { field: 'Idempotency-Key', rule: 'uuid' });
        const hash = createHash('sha256').update(`${request.method} ${url.pathname}\n${canonical(body ?? {})}`).digest('hex');
        key = { id: id.toLowerCase(), hash };
      }

      const reply = await handle({ userId, url, body, key, params });
      return json(reply.status, reply.body, reply.replayed ? { 'idempotent-replayed': 'true' } : {});
    } catch (error) {
      const e = fromDbError(error);
      if (e.code === 'INTERNAL') console.error('INTERNAL', error);   // never shown to the client
      return errorResponse(e);
    }
  };
}

/** Validate with zod; any failure is 400 VALIDATION_FAILED with the first problem. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new AppError('VALIDATION_FAILED', { field: issue.path.join('.') || 'body', rule: issue.message });
  }
  return r.data;
}
