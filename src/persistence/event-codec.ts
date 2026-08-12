import type { BoardEvent, BoardEventActor, BoardEventType } from '../domain/events.js';
import { isAnswerId, isCommandId, isEventId, isQuestionId, isUpdateId } from '../domain/ids.js';
import { isFiniteUtcTimestamp } from '../domain/invariants.js';
import {
  TEXT_FIELD_POLICIES,
  type TextPolicy,
  validatePersistedText,
} from '../domain/sanitization.js';

export type DecodeBoardEventErrorCode = 'SB_EVENT_INVALID' | 'SB_EVENT_UNSUPPORTED_VERSION';

export type DecodeBoardEventResult =
  | { readonly ok: true; readonly event: BoardEvent }
  | { readonly ok: false; readonly error: { readonly code: DecodeBoardEventErrorCode } };

const INVALID = Object.freeze({
  ok: false,
  error: Object.freeze({ code: 'SB_EVENT_INVALID' }),
}) satisfies DecodeBoardEventResult;
const UNSUPPORTED = Object.freeze({
  ok: false,
  error: Object.freeze({ code: 'SB_EVENT_UNSUPPORTED_VERSION' }),
}) satisfies DecodeBoardEventResult;

const ACTORS = {
  'update.upserted': ['agent'],
  'update.archived': ['agent', 'user'],
  'question.created': ['agent'],
  'question.revised': ['agent'],
  'question.cancelled': ['agent'],
  'question.escalated': ['system'],
  'question.staled': ['system'],
  'question.dismissed': ['user'],
  'question.answered': ['user'],
  'answer.delivery_queued': ['system'],
  'answer.delivery_failed': ['system'],
  'answer.acknowledged': ['agent'],
  'board.viewed': ['user'],
  'board.reset': ['user'],
} as const satisfies Readonly<Record<BoardEventType, readonly BoardEventActor[]>>;

const UPDATE_DISPLAY_ID = /^U-[1-9][0-9]*$/u;
const QUESTION_DISPLAY_ID = /^Q-[1-9][0-9]*$/u;
const UPDATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type RecordValue = Record<string, unknown>;

/** Decode one schema-v1 event without retaining any caller-owned value. */
export function decodeBoardEvent(input: unknown): DecodeBoardEventResult {
  try {
    if (!isSafeTree(input)) return INVALID;
    if (!isPlainRecord(input)) return INVALID;
    if (input.schemaVersion !== 1) {
      return typeof input.schemaVersion === 'number' ? UNSUPPORTED : INVALID;
    }
    if (
      !exact(input, [
        'schemaVersion',
        'eventId',
        'eventType',
        'occurredAt',
        'actor',
        'commandId',
        'payload',
      ])
    )
      return INVALID;
    if (typeof input.eventType !== 'string' || !hasOwn(ACTORS, input.eventType)) return INVALID;
    const type = input.eventType as BoardEventType;
    if (
      typeof input.eventId !== 'string' ||
      !isEventId(input.eventId) ||
      typeof input.occurredAt !== 'string' ||
      !isFiniteUtcTimestamp(input.occurredAt) ||
      typeof input.actor !== 'string' ||
      !(ACTORS[type] as readonly BoardEventActor[]).includes(input.actor as BoardEventActor) ||
      typeof input.commandId !== 'string' ||
      !isCommandId(input.commandId) ||
      !commandMatchesActor(input.commandId, input.actor as BoardEventActor) ||
      !validatePayload(type, input.payload, input.occurredAt)
    )
      return INVALID;

    const event = deepCloneFreeze(input) as unknown as BoardEvent;
    return Object.freeze({ ok: true, event });
  } catch {
    return INVALID;
  }
}

/** Encode only a canonical event. The returned value is a fresh immutable plain tree. */
export function encodeBoardEvent(event: BoardEvent): unknown {
  const decoded = decodeBoardEvent(event);
  if (!decoded.ok) throw new TypeError(decoded.error.code);
  return decoded.event;
}

function validatePayload(type: BoardEventType, value: unknown, occurredAt: string): boolean {
  if (!isPlainRecord(value)) return false;
  switch (type) {
    case 'update.upserted':
      return validateUpdateUpserted(value, occurredAt);
    case 'update.archived':
      return validateUpdateArchived(value, occurredAt);
    case 'question.created':
      return validateQuestionCreated(value, occurredAt);
    case 'question.revised':
      return validateQuestionRevised(value, occurredAt);
    case 'question.cancelled':
      return validateTransition(value, occurredAt, 'cancelledAt', true);
    case 'question.escalated':
      return validateTransition(value, occurredAt, 'escalatedAt', false);
    case 'question.staled':
      return validateTransition(value, occurredAt, 'staleAt', true);
    case 'question.dismissed':
      return validateTransition(value, occurredAt, 'dismissedAt', false);
    case 'question.answered':
      return validateQuestionAnswered(value, occurredAt);
    case 'answer.delivery_queued':
      return validateDelivery(value, occurredAt, false);
    case 'answer.delivery_failed':
      return validateDelivery(value, occurredAt, true);
    case 'answer.acknowledged':
      return (
        exact(value, ['acknowledgement']) &&
        validateAcknowledgement(value.acknowledgement, occurredAt)
      );
    case 'board.viewed':
      return (
        exact(value, ['cutoffAt']) &&
        timestamp(value.cutoffAt) &&
        Date.parse(value.cutoffAt) <= Date.parse(occurredAt)
      );
    case 'board.reset':
      return (
        exact(value, ['resetAt', 'reason']) &&
        value.resetAt === occurredAt &&
        text(value.reason, TEXT_FIELD_POLICIES.transitionReason)
      );
  }
}

function validateUpdateUpserted(value: RecordValue, occurredAt: string): boolean {
  if (
    !exact(
      value,
      ['updateId', 'displayId', 'revision', 'createdAt', 'updatedAt', 'fields'],
      ['completedAt'],
    )
  )
    return false;
  if (
    typeof value.updateId !== 'string' ||
    !isUpdateId(value.updateId) ||
    typeof value.displayId !== 'string' ||
    !display(value.displayId, UPDATE_DISPLAY_ID) ||
    !positiveInteger(value.revision) ||
    !timestamp(value.createdAt) ||
    value.updatedAt !== occurredAt ||
    !validateUpdateFields(value.fields)
  )
    return false;
  if (value.revision === 1 && value.createdAt !== value.updatedAt) return false;
  const fields = value.fields as RecordValue;
  const terminal = fields.kind === 'completed' || fields.kind === 'failed';
  if (terminal !== hasOwn(value, 'completedAt')) return false;
  if (terminal && value.completedAt !== occurredAt) return false;
  return fields.kind !== 'completed' || !hasOwn(fields, 'stage') || fields.stage === 'complete';
}

function validateUpdateFields(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !exact(value, ['kind', 'title', 'attachments'], ['key', 'detail', 'stage', 'progress'])
  )
    return false;
  if (
    !oneOf(value.kind, ['working', 'finding', 'warning', 'blocked', 'completed', 'failed']) ||
    !text(value.title, TEXT_FIELD_POLICIES.updateTitle) ||
    !validateAttachments(value.attachments)
  )
    return false;
  if (
    hasOwn(value, 'key') &&
    (typeof value.key !== 'string' ||
      !UPDATE_KEY.test(value.key) ||
      !text(value.key, TEXT_FIELD_POLICIES.updateKey))
  )
    return false;
  if (hasOwn(value, 'detail') && !text(value.detail, TEXT_FIELD_POLICIES.updateDetail))
    return false;
  if (
    hasOwn(value, 'stage') &&
    !oneOf(value.stage, ['discovering', 'implementing', 'testing', 'validating', 'complete'])
  )
    return false;
  return !hasOwn(value, 'progress') || validateProgress(value.progress);
}

function validateProgress(value: unknown): boolean {
  if (!isPlainRecord(value) || !exact(value, ['current', 'total'], ['unit'])) return false;
  if (
    !finiteBounded(value.current, 0, MAX_SAFE) ||
    !finiteBounded(value.total, Number.MIN_VALUE, MAX_SAFE) ||
    (value.current as number) > (value.total as number)
  )
    return false;
  return !hasOwn(value, 'unit') || text(value.unit, TEXT_FIELD_POLICIES.progressUnit);
}

function validateUpdateArchived(value: RecordValue, occurredAt: string): boolean {
  return (
    exact(value, ['updateId', 'expectedRevision', 'revision', 'archivedAt']) &&
    typeof value.updateId === 'string' &&
    isUpdateId(value.updateId) &&
    positiveInteger(value.expectedRevision) &&
    positiveInteger(value.revision) &&
    value.revision === value.expectedRevision + 1 &&
    value.archivedAt === occurredAt
  );
}

function validateQuestionCreated(value: RecordValue, occurredAt: string): boolean {
  return (
    exact(value, ['questionId', 'displayId', 'revision', 'createdAt', 'spec']) &&
    typeof value.questionId === 'string' &&
    isQuestionId(value.questionId) &&
    typeof value.displayId === 'string' &&
    display(value.displayId, QUESTION_DISPLAY_ID) &&
    value.revision === 1 &&
    value.createdAt === occurredAt &&
    validateQuestionSpec(value.spec, occurredAt)
  );
}

function validateQuestionRevised(value: RecordValue, occurredAt: string): boolean {
  return (
    exact(value, [
      'questionId',
      'expectedRevision',
      'revision',
      'updatedAt',
      'revisionSummary',
      'spec',
    ]) &&
    typeof value.questionId === 'string' &&
    isQuestionId(value.questionId) &&
    positiveInteger(value.expectedRevision) &&
    positiveInteger(value.revision) &&
    value.revision === value.expectedRevision + 1 &&
    value.updatedAt === occurredAt &&
    text(value.revisionSummary, TEXT_FIELD_POLICIES.revisionSummary) &&
    validateQuestionSpec(value.spec, occurredAt)
  );
}

function validateTransition(
  value: RecordValue,
  occurredAt: string,
  timeKey: string,
  reason: boolean,
): boolean {
  const required = [
    'questionId',
    'expectedRevision',
    'revision',
    timeKey,
    ...(reason ? ['reason'] : []),
  ];
  return (
    exact(value, required) &&
    typeof value.questionId === 'string' &&
    isQuestionId(value.questionId) &&
    positiveInteger(value.expectedRevision) &&
    positiveInteger(value.revision) &&
    value.revision === value.expectedRevision + 1 &&
    value[timeKey] === occurredAt &&
    (!reason || text(value.reason, TEXT_FIELD_POLICIES.transitionReason))
  );
}

function validateQuestionSpec(value: unknown, eventTime: string): boolean {
  if (
    !isPlainRecord(value) ||
    !exact(
      value,
      [
        'question',
        'reason',
        'class',
        'response',
        'recommendedOptionIds',
        'priority',
        'blockingPolicy',
        'deliveryMode',
        'affectedWork',
        'continuingWork',
        'attachments',
      ],
      ['recommendation', 'recommendedText', 'temporaryDefault', 'expiresAt'],
    )
  )
    return false;
  if (
    !text(value.question, TEXT_FIELD_POLICIES.question) ||
    !text(value.reason, TEXT_FIELD_POLICIES.questionReason) ||
    !oneOf(value.class, ['preference', 'information', 'reversible']) ||
    !validateResponse(value.response) ||
    !stringArray(value.recommendedOptionIds, 8, OPTION_ID) ||
    !oneOf(value.priority, ['normal', 'high']) ||
    !oneOf(value.blockingPolicy, ['never', 'when_agent_settles']) ||
    !oneOf(value.deliveryMode, ['steer', 'followUp', 'nextTurn']) ||
    !textArray(value.affectedWork, 20, TEXT_FIELD_POLICIES.workItem) ||
    !textArray(value.continuingWork, 20, TEXT_FIELD_POLICIES.workItem) ||
    !validateAttachments(value.attachments)
  )
    return false;
  if (
    hasOwn(value, 'recommendation') &&
    !text(value.recommendation, TEXT_FIELD_POLICIES.recommendation)
  )
    return false;
  if (
    hasOwn(value, 'recommendedText') &&
    !text(value.recommendedText, TEXT_FIELD_POLICIES.recommendedText)
  )
    return false;
  if (
    hasOwn(value, 'expiresAt') &&
    (!timestamp(value.expiresAt) || Date.parse(value.expiresAt as string) <= Date.parse(eventTime))
  )
    return false;
  const response = value.response as RecordValue;
  const options = (response.options ?? []) as readonly RecordValue[];
  const optionIds = new Set(options.map((option) => option.id));
  const recommended = value.recommendedOptionIds as readonly string[];
  if (!recommended.every((id) => optionIds.has(id))) return false;
  if ((response.kind === 'single' || response.kind === 'single_or_text') && recommended.length > 1)
    return false;
  const allowsText = response.kind === 'text' || String(response.kind).endsWith('_or_text');
  if (hasOwn(value, 'recommendedText') && !allowsText) return false;
  return (
    !hasOwn(value, 'temporaryDefault') ||
    validateTemporaryDefault(value.temporaryDefault, value.class, response, optionIds)
  );
}

function validateResponse(value: unknown): boolean {
  if (!isPlainRecord(value) || !exact(value, ['kind'], ['options'])) return false;
  if (value.kind === 'text')
    return (
      !hasOwn(value, 'options') || (Array.isArray(value.options) && value.options.length === 0)
    );
  if (
    !oneOf(value.kind, ['single', 'multiple', 'single_or_text', 'multiple_or_text']) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 8
  )
    return false;
  const ids = new Set<string>();
  for (const option of value.options) {
    if (
      !isPlainRecord(option) ||
      !exact(option, ['id', 'label'], ['description']) ||
      typeof option.id !== 'string' ||
      !OPTION_ID.test(option.id) ||
      ids.has(option.id) ||
      !text(option.label, TEXT_FIELD_POLICIES.optionLabel)
    )
      return false;
    if (
      hasOwn(option, 'description') &&
      !text(option.description, TEXT_FIELD_POLICIES.optionDescription)
    )
      return false;
    ids.add(option.id);
  }
  return true;
}

function validateTemporaryDefault(
  value: unknown,
  questionClass: unknown,
  response: RecordValue,
  optionIds: ReadonlySet<unknown>,
): boolean {
  if (
    !isPlainRecord(value) ||
    !exact(value, ['optionIds', 'disclosure']) ||
    questionClass !== 'reversible' ||
    response.kind === 'text' ||
    !stringArray(value.optionIds, 8, OPTION_ID, 1) ||
    !(value.optionIds as readonly string[]).every((id) => optionIds.has(id)) ||
    !text(value.disclosure, TEXT_FIELD_POLICIES.temporaryDefaultDisclosure)
  )
    return false;
  return (
    (response.kind !== 'single' && response.kind !== 'single_or_text') ||
    (value.optionIds as readonly unknown[]).length === 1
  );
}

function validateQuestionAnswered(value: RecordValue, occurredAt: string): boolean {
  if (
    !exact(value, ['questionId', 'expectedRevision', 'answer']) ||
    typeof value.questionId !== 'string' ||
    !isQuestionId(value.questionId) ||
    !positiveInteger(value.expectedRevision) ||
    !validateAnswer(value.answer, occurredAt)
  )
    return false;
  const answer = value.answer as RecordValue;
  return (
    answer.questionId === value.questionId && answer.questionRevision === value.expectedRevision
  );
}

function validateAnswer(value: unknown, occurredAt: string): boolean {
  return (
    isPlainRecord(value) &&
    exact(value, [
      'id',
      'questionId',
      'questionDisplayId',
      'questionRevision',
      'source',
      'value',
      'answeredAt',
    ]) &&
    typeof value.id === 'string' &&
    isAnswerId(value.id) &&
    typeof value.questionId === 'string' &&
    isQuestionId(value.questionId) &&
    typeof value.questionDisplayId === 'string' &&
    display(value.questionDisplayId, QUESTION_DISPLAY_ID) &&
    positiveInteger(value.questionRevision) &&
    oneOf(value.source, ['manual', 'recommendation']) &&
    validateAnswerValue(value.value) &&
    value.answeredAt === occurredAt
  );
}

function validateAnswerValue(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'single':
      return exact(value, ['kind', 'optionId']) && optionId(value.optionId);
    case 'multiple':
      return exact(value, ['kind', 'optionIds']) && stringArray(value.optionIds, 8, OPTION_ID, 1);
    case 'text':
      return exact(value, ['kind', 'text']) && text(value.text, TEXT_FIELD_POLICIES.answerText);
    case 'single_or_text':
      return (
        exact(value, ['kind'], ['optionId', 'text']) &&
        (hasOwn(value, 'optionId') || hasOwn(value, 'text')) &&
        (!hasOwn(value, 'optionId') || optionId(value.optionId)) &&
        (!hasOwn(value, 'text') || text(value.text, TEXT_FIELD_POLICIES.answerText))
      );
    case 'multiple_or_text':
      return (
        exact(value, ['kind', 'optionIds'], ['text']) &&
        stringArray(value.optionIds, 8, OPTION_ID) &&
        ((value.optionIds as readonly unknown[]).length > 0 || hasOwn(value, 'text')) &&
        (!hasOwn(value, 'text') || text(value.text, TEXT_FIELD_POLICIES.answerText))
      );
    default:
      return false;
  }
}

function validateDelivery(value: RecordValue, occurredAt: string, failed: boolean): boolean {
  const required = [
    'answerId',
    'questionId',
    'attempt',
    'at',
    'mode',
    ...(failed ? ['errorCode', 'errorCategory'] : []),
  ];
  if (
    !exact(value, required) ||
    typeof value.answerId !== 'string' ||
    !isAnswerId(value.answerId) ||
    typeof value.questionId !== 'string' ||
    !isQuestionId(value.questionId) ||
    !positiveInteger(value.attempt) ||
    value.at !== occurredAt ||
    !oneOf(value.mode, ['steer', 'followUp', 'nextTurn'])
  )
    return false;
  return (
    !failed ||
    (value.errorCode === 'SB_DELIVERY_FAILED' &&
      oneOf(value.errorCategory, ['host_rejected', 'runtime_unavailable', 'unknown']))
  );
}

function validateAcknowledgement(value: unknown, occurredAt: string): boolean {
  return (
    isPlainRecord(value) &&
    exact(value, [
      'answerId',
      'questionId',
      'outcome',
      'summary',
      'resultingUpdateIds',
      'attachments',
      'acknowledgedAt',
    ]) &&
    typeof value.answerId === 'string' &&
    isAnswerId(value.answerId) &&
    typeof value.questionId === 'string' &&
    isQuestionId(value.questionId) &&
    oneOf(value.outcome, [
      'applied',
      'partially_applied',
      'cannot_apply',
      'duplicate',
      'superseded',
    ]) &&
    text(value.summary, TEXT_FIELD_POLICIES.acknowledgementSummary) &&
    idArray(value.resultingUpdateIds, 20, isUpdateId) &&
    validateAttachments(value.attachments) &&
    value.acknowledgedAt === occurredAt
  );
}

function validateAttachments(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 10) return false;
  return value.every((attachment) => {
    if (
      !isPlainRecord(attachment) ||
      typeof attachment.kind !== 'string' ||
      !text(attachment.label, TEXT_FIELD_POLICIES.attachmentLabel)
    )
      return false;
    switch (attachment.kind) {
      case 'file':
        return (
          exact(attachment, ['kind', 'label', 'path'], ['external']) &&
          text(attachment.path, TEXT_FIELD_POLICIES.attachmentPath) &&
          optionalBoolean(attachment, 'external')
        );
      case 'line_range':
        return (
          exact(attachment, ['kind', 'label', 'path', 'startLine', 'endLine'], ['external']) &&
          text(attachment.path, TEXT_FIELD_POLICIES.attachmentPath) &&
          positiveInteger(attachment.startLine) &&
          positiveInteger(attachment.endLine) &&
          (attachment.endLine as number) >= (attachment.startLine as number) &&
          optionalBoolean(attachment, 'external')
        );
      case 'test_run':
      case 'command':
        return (
          exact(attachment, ['kind', 'label', 'reference']) &&
          text(attachment.reference, TEXT_FIELD_POLICIES.attachmentReference)
        );
      case 'url':
        return (
          exact(attachment, ['kind', 'label', 'url']) &&
          text(attachment.url, TEXT_FIELD_POLICIES.attachmentUrl) &&
          httpUrl(attachment.url)
        );
      case 'note':
        return (
          exact(attachment, ['kind', 'label', 'text']) &&
          text(attachment.text, TEXT_FIELD_POLICIES.attachmentNote)
        );
      default:
        return false;
    }
  });
}

function isSafeTree(root: unknown): boolean {
  const active = new Set<object>();
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null)
      return typeof value !== 'number' || Number.isFinite(value);
    if (active.has(value)) return false;
    if (seen.has(value)) return true;
    if (!Array.isArray(value) && !isPlainRecord(value)) return false;
    active.add(value);
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      if (typeof key !== 'string' || POLLUTION_KEYS.has(key)) return false;
      const descriptor = descriptors[key];
      if (Array.isArray(value) && key === 'length') continue;
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        'get' in descriptor ||
        'set' in descriptor ||
        !('value' in descriptor) ||
        !visit(descriptor.value)
      )
        return false;
    }
    if (
      Array.isArray(value) &&
      (keys.some(
        (key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key)),
      ) ||
        Object.keys(value).length !== value.length)
    )
      return false;
    active.delete(value);
    return true;
  };
  return visit(root);
}

function deepCloneFreeze<T>(root: T): T {
  const clone = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) return Object.freeze(value.map(clone));
    const result: RecordValue = {};
    for (const key of Object.keys(value)) result[key] = clone((value as RecordValue)[key]);
    return Object.freeze(result);
  };
  return clone(root) as T;
}

function isPlainRecord(value: unknown): value is RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}
function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}
function commandMatchesActor(commandId: string, actor: BoardEventActor): boolean {
  return commandId.startsWith(
    `${actor === 'agent' ? 'tool' : actor === 'user' ? 'ui' : 'system'}:`,
  );
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && isFiniteUtcTimestamp(value);
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function finiteBounded(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}
function oneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}
function text(value: unknown, policy: TextPolicy): value is string {
  return (
    typeof value === 'string' && validatePersistedText(value, policy.mode, policy.maxCodePoints).ok
  );
}
function display(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value) || value.length > 32) return false;
  const sequence = Number(value.slice(2));
  return Number.isSafeInteger(sequence);
}
function optionId(value: unknown): value is string {
  return (
    typeof value === 'string' && OPTION_ID.test(value) && text(value, TEXT_FIELD_POLICIES.optionId)
  );
}
function stringArray(
  value: unknown,
  maximum: number,
  pattern: RegExp,
  minimum = 0,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((item) => typeof item === 'string' && pattern.test(item)) &&
    new Set(value).size === value.length
  );
}
function textArray(
  value: unknown,
  maximum: number,
  policy: TextPolicy,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => text(item, policy)) &&
    new Set(value).size === value.length
  );
}
function idArray(
  value: unknown,
  maximum: number,
  validator: (value: string) => boolean,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === 'string' && validator(item)) &&
    new Set(value).size === value.length
  );
}
function optionalBoolean(value: RecordValue, key: string): boolean {
  return !hasOwn(value, key) || typeof value[key] === 'boolean';
}
function httpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
