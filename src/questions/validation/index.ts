import type { EffectiveConfig } from '../../config/types.js';
import { normalizeAttachments } from '../../domain/attachments.js';
import {
  type FieldErrorReason,
  fail,
  fieldError,
  type Result,
  signalBoardError,
  succeed,
} from '../../domain/errors.js';
import { isFiniteUtcTimestamp, validAnswerValue } from '../../domain/invariants.js';
import { sanitizeText, TEXT_FIELD_POLICIES, type TextPolicy } from '../../domain/sanitization.js';
import type {
  AnswerValue,
  BlockingPolicy,
  DeliveryMode,
  NonEmptyReadonlyArray,
  OptionId,
  QuestionClass,
  QuestionOption,
  QuestionPriority,
  QuestionSpec,
  ResponseKind,
  ResponseSpec,
  TemporaryDefault,
} from '../../domain/types.js';

const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const MAX_OPTIONS = 8;
const MAX_WORK_ITEMS = 20;
const ENUM_POLICY = Object.freeze({ mode: 'one_line', maxCodePoints: 64 } as const);
const TIMESTAMP_POLICY = Object.freeze({ mode: 'one_line', maxCodePoints: 64 } as const);

const QUESTION_CLASSES = new Set<QuestionClass>([
  'preference',
  'information',
  'reversible',
  'authorization',
]);
const RESPONSE_KINDS = new Set<ResponseKind>([
  'single',
  'multiple',
  'text',
  'single_or_text',
  'multiple_or_text',
]);
const PRIORITIES = new Set<QuestionPriority>(['normal', 'high']);
const BLOCKING_POLICIES = new Set<BlockingPolicy>(['never', 'when_agent_settles']);
const DELIVERY_MODES = new Set<DeliveryMode>(['steer', 'followUp', 'nextTurn']);

export interface QuestionValidationContext {
  readonly config: Pick<EffectiveConfig, 'questions'>;
  /** Caller-supplied project working directory used only for lexical attachment normalization. */
  readonly cwd: string;
  /** Exact caller-supplied current time. Ambient time is never read. */
  readonly currentTimestamp: string;
}

/**
 * Normalize a structurally parsed create payload. Create-only omissions receive
 * their configured or empty defaults.
 */
export function normalizeCreateQuestionSpec(
  input: unknown,
  context: QuestionValidationContext,
): Result<QuestionSpec> {
  return normalizeQuestionSpec(input, context, 'create');
}

/**
 * Normalize the complete editable specification from a revise payload. Required
 * semantic fields never inherit from an older question.
 */
export function normalizeReviseQuestionSpec(
  input: unknown,
  context: QuestionValidationContext,
): Result<QuestionSpec> {
  return normalizeQuestionSpec(input, context, 'revise');
}

/** Return the exact normalized answer represented by a recommendation. */
export function projectRecommendationAnswer(spec: QuestionSpec): AnswerValue | undefined {
  const ids = spec.recommendedOptionIds;
  const text = spec.recommendedText;
  let answer: AnswerValue | undefined;

  switch (spec.response.kind) {
    case 'single':
      answer = ids.length === 1 ? { kind: 'single', optionId: ids[0] as OptionId } : undefined;
      break;
    case 'multiple':
      answer =
        ids.length > 0
          ? { kind: 'multiple', optionIds: ids as NonEmptyReadonlyArray<OptionId> }
          : undefined;
      break;
    case 'text':
      answer = text === undefined ? undefined : { kind: 'text', text };
      break;
    case 'single_or_text':
      answer =
        ids.length === 0 && text === undefined
          ? undefined
          : ({
              kind: 'single_or_text',
              ...(ids[0] === undefined ? {} : { optionId: ids[0] }),
              ...(text === undefined ? {} : { text }),
            } as AnswerValue);
      break;
    case 'multiple_or_text':
      answer =
        ids.length === 0 && text === undefined
          ? undefined
          : ({
              kind: 'multiple_or_text',
              optionIds: ids,
              ...(text === undefined ? {} : { text }),
            } as AnswerValue);
      break;
  }

  return answer !== undefined && validAnswerValue(answer, spec) ? freezeCopy(answer) : undefined;
}

type ValidationMode = 'create' | 'revise';

function normalizeQuestionSpec(
  input: unknown,
  context: QuestionValidationContext,
  mode: ValidationMode,
): Result<QuestionSpec> {
  if (!isRecord(input)) return invalid('input', 'invalid_type');
  if (!isFiniteUtcTimestamp(context.currentTimestamp)) {
    return invalid('currentTimestamp', 'invalid_value');
  }

  const question = requiredText(input.question, TEXT_FIELD_POLICIES.question, 'question');
  if (!question.ok) return question;
  const reason = requiredText(input.reason, TEXT_FIELD_POLICIES.questionReason, 'reason');
  if (!reason.ok) return reason;
  const questionClass = enumField(input.class, QUESTION_CLASSES, 'class');
  if (!questionClass.ok) return questionClass;
  const response = normalizeResponse(input.response);
  if (!response.ok) return response;

  const recommendation = optionalText(
    input.recommendation,
    TEXT_FIELD_POLICIES.recommendation,
    'recommendation',
  );
  if (!recommendation.ok) return recommendation;
  const recommendedText = optionalText(
    input.recommendedText,
    TEXT_FIELD_POLICIES.recommendedText,
    'recommendedText',
  );
  if (!recommendedText.ok) return recommendedText;

  const recommendedOptionIds = normalizeOptionIds(
    input.recommendedOptionIds,
    'recommendedOptionIds',
    mode === 'create',
  );
  if (!recommendedOptionIds.ok) return recommendedOptionIds;

  const priority = defaultedEnum(
    input.priority,
    mode === 'create' ? 'normal' : undefined,
    PRIORITIES,
    'priority',
  );
  if (!priority.ok) return priority;
  const blockingPolicy = defaultedEnum(
    input.blockingPolicy,
    mode === 'create' ? context.config.questions.defaultBlockingPolicy : undefined,
    BLOCKING_POLICIES,
    'blockingPolicy',
  );
  if (!blockingPolicy.ok) return blockingPolicy;
  const deliveryMode = defaultedEnum(
    input.deliveryMode,
    mode === 'create' ? context.config.questions.defaultDeliveryMode : undefined,
    DELIVERY_MODES,
    'deliveryMode',
  );
  if (!deliveryMode.ok) return deliveryMode;

  const affectedWork = normalizeWorkList(input.affectedWork, 'affectedWork', mode === 'create');
  if (!affectedWork.ok) return affectedWork;
  const continuingWork = normalizeWorkList(
    input.continuingWork,
    'continuingWork',
    mode === 'create',
  );
  if (!continuingWork.ok) return continuingWork;
  const affected = new Set(affectedWork.value);
  if (continuingWork.value.some((item) => affected.has(item))) {
    return invalid('continuingWork', 'duplicate');
  }

  const attachmentsInput = input.attachments ?? (mode === 'create' ? [] : undefined);
  if (attachmentsInput === undefined) return invalid('attachments', 'required');
  const attachments = normalizeAttachments(attachmentsInput, context.cwd);
  if (!attachments.ok) {
    return fail(
      signalBoardError(
        'SB_INVALID_ARGUMENT',
        attachments.error.fieldErrors ?? [fieldError('attachments', 'invalid_value')],
      ),
    );
  }

  const expiresAt = normalizeExpiry(input.expiresAt, context.currentTimestamp);
  if (!expiresAt.ok) return expiresAt;

  const optionOrder = new Map(
    (response.value.options ?? []).map((option, index) => [option.id, index] as const),
  );
  const orderedRecommendation = orderReferencedIds(
    recommendedOptionIds.value,
    optionOrder,
    'recommendedOptionIds',
  );
  if (!orderedRecommendation.ok) return orderedRecommendation;
  if (
    (response.value.kind === 'single' || response.value.kind === 'single_or_text') &&
    orderedRecommendation.value.length > 1
  ) {
    return invalid('recommendedOptionIds', 'too_many');
  }
  const allowsText =
    response.value.kind === 'text' ||
    response.value.kind === 'single_or_text' ||
    response.value.kind === 'multiple_or_text';
  if (recommendedText.value !== undefined && !allowsText) {
    return invalid('recommendedText', 'unsupported');
  }

  const temporaryDefault = normalizeTemporaryDefault(
    input.temporaryDefault,
    questionClass.value,
    response.value,
    optionOrder,
  );
  if (!temporaryDefault.ok) return temporaryDefault;

  const spec = freezeCopy({
    question: question.value,
    reason: reason.value,
    class: questionClass.value,
    response: response.value,
    ...(recommendation.value === undefined ? {} : { recommendation: recommendation.value }),
    recommendedOptionIds: orderedRecommendation.value,
    ...(recommendedText.value === undefined ? {} : { recommendedText: recommendedText.value }),
    ...(temporaryDefault.value === undefined ? {} : { temporaryDefault: temporaryDefault.value }),
    priority: priority.value,
    blockingPolicy: blockingPolicy.value,
    deliveryMode: deliveryMode.value,
    affectedWork: affectedWork.value,
    continuingWork: continuingWork.value,
    attachments: attachments.value,
    ...(expiresAt.value === undefined ? {} : { expiresAt: expiresAt.value }),
  } satisfies QuestionSpec);

  const projected = projectRecommendationAnswer(spec);
  if (
    (spec.recommendedOptionIds.length > 0 || spec.recommendedText !== undefined) &&
    projected === undefined
  ) {
    return invalid('recommendedOptionIds', 'invalid_value');
  }
  return succeed(spec);
}

function normalizeResponse(input: unknown): Result<ResponseSpec> {
  if (!isRecord(input)) return invalid('response', 'invalid_type');
  const kind = enumField(input.kind, RESPONSE_KINDS, 'response.kind');
  if (!kind.ok) return kind;
  const optionInput = input.options ?? (kind.value === 'text' ? [] : undefined);
  if (!Array.isArray(optionInput)) {
    return invalid('response.options', optionInput === undefined ? 'required' : 'invalid_type');
  }
  if (kind.value === 'text') {
    if (optionInput.length !== 0) return invalid('response.options', 'too_many');
    return succeed(freezeCopy({ kind: 'text', options: [] }));
  }
  if (optionInput.length < 2) return invalid('response.options', 'out_of_range');
  if (optionInput.length > MAX_OPTIONS) return invalid('response.options', 'too_many');

  const options: QuestionOption[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < optionInput.length; index += 1) {
    const item = optionInput[index];
    const base = `response.options[${index}]`;
    if (!isRecord(item)) return invalid(base, 'invalid_type');
    const id = requiredText(item.id, TEXT_FIELD_POLICIES.optionId, `${base}.id`);
    if (!id.ok) return id;
    if (!OPTION_ID.test(id.value)) return invalid(`${base}.id`, 'invalid_value');
    if (ids.has(id.value)) return invalid(`${base}.id`, 'duplicate');
    ids.add(id.value);
    const label = requiredText(item.label, TEXT_FIELD_POLICIES.optionLabel, `${base}.label`);
    if (!label.ok) return label;
    const description = optionalText(
      item.description,
      TEXT_FIELD_POLICIES.optionDescription,
      `${base}.description`,
    );
    if (!description.ok) return description;
    options.push(
      freezeCopy({
        id: id.value as OptionId,
        label: label.value,
        ...(description.value === undefined ? {} : { description: description.value }),
      }),
    );
  }
  return succeed(freezeCopy({ kind: kind.value, options }) as ResponseSpec);
}

function normalizeTemporaryDefault(
  input: unknown,
  questionClass: QuestionClass,
  response: ResponseSpec,
  optionOrder: ReadonlyMap<OptionId, number>,
): Result<TemporaryDefault | undefined> {
  if (input === undefined) return succeed(undefined);
  if (!isRecord(input)) return invalid('temporaryDefault', 'invalid_type');
  if (questionClass !== 'reversible') return invalid('temporaryDefault', 'unsupported');
  if (response.kind === 'text') return invalid('temporaryDefault', 'unsupported');

  const ids = normalizeOptionIds(input.optionIds, 'temporaryDefault.optionIds', false);
  if (!ids.ok) return ids;
  if (ids.value.length === 0) return invalid('temporaryDefault.optionIds', 'required');
  const ordered = orderReferencedIds(ids.value, optionOrder, 'temporaryDefault.optionIds');
  if (!ordered.ok) return ordered;
  if (
    (response.kind === 'single' || response.kind === 'single_or_text') &&
    ordered.value.length !== 1
  ) {
    return invalid('temporaryDefault.optionIds', 'out_of_range');
  }
  const disclosure = requiredText(
    input.disclosure,
    TEXT_FIELD_POLICIES.temporaryDefaultDisclosure,
    'temporaryDefault.disclosure',
  );
  if (!disclosure.ok) return disclosure;
  return succeed(freezeCopy({ optionIds: ordered.value, disclosure: disclosure.value }));
}

function normalizeOptionIds(
  input: unknown,
  path: string,
  defaultEmpty: boolean,
): Result<readonly OptionId[]> {
  if (input === undefined && defaultEmpty) return succeed(Object.freeze([]));
  if (!Array.isArray(input))
    return invalid(path, input === undefined ? 'required' : 'invalid_type');
  if (input.length > MAX_OPTIONS) return invalid(path, 'too_many');
  const values: OptionId[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const value = requiredText(input[index], TEXT_FIELD_POLICIES.optionId, `${path}[${index}]`);
    if (!value.ok) return value;
    if (!OPTION_ID.test(value.value)) return invalid(`${path}[${index}]`, 'invalid_value');
    if (seen.has(value.value)) return invalid(`${path}[${index}]`, 'duplicate');
    seen.add(value.value);
    values.push(value.value as OptionId);
  }
  return succeed(Object.freeze(values));
}

function orderReferencedIds(
  ids: readonly OptionId[],
  order: ReadonlyMap<OptionId, number>,
  path: string,
): Result<readonly OptionId[]> {
  for (let index = 0; index < ids.length; index += 1) {
    if (!order.has(ids[index] as OptionId)) return invalid(`${path}[${index}]`, 'invalid_value');
  }
  return succeed(
    Object.freeze([...ids].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))),
  );
}

function normalizeWorkList(
  input: unknown,
  path: string,
  defaultEmpty: boolean,
): Result<readonly string[]> {
  if (input === undefined && defaultEmpty) return succeed(Object.freeze([]));
  if (!Array.isArray(input))
    return invalid(path, input === undefined ? 'required' : 'invalid_type');
  if (input.length > MAX_WORK_ITEMS) return invalid(path, 'too_many');
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const value = requiredText(input[index], TEXT_FIELD_POLICIES.workItem, `${path}[${index}]`);
    if (!value.ok) return value;
    if (seen.has(value.value)) return invalid(`${path}[${index}]`, 'duplicate');
    seen.add(value.value);
    values.push(value.value);
  }
  return succeed(Object.freeze(values));
}

function normalizeExpiry(input: unknown, currentTimestamp: string): Result<string | undefined> {
  if (input === undefined) return succeed(undefined);
  const value = requiredText(input, TIMESTAMP_POLICY, 'expiresAt');
  if (!value.ok) return value;
  if (value.value !== input || !isFiniteUtcTimestamp(value.value)) {
    return invalid('expiresAt', 'invalid_value');
  }
  if (Date.parse(value.value) <= Date.parse(currentTimestamp)) {
    return invalid('expiresAt', 'out_of_range');
  }
  return succeed(value.value);
}

function requiredText(input: unknown, policy: TextPolicy, path: string): Result<string> {
  if (typeof input !== 'string')
    return invalid(path, input === undefined ? 'required' : 'invalid_type');
  const value = sanitizeText(input, policy);
  return value.ok ? succeed(value.value) : invalid(path, textReason(value.reason));
}

function optionalText(
  input: unknown,
  policy: TextPolicy,
  path: string,
): Result<string | undefined> {
  return input === undefined ? succeed(undefined) : requiredText(input, policy, path);
}

function enumField<T extends string>(
  input: unknown,
  values: ReadonlySet<T>,
  path: string,
): Result<T> {
  const value = requiredText(input, ENUM_POLICY, path);
  if (!value.ok) return value as Result<T>;
  return values.has(value.value as T) ? succeed(value.value as T) : invalid(path, 'unsupported');
}

function defaultedEnum<T extends string>(
  input: unknown,
  defaultValue: T | undefined,
  values: ReadonlySet<T>,
  path: string,
): Result<T> {
  return input === undefined && defaultValue !== undefined
    ? succeed(defaultValue)
    : enumField(input, values, path);
}

function textReason(reason: string): FieldErrorReason {
  if (reason === 'empty') return 'required';
  if (reason === 'too_long') return 'too_long';
  return 'invalid_value';
}

function invalid<T>(path: string, reason: FieldErrorReason): Result<T> {
  return fail(signalBoardError('SB_INVALID_ARGUMENT', [fieldError(path, reason)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeCopy(item))) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = freezeCopy(child);
  return Object.freeze(copy) as T;
}
