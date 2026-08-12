import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { EVENT_CUSTOM_TYPE } from '../constants.js';
import {
  type CorrelationIdGenerator,
  ERROR_DEFINITIONS,
  fail,
  type Result,
  succeed,
  type UnexpectedErrorDiagnosticSink,
} from '../domain/errors.js';
import type { BoardEvent } from '../domain/events.js';

export interface PiAppendEntryPort {
  appendEntry(customType: string, data?: unknown): void;
}

export interface PiSessionStoreBoundary {
  readonly correlationIds: CorrelationIdGenerator;
  readonly at: () => string;
  readonly diagnostics?: UnexpectedErrorDiagnosticSink;
}

const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FALLBACK_CORRELATION_ID = 'sb-persistence-correlation-unavailable';
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Narrow persistence adapter. Pi owns entry ordering and session storage. */
export class PiSessionStore {
  readonly #pi: PiAppendEntryPort;
  readonly #boundary: PiSessionStoreBoundary;

  constructor(pi: PiAppendEntryPort, boundary: PiSessionStoreBoundary) {
    this.#pi = pi;
    this.#boundary = boundary;
  }

  /** Append exactly one complete board event. A non-throwing Pi call is success. */
  async append(event: BoardEvent): Promise<Result<void>> {
    try {
      this.#pi.appendEntry(EVENT_CUSTOM_TYPE, event);
      return succeed(undefined);
    } catch {
      const correlationId = this.#safeCorrelationId();
      const at = this.#safeTimestamp();
      try {
        this.#boundary.diagnostics?.recordUnexpectedError({
          at,
          correlationId,
          area: 'persistence',
          category: 'host_rejected',
        });
      } catch {
        // Diagnostics must not replace the stable persistence error.
      }
      const definition = ERROR_DEFINITIONS.SB_PERSISTENCE_FAILED;
      return fail(
        Object.freeze({
          code: 'SB_PERSISTENCE_FAILED',
          message: definition.message,
          retryable: definition.retryable,
          correlationId,
        }),
      );
    }
  }

  #safeCorrelationId(): string {
    try {
      const value = this.#boundary.correlationIds.nextCorrelationId();
      return SAFE_CORRELATION_ID.test(value) ? value : FALLBACK_CORRELATION_ID;
    } catch {
      return FALLBACK_CORRELATION_ID;
    }
  }

  #safeTimestamp(): string {
    try {
      const value = this.#boundary.at();
      return SAFE_TIMESTAMP.test(value) && new Date(value).toISOString() === value
        ? value
        : FALLBACK_TIMESTAMP;
    } catch {
      return FALLBACK_TIMESTAMP;
    }
  }
}

/** Construct the store from only the Pi API member that it is allowed to use. */
export function createPiSessionStore(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  boundary: PiSessionStoreBoundary,
): PiSessionStore {
  return new PiSessionStore(pi, boundary);
}
