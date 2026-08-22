import type { EffectiveConfig } from '../config/types.js';
import type { Clock } from '../domain/clock.js';
import { utcNow } from '../domain/clock.js';
import { fail, type Result, signalBoardError, succeed } from '../domain/errors.js';
import type { QuestionEscalatedEvent } from '../domain/events.js';
import type { EventId, IdGenerator, SystemCommandId } from '../domain/ids.js';
import { displaySequence } from '../domain/ids.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import type { BoardState, QuestionItem } from '../domain/types.js';
import type { MutationQueue } from './mutation-queue.js';

export interface QuestionEscalationResult {
  readonly events: readonly QuestionEscalatedEvent[];
}

export interface QuestionEscalationDependencies {
  readonly queue: MutationQueue;
  readonly readState: () => BoardState;
  readonly swapState: (state: BoardState) => void;
  readonly append: (event: QuestionEscalatedEvent) => Promise<Result<void>>;
  readonly refresh: (state: BoardState) => void | Promise<void>;
  readonly afterMutation?: () => void | Promise<void>;
  readonly notify: (message: string, severity: 'warning') => void | Promise<void>;
  readonly recordPostDurableFailure?: (area: 'notification' | 'ui', at: string) => void;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'event'>;
  readonly config: Pick<EffectiveConfig, 'notifications'>;
}

/** Durable pending-to-blocking transitions owned by the agent-settled lifecycle hook. */
export class QuestionEscalationService {
  readonly #dependencies: QuestionEscalationDependencies;
  readonly #reservedEventIds = new Map<SystemCommandId, EventId>();

  constructor(dependencies: QuestionEscalationDependencies) {
    this.#dependencies = dependencies;
  }

  /** Enter the shared queue for callers that do not already hold the lifecycle lock. */
  escalateConditionalQuestions(): Promise<Result<QuestionEscalationResult>> {
    return this.#dependencies.queue.run(async () => {
      let now: string;
      try {
        now = utcNow(this.#dependencies.clock);
      } catch {
        return fail(internalError());
      }
      return this.escalateConditionalQuestionsLocked(now);
    });
  }

  /** Run while the caller holds the shared mutation queue. */
  async escalateConditionalQuestionsLocked(now: string): Promise<Result<QuestionEscalationResult>> {
    if (!isCanonicalTimestamp(now)) return fail(internalError());
    try {
      return await this.#escalateLocked(now);
    } catch {
      return fail(internalError());
    }
  }

  async #escalateLocked(now: string): Promise<Result<QuestionEscalationResult>> {
    const candidates = [...this.#dependencies.readState().questions.values()]
      .filter(isEligible)
      .sort(compareQuestions)
      .map((question) => question.id);
    const accepted: QuestionEscalatedEvent[] = [];

    for (const questionId of candidates) {
      const state = this.#dependencies.readState();
      const current = state.questions.get(questionId);
      if (current === undefined || !isEligible(current)) continue;

      const commandId = `system:escalate:${current.id}:${current.revision}` as SystemCommandId;
      let eventId: EventId;
      try {
        eventId = this.#reservedEventIds.get(commandId) ?? this.#dependencies.ids.event();
        this.#reservedEventIds.set(commandId, eventId);
      } catch {
        return fail(internalError());
      }

      const event: QuestionEscalatedEvent = Object.freeze({
        schemaVersion: 1,
        eventId,
        eventType: 'question.escalated',
        occurredAt: now,
        actor: 'system',
        commandId,
        payload: Object.freeze({
          questionId: current.id,
          expectedRevision: current.revision,
          revision: current.revision + 1,
          escalatedAt: now,
        }),
      });
      const reduced = reduceBoardEvent(state, event);
      if (!reduced.ok) return fail(signalBoardError(reduced.code));
      if (reduced.idempotent) continue;

      let appended: Result<void>;
      try {
        appended = await this.#dependencies.append(event);
      } catch {
        return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      }
      if (!appended.ok) return appended;

      this.#dependencies.swapState(reduced.state);
      await this.#dependencies.afterMutation?.();
      this.#reservedEventIds.delete(commandId);
      accepted.push(event);
      await this.#postDurable(current.displayId, reduced.state, now);
    }

    return succeed(Object.freeze({ events: Object.freeze(accepted) }));
  }

  async #postDurable(displayId: string, state: BoardState, at: string): Promise<void> {
    if (this.#dependencies.config.notifications.questionEscalated) {
      try {
        await this.#dependencies.notify(
          `Agent Board escalated ${displayId} to blocking.`,
          'warning',
        );
      } catch {
        this.#recordPostDurableFailure('notification', at);
      }
    }
    try {
      await this.#dependencies.refresh(state);
    } catch {
      this.#recordPostDurableFailure('ui', at);
    }
  }

  #recordPostDurableFailure(area: 'notification' | 'ui', at: string): void {
    try {
      this.#dependencies.recordPostDurableFailure?.(area, at);
    } catch {
      // Diagnostics cannot reverse a durable transition.
    }
  }
}

function isEligible(question: QuestionItem): boolean {
  return (
    question.status === 'pending' &&
    question.answerId === undefined &&
    question.blockingPolicy === 'when_agent_settles'
  );
}

function compareQuestions(left: QuestionItem, right: QuestionItem): number {
  const leftSequence = displaySequence(left.displayId) ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = displaySequence(right.displayId) ?? Number.MAX_SAFE_INTEGER;
  return leftSequence - rightSequence || (left.id < right.id ? -1 : 1);
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function internalError() {
  return Object.freeze({
    code: 'SB_INTERNAL' as const,
    message: 'Agent Board encountered an unexpected internal error.',
    retryable: true,
  });
}
