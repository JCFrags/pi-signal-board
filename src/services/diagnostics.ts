import {
  SIGNAL_BOARD_ERROR_CODES,
  type SignalBoardErrorCode,
  type UnexpectedErrorArea,
  type UnexpectedErrorCategory,
  type UnexpectedErrorDiagnosticSink,
} from '../domain/errors.js';

export const DIAGNOSTIC_CAPACITY = 100;

export const DIAGNOSTIC_CODES = [...SIGNAL_BOARD_ERROR_CODES, 'SB_REPLAY_SKIPPED'] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'error'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const DIAGNOSTIC_AREAS = [
  'compatibility',
  'config',
  'replay',
  'persistence',
  'delivery',
  'ui',
  'lifecycle',
] as const;
export type DiagnosticArea = (typeof DIAGNOSTIC_AREAS)[number];

/** Fixed categories prevent diagnostic callers from storing exception or board text. */
export const DIAGNOSTIC_SAFE_CATEGORIES = [
  'invalid_data',
  'unsupported_version',
  'disabled',
  'command_ambiguous',
  'decode_rejected',
  'invariant_violation',
  'append_rejected',
  'host_rejected',
  'runtime_unavailable',
  'io_failure',
  'ui_unsupported',
  'ui_failure',
  'unexpected',
] as const;
export type DiagnosticSafeCategory = (typeof DIAGNOSTIC_SAFE_CATEGORIES)[number];

/**
 * A content-free diagnostic event. Deliberately absent fields include messages,
 * causes, stacks, board text, path values, and exception names.
 */
export interface DiagnosticRecord {
  readonly at: string;
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly area: DiagnosticArea;
  readonly category: DiagnosticSafeCategory;
  readonly correlationId?: string;
}

export interface ReplayDiagnosticCounts {
  readonly accepted: number;
  readonly skipped: number;
}

export interface DeliveryFailureDiagnostic {
  readonly at: string;
  readonly code: 'SB_DELIVERY_FAILED';
  readonly category: DiagnosticSafeCategory;
}

export interface DiagnosticsSnapshot {
  readonly records: readonly DiagnosticRecord[];
  readonly retained: number;
  readonly totalRecorded: number;
  readonly counts: Readonly<Partial<Record<DiagnosticCode, number>>>;
  readonly replay: ReplayDiagnosticCounts;
  readonly deliveryFailureCount: number;
  readonly latestDeliveryFailure?: DeliveryFailureDiagnostic;
}

export interface Diagnostics extends UnexpectedErrorDiagnosticSink {
  record(record: DiagnosticRecord): void;
  snapshot(): DiagnosticsSnapshot;
  count(code?: DiagnosticCode): number;
  setReplayCounts(accepted: number, skipped: number): void;
}

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const INVALID_CORRELATION_ID = 'sb-invalid-correlation-id';

/** Create one runtime-scoped diagnostics store with an exact 100-record ring. */
export function createDiagnostics(): Diagnostics {
  return new BoundedDiagnostics();
}

class BoundedDiagnostics implements Diagnostics {
  readonly #records: DiagnosticRecord[] = [];
  readonly #counts = new Map<DiagnosticCode, number>();
  #totalRecorded = 0;
  #replayAccepted = 0;
  #replaySkipped = 0;
  #deliveryFailureCount = 0;
  #latestDeliveryFailure: DeliveryFailureDiagnostic | undefined;

  record(input: DiagnosticRecord): void {
    const record = normalizeRecord(input);
    if (this.#records.length === DIAGNOSTIC_CAPACITY) {
      this.#records.shift();
    }
    this.#records.push(record);
    this.#totalRecorded += 1;
    this.#counts.set(record.code, (this.#counts.get(record.code) ?? 0) + 1);

    if (record.code === 'SB_DELIVERY_FAILED') {
      this.#deliveryFailureCount += 1;
      this.#latestDeliveryFailure = Object.freeze({
        at: record.at,
        code: record.code,
        category: record.category,
      });
    }
  }

  recordUnexpectedError(record: {
    readonly at: string;
    readonly correlationId: string;
    readonly area: UnexpectedErrorArea;
    readonly category: UnexpectedErrorCategory;
  }): void {
    this.record({
      at: record.at,
      code: 'SB_INTERNAL',
      severity: 'error',
      area: record.area,
      category: record.category,
      correlationId: record.correlationId,
    });
  }

  snapshot(): DiagnosticsSnapshot {
    const records = Object.freeze([...this.#records]);
    const counts = Object.freeze(Object.fromEntries(this.#counts)) as Readonly<
      Partial<Record<DiagnosticCode, number>>
    >;
    const replay = Object.freeze({
      accepted: this.#replayAccepted,
      skipped: this.#replaySkipped,
    });

    const base = {
      records,
      retained: records.length,
      totalRecorded: this.#totalRecorded,
      counts,
      replay,
      deliveryFailureCount: this.#deliveryFailureCount,
    };
    if (this.#latestDeliveryFailure === undefined) {
      return Object.freeze(base);
    }
    return Object.freeze({ ...base, latestDeliveryFailure: this.#latestDeliveryFailure });
  }

  count(code?: DiagnosticCode): number {
    return code === undefined ? this.#totalRecorded : (this.#counts.get(code) ?? 0);
  }

  setReplayCounts(accepted: number, skipped: number): void {
    this.#replayAccepted = safeCount(accepted);
    this.#replaySkipped = safeCount(skipped);
  }
}

function normalizeRecord(input: DiagnosticRecord): DiagnosticRecord {
  const at = isUtcTimestamp(input.at) ? input.at : FALLBACK_TIMESTAMP;
  const code = includes(DIAGNOSTIC_CODES, input.code) ? input.code : 'SB_INTERNAL';
  const severity = includes(DIAGNOSTIC_SEVERITIES, input.severity) ? input.severity : 'error';
  const area = includes(DIAGNOSTIC_AREAS, input.area) ? input.area : 'lifecycle';
  const category = includes(DIAGNOSTIC_SAFE_CATEGORIES, input.category)
    ? input.category
    : 'unexpected';

  if (input.correlationId === undefined) {
    return Object.freeze({ at, code, severity, area, category });
  }
  return Object.freeze({
    at,
    code,
    severity,
    area,
    category,
    correlationId: SAFE_CORRELATION_ID.test(input.correlationId)
      ? input.correlationId
      : INVALID_CORRELATION_ID,
  });
}

function includes<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_TIMESTAMP.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Public diagnostic codes that correspond directly to operational failures. */
export type OperationalDiagnosticCode = SignalBoardErrorCode;
