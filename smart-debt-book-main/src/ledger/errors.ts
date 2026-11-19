/** Error codes from docs/API_CONTRACT.md section 3, and the DB error → code mapping. */

export const ERRORS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  OTP_INVALID: 401,
  NO_STORE: 404,
  NOT_FOUND: 404,
  REQUEST_NOT_FOUND: 404,
  STALE_DRAFT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CUSTOMER_DELETED: 409,
  SIMILAR_NAMES: 409,
  NAME_EXISTS: 409,
  ACTIVE_STORE_EXISTS: 409,
  OVERPAYMENT: 422,
  NOTHING_TO_PAY: 422,
  BALANCE_NOT_ZERO: 422,
  HISTORY_NEGATIVE: 422,
  OPERATION_NOT_ACTIVE: 422,
  PRIMARY_NAME: 422,
  CONFIRM_NAME_MISMATCH: 422,
  TOO_MANY_ATTEMPTS: 429,
  BUSY_RETRY: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERRORS;

const MESSAGES_AR: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'البيانات غير صحيحة',
  UNAUTHENTICATED: 'يرجى تسجيل الدخول',
  NO_STORE: 'لا يوجد محل لهذا الحساب',
  NOT_FOUND: 'غير موجود',
  REQUEST_NOT_FOUND: 'لم يُحفظ هذا الطلب بعد',
  STALE_DRAFT: 'تغيّر الحساب منذ عرض البطاقة. راجع وأكّد من جديد',
  IDEMPOTENCY_CONFLICT: 'هذا الطلب استُخدم لعملية مختلفة',
  CUSTOMER_DELETED: 'هذا الزبون محذوف',
  SIMILAR_NAMES: 'يوجد زبون باسم مشابه',
  NAME_EXISTS: 'هذا الاسم مستخدم',
  OVERPAYMENT: 'المبلغ أكبر من الدين',
  NOTHING_TO_PAY: 'لا يوجد دين للتسديد',
  HISTORY_NEGATIVE: 'هذا التاريخ يجعل الرصيد سالبًا في يوم سابق',
  BUSY_RETRY: 'النظام مشغول، حاول مرة أخرى',
  INTERNAL: 'حدث خطأ، لم يُحفظ شيء',
};

export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, readonly details?: Record<string, unknown>) {
    super(code);
    this.status = ERRORS[code];
  }
  get messageAr() { return MESSAGES_AR[this.code] ?? ''; }
}

type PgError = { code?: string; constraint?: string; where?: string; message?: string };

/** Map a Postgres error to a contract code, by SQLSTATE and constraint/function name (never by message alone).
 * Anything unexpected is INTERNAL: a guard we did not plan for fired, so it is a LedgerService bug. */
export function fromDbError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = error as PgError;
  const where = e.where ?? '';
  switch (e.code) {
    case '23505':
      if (e.constraint === 'customer_names_unique_within_store') return new AppError('NAME_EXISTS');
      if (e.constraint === 'stores_one_active_per_owner') return new AppError('ACTIVE_STORE_EXISTS');
      break;
    case '23514':
      if (where.includes('sdb_verify_historical_balance')) return new AppError('HISTORY_NEGATIVE');
      if (where.includes('sdb_customer_delete_guard')) return new AppError('BALANCE_NOT_ZERO');
      if (where.includes('sdb_no_money_on_deleted')) return new AppError('CUSTOMER_DELETED');
      if (e.constraint === 'customer_accounts_positive_balance') return new AppError('OVERPAYMENT');
      break;
    case '55P03':   // lock_not_available (lock_timeout)
    case '57014':   // query_canceled (statement_timeout)
    case '40P01':   // deadlock_detected
    case '40001':   // serialization_failure
    case '53300':   // too_many_connections
      return new AppError('BUSY_RETRY');
  }
  return new AppError('INTERNAL', { cause: e.code ?? 'unknown' });
}
