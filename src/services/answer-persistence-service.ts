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
import type { QuestionAnsweredEvent } from '../domain/events.js';
import type { AnswerId, EventId, IdGenerator, QuestionId, UiCommandId } from '../domain/ids.js';
import { isCommandId, isQuestionId } from '../domain/ids.js';
import {
  answerMatchesRecommendation,
  sameSemanticValue,
  validAnswerValue,
} from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
import type {
  AnswerRecord,
  AnswerSource,
  AnswerValue,
  BoardState,
  DeliveryMode,
  OptionId,
  QuestionItem,
} from '../domain/types.js';
import type { MutationQueue } from './mutation-queue.js';

const MAX_ID_ATTEMPTS = 128;

export interface PersistAnswerCommand {
  readonly commandId: UiCommandId;
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly source: AnswerSource;
  readonly value: AnswerValue;
}

export interface RecordedAnswerDelivery {
  readonly answerId: AnswerId;
  readonly questionId: QuestionId;
  readonly questionRevision: number;
  readonly value: AnswerValue;
  readonly source: AnswerSource;
  readonly status: 'recorded';
  readonly mode: DeliveryMode;
}

export interface AnswerPersistenceResult {
  /** Current immutable answer projection. */
  readonly answer: AnswerRecord;
  /** Exact accepted event. A duplicate-safe retry returns the original event. */
  readonly event: QuestionAnsweredEvent;
  /** Data required by the later delivery boundary. */
  readonly delivery: RecordedAnswerDelivery;
  readonly noOp: boolean;
}

export interface AnswerPersistenceDependencies {
  readonly queue: MutationQueue;
  readonly readState: () => BoardState;
  readonly swapState: (state: BoardState) => void;
  readonly append: (event: QuestionAnsweredEvent) => Promise<Result<void>>;
  readonly refresh: (state: BoardState) => void | Promise<void>;
  readonly afterMutationLocked?: () => void | Promise<void>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'answer' | 'event'>;
}

/** Persist one validated answer before any later delivery operation can start. */
export class AnswerPersistenceService {
  readonly #dependencies: AnswerPersistenceDependencies;

  constructor(dependencies: AnswerPersistenceDependencies) {
    this.#dependencies = dependencies;
  }

  answerQuestion(command: PersistAnswerCommand): Promise<Result<AnswerPersistenceResult>> {
    return this.#dependencies.queue.run(() => this.answerQuestionLocked(command));
  }

  /** Use only while the shared runtime mutation queue is already held. */
  async answerQuestionLocked(
    command: PersistAnswerCommand,
  ): Promise<Result<AnswerPersistenceResult>> {
    const basic = validateCommand(command);
    if (!basic.ok) return basic;

    const state = this.#dependencies.readState();
    const question = state.questions.get(command.questionId);
    if (question === undefined) return fail(signalBoardError('SB_NOT_FOUND'));
    if (command.expectedRevision !== question.revision) {
      return fail(signalBoardError('SB_REVISION_MISMATCH'));
    }

    const normalized = normalizeAnswerValue(command.value, question);
    if (!normalized.ok) return normalized;
    if (
      command.source === 'recommendation' &&
      !answerMatchesRecommendation(normalized.value, question)
    ) {
      return invalid('value', 'invalid_value');
    }

    const priorByCommand = state.commandResults.get(command.commandId);
    if (priorByCommand !== undefined) {
      return this.#resolvePriorCommand(state, command, normalized.value, priorByCommand);
    }

    if (question.answerId !== undefined) {
      return this.#resolveExistingAnswer(state, question, command, normalized.value);
    }
    if (!isAnswerable(question)) return fail(signalBoardError('SB_STATE_CONFLICT'));

    let answeredAt: string;
    let answerId: AnswerId;
    let eventId: EventId;
    try {
      answeredAt = utcNow(this.#dependencies.clock);
      answerId = allocateAnswerId(this.#dependencies.ids, state);
      eventId = allocateEventId(this.#dependencies.ids, state);
    } catch {
      return fail(internalError());
    }

    const event = freezeCopy<QuestionAnsweredEvent>({
      schemaVersion: 1,
      eventId,
      eventType: 'question.answered',
      occurredAt: answeredAt,
      actor: 'user',
      commandId: command.commandId,
      payload: {
        questionId: question.id,
        expectedRevision: command.expectedRevision,
        answer: {
          id: answerId,
          questionId: question.id,
          questionDisplayId: question.displayId,
          questionRevision: question.revision,
          source: command.source,
          value: normalized.value,
          answeredAt,
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
    const answer = reduced.state.answers.get(answerId);
    if (answer === undefined) return fail(internalError());
    const result = resultFor(answer, event, false, question.deliveryMode);

    let refreshFailed = false;
    try {
      await this.#dependencies.refresh(reduced.state);
    } catch {
      refreshFailed = true;
    }
    try {
      await this.#dependencies.afterMutationLocked?.();
    } catch {
      // The accepted answer remains durable. Lifecycle diagnostics own this failure.
    }
    return refreshFailed ? fail(signalBoardError('SB_UI_UNAVAILABLE')) : succeed(result);
  }

  #resolvePriorCommand(
    state: BoardState,
    command: PersistAnswerCommand,
    value: AnswerValue,
    prior: BoardState['commandResults'] extends ReadonlyMap<unknown, infer Value> ? Value : never,
  ): Result<AnswerPersistenceResult> {
    if (prior.eventType !== 'question.answered') return fail(signalBoardError('SB_STATE_CONFLICT'));
    const payload = prior.semanticPayload as QuestionAnsweredEvent['payload'];
    if (
      payload.questionId !== command.questionId ||
      payload.expectedRevision !== command.expectedRevision ||
      payload.answer.source !== command.source ||
      !sameSemanticValue(payload.answer.value, value)
    ) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    const answer = state.answers.get(payload.answer.id);
    const question = state.questions.get(payload.questionId);
    if (answer === undefined || question === undefined) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    return succeed(
      resultFor(
        answer,
        eventFromPrior(command.commandId, prior.eventId, payload),
        true,
        question.deliveryMode,
      ),
    );
  }

  #resolveExistingAnswer(
    state: BoardState,
    question: QuestionItem,
    command: PersistAnswerCommand,
    value: AnswerValue,
  ): Result<AnswerPersistenceResult> {
    const answer = state.answers.get(question.answerId as AnswerId);
    if (
      answer === undefined ||
      answer.questionRevision !== command.expectedRevision ||
      answer.source !== command.source ||
      !sameSemanticValue(answer.value, value)
    ) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    const original = findAnswerEvent(state, answer);
    if (original === undefined) return fail(signalBoardError('SB_STATE_CONFLICT'));
    return succeed(resultFor(answer, original, true, question.deliveryMode));
  }
}

function validateCommand(command: PersistAnswerCommand): Result<void> {
  if (!isCommandId(command.commandId) || !command.commandId.startsWith('ui:')) {
    return invalid('commandId', 'invalid_value');
  }
  if (!isQuestionId(command.questionId)) return invalid('questionId', 'invalid_value');
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
    return invalid('expectedRevision', 'out_of_range');
  }
  if (command.source !== 'manual' && command.source !== 'recommendation') {
    return invalid('source', 'unsupported');
  }
  return succeed(undefined);
}

function normalizeAnswerValue(value: unknown, question: QuestionItem): Result<AnswerValue> {
  if (!isRecord(value) || value.kind !== question.response.kind) {
    return invalid('value.kind', 'invalid_value');
  }
  let normalized: AnswerValue;
  switch (value.kind) {
    case 'single': {
      if (!exact(value, ['kind', 'optionId']) || typeof value.optionId !== 'string') {
        return invalid('value.optionId', 'invalid_value');
      }
      normalized = { kind: 'single', optionId: value.optionId as OptionId };
      break;
    }
    case 'multiple': {
      if (!exact(value, ['kind', 'optionIds'])) return invalid('value', 'invalid_value');
      const ids = normalizeOptionIds(value.optionIds, question, true);
      if (!ids.ok || ids.value.length === 0) return invalid('value.optionIds', 'invalid_value');
      normalized = { kind: 'multiple', optionIds: ids.value as [OptionId, ...OptionId[]] };
      break;
    }
    case 'text': {
      if (!exact(value, ['kind', 'text'])) return invalid('value', 'invalid_value');
      const text = normalizeText(value.text);
      if (!text.ok) return text;
      normalized = { kind: 'text', text: text.value };
      break;
    }
    case 'single_or_text': {
      if (!exact(value, ['kind'], ['optionId', 'text'])) return invalid('value', 'invalid_value');
      const optionId = value.optionId;
      if (optionId !== undefined && typeof optionId !== 'string') {
        return invalid('value.optionId', 'invalid_value');
      }
      const text =
        value.text === undefined
          ? succeed<string | undefined>(undefined)
          : normalizeText(value.text);
      if (!text.ok) return text;
      if (optionId === undefined && text.value === undefined) return invalid('value', 'required');
      normalized = {
        kind: 'single_or_text',
        ...(optionId === undefined ? {} : { optionId: optionId as OptionId }),
        ...(text.value === undefined ? {} : { text: text.value }),
      } as AnswerValue;
      break;
    }
    case 'multiple_or_text': {
      if (!exact(value, ['kind', 'optionIds'], ['text'])) return invalid('value', 'invalid_value');
      const ids = normalizeOptionIds(value.optionIds, question, false);
      if (!ids.ok) return ids;
      const text =
        value.text === undefined
          ? succeed<string | undefined>(undefined)
          : normalizeText(value.text);
      if (!text.ok) return text;
      if (ids.value.length === 0 && text.value === undefined) return invalid('value', 'required');
      normalized = {
        kind: 'multiple_or_text',
        optionIds: ids.value,
        ...(text.value === undefined ? {} : { text: text.value }),
      } as AnswerValue;
      break;
    }
    default:
      return invalid('value.kind', 'unsupported');
  }
  return validAnswerValue(normalized, question)
    ? succeed(freezeCopy(normalized))
    : invalid('value', 'invalid_value');
}

function normalizeOptionIds(
  input: unknown,
  question: QuestionItem,
  requireOne: boolean,
): Result<readonly OptionId[]> {
  if (!Array.isArray(input) || (requireOne && input.length === 0) || input.length > 8) {
    return invalid('value.optionIds', 'invalid_value');
  }
  if (input.some((id) => typeof id !== 'string') || new Set(input).size !== input.length) {
    return invalid('value.optionIds', 'invalid_value');
  }
  const supplied = new Set(input as string[]);
  const options = question.response.options ?? [];
  if ([...supplied].some((id) => !options.some((option) => option.id === id))) {
    return invalid('value.optionIds', 'invalid_value');
  }
  return succeed(
    Object.freeze(options.filter((option) => supplied.has(option.id)).map((option) => option.id)),
  );
}

function normalizeText(input: unknown): Result<string> {
  if (typeof input !== 'string') return invalid('value.text', 'invalid_type');
  const normalized = sanitizeText(input, TEXT_FIELD_POLICIES.answerText);
  if (!normalized.ok) {
    return invalid(
      'value.text',
      normalized.reason === 'empty'
        ? 'required'
        : normalized.reason === 'too_long'
          ? 'too_long'
          : 'invalid_value',
    );
  }
  return succeed(normalized.value);
}

function allocateAnswerId(ids: Pick<IdGenerator, 'answer'>, state: BoardState): AnswerId {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = ids.answer();
    if (!state.answers.has(id)) return id;
  }
  throw new Error('Answer ID collision limit reached.');
}

function allocateEventId(ids: Pick<IdGenerator, 'event'>, state: BoardState): EventId {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = ids.event();
    if (!state.acceptedEventIds.has(id)) return id;
  }
  throw new Error('Event ID collision limit reached.');
}

function findAnswerEvent(
  state: BoardState,
  answer: AnswerRecord,
): QuestionAnsweredEvent | undefined {
  for (const [commandId, result] of state.commandResults) {
    if (result.eventType !== 'question.answered' || result.eventId !== answer.lastEventId) continue;
    const payload = result.semanticPayload as QuestionAnsweredEvent['payload'];
    if (payload.answer.id === answer.id)
      return eventFromPrior(commandId as UiCommandId, result.eventId, payload);
  }
  return undefined;
}

function eventFromPrior(
  commandId: UiCommandId,
  eventId: EventId,
  payload: QuestionAnsweredEvent['payload'],
): QuestionAnsweredEvent {
  return freezeCopy({
    schemaVersion: 1,
    eventId,
    eventType: 'question.answered',
    occurredAt: payload.answer.answeredAt,
    actor: 'user',
    commandId,
    payload,
  });
}

function resultFor(
  answer: AnswerRecord,
  event: QuestionAnsweredEvent,
  noOp: boolean,
  mode: DeliveryMode,
): AnswerPersistenceResult {
  return freezeCopy({
    answer,
    event,
    delivery: {
      answerId: answer.id,
      questionId: answer.questionId,
      questionRevision: answer.questionRevision,
      value: answer.value,
      source: answer.source,
      status: 'recorded',
      mode,
    },
    noOp,
  });
}

function isAnswerable(question: QuestionItem): boolean {
  return (
    (question.status === 'pending' || question.status === 'blocking') &&
    question.answerId === undefined
  );
}

function invalid<T>(
  path: string,
  reason:
    | 'required'
    | 'invalid_type'
    | 'invalid_value'
    | 'out_of_range'
    | 'too_long'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
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
