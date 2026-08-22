import type { Clock } from '../domain/clock.js';
import { fail, type Result, signalBoardError } from '../domain/errors.js';
import type { QuestionStaledEvent } from '../domain/events.js';
import type { CommandId, EventId, IdGenerator, QuestionId } from '../domain/ids.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import type { BoardState, QuestionItem } from '../domain/types.js';
import type { MutationQueue } from './mutation-queue.js';

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const EXPIRY_REASON = 'Question expiry elapsed.';

export interface ExpiryTimerAdapter {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  unref?(handle: unknown): void;
}

export interface ExpiryDiagnostic {
  readonly code: 'SB_INTERNAL' | 'SB_PERSISTENCE_FAILED' | 'SB_UI_UNAVAILABLE';
  readonly category: 'unexpected' | 'append_rejected' | 'ui_failure';
}

export interface ExpiryEvaluation {
  readonly evaluatedAt: string;
  readonly transitioned: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ExpiryServiceDependencies {
  readonly queue: MutationQueue;
  readonly readState: () => BoardState;
  readonly swapState: (state: BoardState) => void;
  readonly append: (event: QuestionStaledEvent) => Promise<Result<void>>;
  readonly refresh: (state: BoardState) => void | Promise<void>;
  readonly afterMutation?: () => void | Promise<void>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'event'>;
  readonly timers: ExpiryTimerAdapter;
  readonly recordDiagnostic: (record: ExpiryDiagnostic) => void;
}

interface ExpiryCandidate {
  readonly questionId: QuestionId;
  readonly revision: number;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
}

/** Durable expiry transitions and nearest-expiry timer decisions. */
export class ExpiryService {
  readonly #dependencies: ExpiryServiceDependencies;
  readonly #reservedEventIds = new Map<CommandId, EventId>();
  #timer: unknown | undefined;
  #timerGeneration = 0;

  constructor(dependencies: ExpiryServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Evaluate through the one shared mutation queue. */
  evaluateExpiry(now: Date): Promise<ExpiryEvaluation> {
    return this.#dependencies.queue.run(() => this.evaluateExpiryLocked(now));
  }

  /** Callable boundary for the future board-open command. */
  evaluateBoardOpen(): Promise<ExpiryEvaluation> {
    return this.#dependencies.queue.run(() =>
      this.evaluateExpiryLocked(this.#dependencies.clock.now()),
    );
  }

  /** Evaluate while the caller already owns the shared mutation queue. */
  async evaluateExpiryLocked(now: Date): Promise<ExpiryEvaluation> {
    const evaluatedAt = canonicalTimestamp(now);
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const candidates = expiryCandidates(this.#dependencies.readState(), evaluatedAtMs);
    let transitioned = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const current = this.#dependencies.readState().questions.get(candidate.questionId);
      if (!matchesCandidate(current, candidate, evaluatedAtMs)) {
        skipped += 1;
        continue;
      }
      const commandId = `system:stale:${current.id}:${current.revision}` as CommandId;
      let eventId: EventId;
      try {
        eventId = this.#reservedEventIds.get(commandId) ?? this.#dependencies.ids.event();
        this.#reservedEventIds.set(commandId, eventId);
      } catch {
        failed += 1;
        this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
        continue;
      }
      const event = freezeCopy<QuestionStaledEvent>({
        schemaVersion: 1,
        eventId,
        eventType: 'question.staled',
        occurredAt: evaluatedAt,
        actor: 'system',
        commandId,
        payload: {
          questionId: current.id,
          expectedRevision: current.revision,
          revision: current.revision + 1,
          staleAt: evaluatedAt,
          reason: EXPIRY_REASON,
        },
      });
      const reduced = reduceBoardEvent(this.#dependencies.readState(), event);
      if (!reduced.ok || reduced.idempotent) {
        skipped += 1;
        continue;
      }

      let appended: Result<void>;
      try {
        appended = await this.#dependencies.append(event);
      } catch {
        appended = fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      }
      if (!appended.ok) {
        failed += 1;
        this.#record({ code: 'SB_PERSISTENCE_FAILED', category: 'append_rejected' });
        continue;
      }

      this.#dependencies.swapState(reduced.state);
      await this.#dependencies.afterMutation?.();
      this.#reservedEventIds.delete(commandId);
      transitioned += 1;
      try {
        await this.#dependencies.refresh(reduced.state);
      } catch {
        this.#record({ code: 'SB_UI_UNAVAILABLE', category: 'ui_failure' });
      }
    }

    return Object.freeze({ evaluatedAt, transitioned, skipped, failed });
  }

  /** Arm one timer for the nearest future answerable question. */
  armNearestTimerLocked(callback: () => void | Promise<void>): unknown | undefined {
    this.clearTimerLocked();
    let nowMs: number;
    try {
      nowMs = this.#dependencies.clock.now().getTime();
    } catch {
      this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
      return undefined;
    }
    if (!Number.isFinite(nowMs)) {
      this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
      return undefined;
    }
    const nearest = nearestFutureExpiry(this.#dependencies.readState(), nowMs);
    if (nearest === undefined) return undefined;

    const generation = ++this.#timerGeneration;
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, nearest - nowMs);
    try {
      const handle = this.#dependencies.timers.setTimeout(async () => {
        if (generation !== this.#timerGeneration) return;
        this.#timer = undefined;
        try {
          await callback();
        } catch {
          this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
        }
      }, delayMs);
      this.#timer = handle;
      unrefTimer(this.#dependencies.timers, handle);
      return handle;
    } catch {
      this.#timer = undefined;
      this.#record({ code: 'SB_INTERNAL', category: 'unexpected' });
      return undefined;
    }
  }

  /** Clear timer ownership before replay, replacement, or shutdown. */
  clearTimerLocked(): void {
    this.#timerGeneration += 1;
    const handle = this.#timer;
    this.#timer = undefined;
    if (handle === undefined) return;
    try {
      this.#dependencies.timers.clearTimeout(handle);
    } catch {
      // Cleanup is best-effort. No board content enters diagnostics.
    }
  }

  #record(record: ExpiryDiagnostic): void {
    try {
      this.#dependencies.recordDiagnostic(Object.freeze(record));
    } catch {
      // Diagnostics must not break lifecycle work.
    }
  }
}

function expiryCandidates(state: BoardState, nowMs: number): ExpiryCandidate[] {
  return [...state.questions.values()]
    .filter(isAnswerableWithExpiry)
    .map((question) => ({
      questionId: question.id,
      revision: question.revision,
      expiresAt: question.expiresAt as string,
      expiresAtMs: Date.parse(question.expiresAt as string),
    }))
    .filter((candidate) => Number.isFinite(candidate.expiresAtMs) && candidate.expiresAtMs <= nowMs)
    .sort(
      (left, right) =>
        left.expiresAtMs - right.expiresAtMs ||
        (left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0),
    );
}

function nearestFutureExpiry(state: BoardState, nowMs: number): number | undefined {
  let nearest: number | undefined;
  for (const question of state.questions.values()) {
    if (!isAnswerableWithExpiry(question)) continue;
    const value = Date.parse(question.expiresAt);
    if (!Number.isFinite(value) || value <= nowMs) continue;
    if (nearest === undefined || value < nearest) nearest = value;
  }
  return nearest;
}

function isAnswerableWithExpiry(
  question: QuestionItem,
): question is QuestionItem & { readonly expiresAt: string } {
  return (
    (question.status === 'pending' || question.status === 'blocking') &&
    question.answerId === undefined &&
    question.expiresAt !== undefined
  );
}

function matchesCandidate(
  question: QuestionItem | undefined,
  candidate: ExpiryCandidate,
  nowMs: number,
): question is QuestionItem & { readonly expiresAt: string } {
  return (
    question !== undefined &&
    isAnswerableWithExpiry(question) &&
    question.revision === candidate.revision &&
    question.expiresAt === candidate.expiresAt &&
    Date.parse(question.expiresAt) <= nowMs
  );
}

function canonicalTimestamp(now: Date): string {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('Expiry evaluation requires a valid time.');
  return new Date(timestamp).toISOString();
}

function unrefTimer(timers: ExpiryTimerAdapter, handle: unknown): void {
  try {
    if (timers.unref !== undefined) {
      timers.unref(handle);
      return;
    }
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      const unref = (handle as { readonly unref?: unknown }).unref;
      if (typeof unref === 'function') unref.call(handle);
    }
  } catch {
    // unref is an optional process-liveness optimization.
  }
}

function freezeCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeCopy(item))) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) copy[key] = freezeCopy(child);
  }
  return Object.freeze(copy) as T;
}
