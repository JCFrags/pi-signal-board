import type { Clock } from '../domain/clock.js';
import { utcNow } from '../domain/clock.js';
import { fail, type Result, signalBoardError, succeed } from '../domain/errors.js';
import type { BoardViewedEvent } from '../domain/events.js';
import type { EventId, IdGenerator, UiCommandId } from '../domain/ids.js';
import { isFiniteUtcTimestamp } from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { selectCatchUp } from '../domain/selectors.js';
import type { BoardState } from '../domain/types.js';
import type { MutationQueue } from './mutation-queue.js';

export interface MarkBoardViewedCommand {
  readonly cutoffAt: string;
}

export interface BoardViewCheckpointResult {
  readonly cutoffAt: string;
  readonly event?: BoardViewedEvent;
  readonly noOp: boolean;
}

export interface BoardViewCheckpointServiceDependencies {
  readonly queue: MutationQueue;
  readonly readState: () => BoardState;
  readonly swapState: (state: BoardState) => void;
  readonly append: (event: BoardViewedEvent) => Promise<Result<void>>;
  readonly refresh: (state: BoardState) => void | Promise<void>;
  readonly afterMutation?: () => void | Promise<void>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'command' | 'event'>;
}

interface CheckpointReservation {
  commandId?: UiCommandId;
  eventId?: EventId;
}

/** Persist the fixed board-open cutoff only when it acknowledges a semantic visible change. */
export class BoardViewCheckpointService {
  readonly #dependencies: BoardViewCheckpointServiceDependencies;
  readonly #reservations = new Map<string, CheckpointReservation>();

  constructor(dependencies: BoardViewCheckpointServiceDependencies) {
    this.#dependencies = dependencies;
  }

  markViewed(command: MarkBoardViewedCommand): Promise<Result<BoardViewCheckpointResult>> {
    return this.#dependencies.queue.run(() => this.markViewedLocked(command));
  }

  /** Use this method only while the caller owns the shared runtime queue. */
  async markViewedLocked(
    command: MarkBoardViewedCommand,
  ): Promise<Result<BoardViewCheckpointResult>> {
    if (!isFiniteUtcTimestamp(command.cutoffAt)) {
      return fail(signalBoardError('SB_INVALID_ARGUMENT'));
    }

    const state = this.#dependencies.readState();
    if (
      (state.lastViewedAt !== undefined && command.cutoffAt <= state.lastViewedAt) ||
      selectCatchUp(state, command.cutoffAt).items.length === 0
    ) {
      return succeed(freezeResult({ cutoffAt: command.cutoffAt, noOp: true }));
    }

    let occurredAt: string;
    try {
      occurredAt = utcNow(this.#dependencies.clock);
    } catch {
      return fail(internalError());
    }
    if (command.cutoffAt > occurredAt) return fail(signalBoardError('SB_STATE_CONFLICT'));

    const reservation = this.#reservations.get(command.cutoffAt) ?? {};
    this.#reservations.set(command.cutoffAt, reservation);
    try {
      reservation.commandId ??= this.#dependencies.ids.command();
      reservation.eventId ??= this.#dependencies.ids.event();
    } catch {
      return fail(internalError());
    }

    const event: BoardViewedEvent = freezeResult({
      schemaVersion: 1,
      eventId: reservation.eventId,
      eventType: 'board.viewed',
      occurredAt,
      actor: 'user',
      commandId: reservation.commandId,
      payload: { cutoffAt: command.cutoffAt },
    });
    const reduced = reduceBoardEvent(state, event);
    if (!reduced.ok) return fail(signalBoardError(reduced.code));
    if (reduced.idempotent) {
      this.#reservations.delete(command.cutoffAt);
      return succeed(freezeResult({ cutoffAt: command.cutoffAt, event, noOp: true }));
    }

    let appended: Result<void>;
    try {
      appended = await this.#dependencies.append(event);
    } catch {
      appended = fail(signalBoardError('SB_PERSISTENCE_FAILED'));
    }
    if (!appended.ok) return appended;

    this.#dependencies.swapState(reduced.state);
    await this.#dependencies.afterMutation?.();
    this.#reservations.delete(command.cutoffAt);
    try {
      await this.#dependencies.refresh(reduced.state);
    } catch {
      return fail(signalBoardError('SB_UI_UNAVAILABLE'));
    }

    return succeed(freezeResult({ cutoffAt: command.cutoffAt, event, noOp: false }));
  }
}

function internalError() {
  return Object.freeze({
    code: 'SB_INTERNAL' as const,
    message: 'Agent Board encountered an unexpected internal error.',
    retryable: true,
  });
}

function freezeResult<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeResult(item))) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = freezeResult(child);
  return Object.freeze(copy) as T;
}
