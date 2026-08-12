import {
  fail,
  type Result,
  type SignalBoardError,
  signalBoardError,
  succeed,
} from '../domain/errors.js';
import type { MutationQueue } from './mutation-queue.js';

export interface AppendTransactionPlan<Event, Value> {
  readonly event: Event;
  readonly value: Value;
}

export type TransactionReduceResult<State> =
  | {
      readonly ok: true;
      readonly state: State;
      readonly idempotent: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'SB_INVALID_ARGUMENT'
        | 'SB_NOT_FOUND'
        | 'SB_STATE_CONFLICT'
        | 'SB_REVISION_MISMATCH'
        | 'SB_UNSAFE_QUESTION';
    };

export interface AcceptedTransaction<Event, Value> {
  /** The event accepted by the original command, including on an exact retry. */
  readonly event: Event;
  readonly value: Value;
  readonly idempotent: boolean;
}

export interface LockedAppendTransaction<State, Event, Value> {
  readonly queue: MutationQueue;
  readonly readState: () => State;
  /** Build and validate a complete event without changing runtime state or counters. */
  readonly prepare: (state: State) => Result<AppendTransactionPlan<Event, Value>>;
  /** Perform the pure reducer dry-run that checks idempotency and preconditions. */
  readonly reduce: (state: State, event: Event) => TransactionReduceResult<State>;
  readonly append: (event: Event) => Promise<Result<void>>;
  readonly swapState: (state: State) => void;
  readonly refresh: (state: State) => void | Promise<void>;
  /** Recover the exact prior success. This callback must not append or refresh. */
  readonly resolveIdempotent: (
    state: State,
    proposed: AppendTransactionPlan<Event, Value>,
  ) => Result<{ readonly event: Event; readonly value: Value }>;
  readonly mapAppendThrow?: (cause: unknown) => SignalBoardError;
  readonly mapRefreshThrow: (cause: unknown) => SignalBoardError;
}

/**
 * Append one event before exposing its reduced state.
 *
 * This function owns the queue. Locked callers must use an equivalent internal
 * operation rather than call this function recursively.
 */
export function runLockedAppendTransaction<State, Event, Value>(
  transaction: LockedAppendTransaction<State, Event, Value>,
): Promise<Result<AcceptedTransaction<Event, Value>>> {
  return transaction.queue.run(async () => {
    const current = transaction.readState();
    const prepared = transaction.prepare(current);
    if (!prepared.ok) return prepared;

    const reduced = transaction.reduce(current, prepared.value.event);
    if (!reduced.ok) return fail(signalBoardError(reduced.code));

    if (reduced.idempotent) {
      const prior = transaction.resolveIdempotent(current, prepared.value);
      return prior.ok ? succeed({ ...prior.value, idempotent: true }) : prior;
    }

    let appended: Result<void>;
    try {
      appended = await transaction.append(prepared.value.event);
    } catch (cause) {
      return fail(transaction.mapAppendThrow?.(cause) ?? signalBoardError('SB_PERSISTENCE_FAILED'));
    }
    if (!appended.ok) return appended;

    transaction.swapState(reduced.state);
    try {
      await transaction.refresh(reduced.state);
    } catch (cause) {
      return fail(transaction.mapRefreshThrow(cause));
    }

    return succeed({
      event: prepared.value.event,
      value: prepared.value.value,
      idempotent: false,
    });
  });
}
