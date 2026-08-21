import type { EffectiveConfig } from '../config/types.js';
import { normalizeAttachments } from '../domain/attachments.js';
import type { Clock } from '../domain/clock.js';
import { utcNow } from '../domain/clock.js';
import {
  ERROR_DEFINITIONS,
  fail,
  fieldError,
  type Result,
  signalBoardError,
  succeed,
} from '../domain/errors.js';
import type { AnswerAcknowledgedEvent } from '../domain/events.js';
import type {
  AnswerId,
  EventId,
  IdGenerator,
  QuestionId,
  ToolCommandId,
  UpdateId,
} from '../domain/ids.js';
import { isAnswerId, isCommandId, isUpdateId } from '../domain/ids.js';
import { sameSemanticValue } from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
import type { AckOutcome, AnswerAcknowledgement, Attachment, BoardState } from '../domain/types.js';
import type { TurnAcknowledgementRateCounter } from './acknowledgement-rate-counter.js';
import type { MutationQueue } from './mutation-queue.js';

const OUTCOMES = new Set<AckOutcome>([
  'applied',
  'partially_applied',
  'cannot_apply',
  'duplicate',
  'superseded',
]);
const MAX_ID_ATTEMPTS = 128;

export interface AcknowledgeAnswerCommand {
  readonly commandId: ToolCommandId;
  readonly answerId: AnswerId;
  readonly outcome: AckOutcome;
  readonly summary: string;
  readonly resultingUpdateIds?: readonly UpdateId[];
  readonly attachments?: readonly Attachment[];
}

export interface AcknowledgementMutationResult {
  readonly acknowledgement: AnswerAcknowledgement;
  readonly event: AnswerAcknowledgedEvent;
  readonly noOp: boolean;
}

export interface AcknowledgementServiceDependencies {
  readonly queue: MutationQueue;
  readonly readState: () => BoardState;
  readonly swapState: (state: BoardState) => void;
  readonly append: (event: AnswerAcknowledgedEvent) => Promise<Result<void>>;
  readonly refresh: (state: BoardState) => void | Promise<void>;
  readonly afterMutationLocked?: () => void | Promise<void>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'event'>;
  readonly cwd: string;
  readonly config: Pick<EffectiveConfig, 'limits'>;
  readonly rateCounter: TurnAcknowledgementRateCounter;
}

/** Persist one agent acknowledgement. The immutable answer ID is the deduplication key. */
export class AcknowledgementService {
  readonly #dependencies: AcknowledgementServiceDependencies;

  constructor(dependencies: AcknowledgementServiceDependencies) {
    this.#dependencies = dependencies;
  }

  acknowledge(command: AcknowledgeAnswerCommand): Promise<Result<AcknowledgementMutationResult>> {
    return this.#dependencies.queue.run(() => this.acknowledgeLocked(command));
  }

  /** Use only while the shared runtime mutation queue is already held. */
  async acknowledgeLocked(
    command: AcknowledgeAnswerCommand,
  ): Promise<Result<AcknowledgementMutationResult>> {
    const normalized = this.#normalize(command);
    if (!normalized.ok) return normalized;

    const state = this.#dependencies.readState();
    const answer = state.answers.get(normalized.value.answerId);
    if (answer === undefined) return fail(signalBoardError('SB_NOT_FOUND'));

    const semantic = {
      answerId: answer.id,
      questionId: answer.questionId,
      outcome: normalized.value.outcome,
      summary: normalized.value.summary,
      resultingUpdateIds: normalized.value.resultingUpdateIds,
      attachments: normalized.value.attachments,
    };
    const priorByCommand = state.commandResults.get(normalized.value.commandId);
    if (priorByCommand !== undefined) {
      const priorAcknowledgement =
        priorByCommand.eventType === 'answer.acknowledged'
          ? (priorByCommand.semanticPayload as AnswerAcknowledgedEvent['payload']).acknowledgement
          : undefined;
      if (
        priorAcknowledgement === undefined ||
        !sameSemanticValue(acknowledgementSemantic(priorAcknowledgement), semantic)
      ) {
        return fail(signalBoardError('SB_STATE_CONFLICT'));
      }
      return this.#priorResult(state, priorByCommand.eventId, normalized.value.commandId, semantic);
    }

    const existing = state.acknowledgements.get(answer.id);
    if (existing !== undefined) {
      if (!sameSemanticValue(acknowledgementSemantic(existing), semantic)) {
        return fail(signalBoardError('SB_STATE_CONFLICT'));
      }
      const event = eventForExisting(existing);
      return succeed(frozenResult(existing, event, true));
    }

    if (answer.deliveryStatus !== 'queued' || answer.deliveryAttempts.length === 0) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    const rate = this.#dependencies.rateCounter.check(
      this.#dependencies.config.limits.maxAcknowledgementsPerTurn,
    );
    if (!rate.ok) return rate;

    let occurredAt: string;
    let eventId: EventId;
    try {
      occurredAt = utcNow(this.#dependencies.clock);
      eventId = allocateEventId(this.#dependencies.ids, state);
    } catch {
      return fail(internalError());
    }

    const event: AnswerAcknowledgedEvent = freezeCopy({
      schemaVersion: 1,
      eventId,
      eventType: 'answer.acknowledged',
      occurredAt,
      actor: 'agent',
      commandId: normalized.value.commandId,
      payload: {
        acknowledgement: {
          ...semantic,
          acknowledgedAt: occurredAt,
        },
      },
    });
    const reduced = reduceBoardEvent(state, event);
    if (!reduced.ok || reduced.idempotent) {
      return fail(signalBoardError(reduced.ok ? 'SB_STATE_CONFLICT' : reduced.code));
    }

    let appended: Result<void>;
    try {
      appended = await this.#dependencies.append(event);
    } catch {
      return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
    }
    if (!appended.ok) return appended;

    this.#dependencies.swapState(reduced.state);
    this.#dependencies.rateCounter.commit();
    const acknowledgement = reduced.state.acknowledgements.get(answer.id);
    if (acknowledgement === undefined) return fail(internalError());

    let refreshFailed = false;
    try {
      await this.#dependencies.refresh(reduced.state);
    } catch {
      refreshFailed = true;
    }
    try {
      await this.#dependencies.afterMutationLocked?.();
    } catch {
      // The acknowledgement is durable. Lifecycle diagnostics own this failure.
    }
    return refreshFailed
      ? fail(signalBoardError('SB_UI_UNAVAILABLE'))
      : succeed(frozenResult(acknowledgement, event, false));
  }

  #normalize(command: AcknowledgeAnswerCommand): Result<{
    readonly commandId: ToolCommandId;
    readonly answerId: AnswerId;
    readonly outcome: AckOutcome;
    readonly summary: string;
    readonly resultingUpdateIds: readonly UpdateId[];
    readonly attachments: readonly Attachment[];
  }> {
    if (!isCommandId(command.commandId) || !command.commandId.startsWith('tool:')) {
      return invalid('commandId', 'invalid_value');
    }
    if (!isAnswerId(command.answerId)) return invalid('answerId', 'invalid_value');
    if (!OUTCOMES.has(command.outcome)) return invalid('outcome', 'unsupported');
    if (typeof command.summary !== 'string') return invalid('summary', 'invalid_type');
    const summary = sanitizeText(command.summary, TEXT_FIELD_POLICIES.acknowledgementSummary);
    if (!summary.ok) {
      return invalid(
        'summary',
        summary.reason === 'empty'
          ? 'required'
          : summary.reason === 'too_long'
            ? 'too_long'
            : 'invalid_value',
      );
    }

    const resultingUpdateIds = command.resultingUpdateIds ?? [];
    if (!Array.isArray(resultingUpdateIds)) return invalid('resultingUpdateIds', 'invalid_type');
    if (resultingUpdateIds.length > 20) return invalid('resultingUpdateIds', 'too_many');
    if (new Set(resultingUpdateIds).size !== resultingUpdateIds.length) {
      return invalid('resultingUpdateIds', 'duplicate');
    }
    const state = this.#dependencies.readState();
    for (let index = 0; index < resultingUpdateIds.length; index += 1) {
      const id = resultingUpdateIds[index];
      if (typeof id !== 'string' || !isUpdateId(id)) {
        return invalid(`resultingUpdateIds[${index}]`, 'invalid_value');
      }
      if (!state.updates.has(id)) return fail(signalBoardError('SB_NOT_FOUND'));
    }

    const attachments = normalizeAttachments(command.attachments ?? [], this.#dependencies.cwd);
    if (!attachments.ok) return attachments;
    return succeed(
      freezeCopy({
        commandId: command.commandId,
        answerId: command.answerId,
        outcome: command.outcome,
        summary: summary.value,
        resultingUpdateIds,
        attachments: attachments.value,
      }),
    );
  }

  #priorResult(
    state: BoardState,
    eventId: EventId,
    commandId: ToolCommandId,
    semantic: Omit<
      AnswerAcknowledgement,
      'eventId' | 'commandId' | 'decisionDisplayId' | 'acknowledgedAt'
    >,
  ): Result<AcknowledgementMutationResult> {
    const acknowledgement = state.acknowledgements.get(semantic.answerId);
    if (acknowledgement === undefined) return fail(signalBoardError('SB_STATE_CONFLICT'));
    const event = freezeCopy<AnswerAcknowledgedEvent>({
      schemaVersion: 1,
      eventId,
      eventType: 'answer.acknowledged',
      occurredAt: acknowledgement.acknowledgedAt,
      actor: 'agent',
      commandId,
      payload: { acknowledgement: { ...semantic, acknowledgedAt: acknowledgement.acknowledgedAt } },
    });
    return succeed(frozenResult(acknowledgement, event, true));
  }
}

function acknowledgementSemantic(value: {
  readonly answerId: AnswerId;
  readonly questionId: QuestionId;
  readonly outcome: AckOutcome;
  readonly summary: string;
  readonly resultingUpdateIds: readonly UpdateId[];
  readonly attachments: readonly Attachment[];
}) {
  return {
    answerId: value.answerId,
    questionId: value.questionId,
    outcome: value.outcome,
    summary: value.summary,
    resultingUpdateIds: value.resultingUpdateIds,
    attachments: value.attachments,
  };
}

function eventForExisting(value: AnswerAcknowledgement): AnswerAcknowledgedEvent {
  return freezeCopy({
    schemaVersion: 1,
    eventId: value.eventId,
    eventType: 'answer.acknowledged',
    occurredAt: value.acknowledgedAt,
    actor: 'agent',
    commandId: value.commandId,
    payload: {
      acknowledgement: {
        ...acknowledgementSemantic(value),
        acknowledgedAt: value.acknowledgedAt,
      },
    },
  });
}

function allocateEventId(ids: Pick<IdGenerator, 'event'>, state: BoardState): EventId {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = ids.event();
    if (!state.acceptedEventIds.has(id)) return id;
  }
  throw new Error('Event ID collision limit reached.');
}

function frozenResult(
  acknowledgement: AnswerAcknowledgement,
  event: AnswerAcknowledgedEvent,
  noOp: boolean,
): AcknowledgementMutationResult {
  return freezeCopy({ acknowledgement, event, noOp });
}

function invalid<T>(
  path: string,
  reason:
    | 'required'
    | 'invalid_type'
    | 'invalid_value'
    | 'too_long'
    | 'too_many'
    | 'duplicate'
    | 'unsupported',
): Result<T> {
  return fail(signalBoardError('SB_INVALID_ARGUMENT', [fieldError(path, reason)]));
}

function internalError() {
  return Object.freeze({
    code: 'SB_INTERNAL' as const,
    message: ERROR_DEFINITIONS.SB_INTERNAL.message,
    retryable: ERROR_DEFINITIONS.SB_INTERNAL.retryable,
  });
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
