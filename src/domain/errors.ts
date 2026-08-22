/** Public error codes returned by Agent Board boundaries. */
export const SIGNAL_BOARD_ERROR_CODES = [
  'SB_NOT_INITIALIZED',
  'SB_UNSUPPORTED_HOST',
  'SB_INVALID_ARGUMENT',
  'SB_NOT_FOUND',
  'SB_STATE_CONFLICT',
  'SB_REVISION_MISMATCH',
  'SB_UNSAFE_QUESTION',
  'SB_LIMIT_EXCEEDED',
  'SB_PERSISTENCE_FAILED',
  'SB_DELIVERY_FAILED',
  'SB_UI_UNAVAILABLE',
  'SB_CONFIG_INVALID',
  'SB_CONFIG_DISABLED',
  'SB_COMMAND_DISCOVERY_AMBIGUOUS',
  'SB_INTERNAL',
] as const;

export type SignalBoardErrorCode = (typeof SIGNAL_BOARD_ERROR_CODES)[number];

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/** Safe public failure. It never contains a cause, exception message, or stack. */
export interface SignalBoardError {
  readonly code: SignalBoardErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly fieldErrors?: readonly FieldError[];
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SignalBoardError };

interface ErrorDefinition {
  readonly message: string;
  readonly retryable: boolean;
}

/** Stable public text and retry guidance for each error code. */
export const ERROR_DEFINITIONS = {
  SB_NOT_INITIALIZED: {
    message: 'Agent Board is not initialized. Try again after session startup completes.',
    retryable: true,
  },
  SB_UNSUPPORTED_HOST: {
    message: 'This Node.js or Pi host version is not supported by Agent Board.',
    retryable: false,
  },
  SB_INVALID_ARGUMENT: {
    message: 'One or more arguments are invalid. Correct the identified fields and try again.',
    retryable: false,
  },
  SB_NOT_FOUND: {
    message: 'The requested item does not exist on the current session branch.',
    retryable: false,
  },
  SB_STATE_CONFLICT: {
    message:
      'The requested operation conflicts with the current board state. Refresh and try again.',
    retryable: true,
  },
  SB_REVISION_MISMATCH: {
    message: 'The item changed after it was read. Refresh it and try again.',
    retryable: true,
  },
  SB_UNSAFE_QUESTION: {
    message: 'This question requires an immediate synchronous user decision and cannot be queued.',
    retryable: false,
  },
  SB_LIMIT_EXCEEDED: {
    message: 'A Agent Board limit was reached. Reduce the request or try again later.',
    retryable: true,
  },
  SB_PERSISTENCE_FAILED: {
    message: 'Agent Board could not save the change. No success was recorded.',
    retryable: true,
  },
  SB_DELIVERY_FAILED: {
    message: 'The answer was saved, but Pi could not queue it for the agent.',
    retryable: true,
  },
  SB_UI_UNAVAILABLE: {
    message: 'The required interactive Agent Board interface is unavailable in this mode.',
    retryable: true,
  },
  SB_CONFIG_INVALID: {
    message: 'A Agent Board configuration document is invalid and was not applied.',
    retryable: false,
  },
  SB_CONFIG_DISABLED: {
    message: 'Agent Board is disabled by the effective configuration.',
    retryable: false,
  },
  SB_COMMAND_DISCOVERY_AMBIGUOUS: {
    message: 'Agent Board could not identify its command invocation unambiguously.',
    retryable: true,
  },
  SB_INTERNAL: {
    message: 'Agent Board encountered an unexpected internal error.',
    retryable: true,
  },
} as const satisfies Record<SignalBoardErrorCode, ErrorDefinition>;

export const FIELD_ERROR_REASONS = [
  'required',
  'invalid_type',
  'invalid_value',
  'out_of_range',
  'too_long',
  'too_many',
  'duplicate',
  'unsupported',
] as const;

export type FieldErrorReason = (typeof FIELD_ERROR_REASONS)[number];

const FIELD_ERROR_MESSAGES = {
  required: 'This field is required.',
  invalid_type: 'This field has the wrong type.',
  invalid_value: 'This field has an invalid value.',
  out_of_range: 'This field is outside the allowed range.',
  too_long: 'This field is too long.',
  too_many: 'This field contains too many values.',
  duplicate: 'This field contains a duplicate value.',
  unsupported: 'This field uses an unsupported value.',
} as const satisfies Record<FieldErrorReason, string>;

const SAFE_FIELD_PATH = /^(?:[A-Za-z][A-Za-z0-9_-]*)(?:\[(?:\d+|\*)\]|\.[A-Za-z][A-Za-z0-9_-]*)*$/u;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const INVALID_CORRELATION_ID = 'sb-invalid-correlation-id';
const INVALID_DIAGNOSTIC_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Build a content-free field error from a static field path and reason. */
export function fieldError(path: string, reason: FieldErrorReason): FieldError {
  return Object.freeze({
    path: SAFE_FIELD_PATH.test(path) ? path : 'input',
    message: FIELD_ERROR_MESSAGES[reason],
  });
}

/** Create a stable expected error. Unexpected exceptions must use convertUnexpectedError. */
export function signalBoardError(
  code: Exclude<SignalBoardErrorCode, 'SB_INTERNAL'>,
  fieldErrors?: readonly FieldError[],
): SignalBoardError {
  const definition = ERROR_DEFINITIONS[code];
  if (fieldErrors === undefined || fieldErrors.length === 0) {
    return Object.freeze({ code, message: definition.message, retryable: definition.retryable });
  }

  return Object.freeze({
    code,
    message: definition.message,
    retryable: definition.retryable,
    fieldErrors: Object.freeze(fieldErrors.map(copyFieldError)),
  });
}

export function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: SignalBoardError): Result<T> {
  return { ok: false, error };
}

export interface CorrelationIdGenerator {
  nextCorrelationId(): string;
}

export interface UnexpectedErrorDiagnosticSink {
  recordUnexpectedError(record: {
    readonly at: string;
    readonly correlationId: string;
    readonly area: UnexpectedErrorArea;
    readonly category: UnexpectedErrorCategory;
  }): void;
}

export type UnexpectedErrorArea =
  | 'compatibility'
  | 'config'
  | 'replay'
  | 'persistence'
  | 'delivery'
  | 'ui'
  | 'lifecycle';

export type UnexpectedErrorCategory =
  | 'invariant_violation'
  | 'runtime_unavailable'
  | 'host_rejected'
  | 'io_failure'
  | 'unexpected';

export interface UnexpectedErrorBoundary {
  readonly correlationIds: CorrelationIdGenerator;
  readonly at: string;
  readonly area: UnexpectedErrorArea;
  readonly category?: UnexpectedErrorCategory;
  readonly diagnostics?: UnexpectedErrorDiagnosticSink;
}

/**
 * Convert an unknown thrown value at a tool, command, or lifecycle boundary.
 * The cause is intentionally not inspected, retained, or copied.
 */
export function convertUnexpectedError(
  _cause: unknown,
  boundary: UnexpectedErrorBoundary,
): SignalBoardError {
  const correlationId = safeCorrelationId(boundary.correlationIds);
  try {
    boundary.diagnostics?.recordUnexpectedError({
      at: safeTimestamp(boundary.at),
      correlationId,
      area: boundary.area,
      category: boundary.category ?? 'unexpected',
    });
  } catch {
    // Diagnostics must never replace the stable public boundary error.
  }

  const definition = ERROR_DEFINITIONS.SB_INTERNAL;
  return Object.freeze({
    code: 'SB_INTERNAL',
    message: definition.message,
    retryable: definition.retryable,
    correlationId,
  });
}

function copyFieldError(error: FieldError): FieldError {
  const reason = Object.values(FIELD_ERROR_MESSAGES).includes(
    error.message as (typeof FIELD_ERROR_MESSAGES)[FieldErrorReason],
  )
    ? error.message
    : FIELD_ERROR_MESSAGES.invalid_value;
  return Object.freeze({
    path: SAFE_FIELD_PATH.test(error.path) ? error.path : 'input',
    message: reason,
  });
}

function safeCorrelationId(generator: CorrelationIdGenerator): string {
  try {
    const candidate = generator.nextCorrelationId();
    return SAFE_CORRELATION_ID.test(candidate) ? candidate : INVALID_CORRELATION_ID;
  } catch {
    return INVALID_CORRELATION_ID;
  }
}

function safeTimestamp(value: string): string {
  if (!ISO_UTC_TIMESTAMP.test(value)) {
    return INVALID_DIAGNOSTIC_TIMESTAMP;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : INVALID_DIAGNOSTIC_TIMESTAMP;
}
