import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { type Static, type TSchema, Type } from 'typebox';

import { QUESTION_TOOL_NAME } from '../constants.js';
import type { SignalBoardError } from '../domain/errors.js';
import { ERROR_DEFINITIONS } from '../domain/errors.js';
import type { QuestionStatus } from '../domain/types.js';
import type { RuntimeLifecycle } from '../integration/lifecycle.js';
import type {
  CancelQuestionCommand,
  CreateQuestionCommand,
  QuestionMutationResult,
  ReviseQuestionCommand,
} from '../services/question-service.js';
import type { PendingToolFailures } from './update-tool.js';

function oneOf<const Schemas extends readonly TSchema[]>(schemas: Schemas) {
  return Type.Unsafe<Static<Schemas[number]>>({ oneOf: schemas });
}

const optionId = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
});
const questionLookupId = oneOf([
  Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  }),
  Type.String({ minLength: 1, maxLength: 32, pattern: '^Q-[1-9][0-9]*$' }),
] as const);
const attachmentLabel = Type.String({ minLength: 1, maxLength: 160 });
const attachment = oneOf([
  Type.Object(
    {
      kind: StringEnum(['file'] as const),
      label: attachmentLabel,
      path: Type.String({ minLength: 1, maxLength: 1000 }),
      external: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['line_range'] as const),
      label: attachmentLabel,
      path: Type.String({ minLength: 1, maxLength: 1000 }),
      startLine: Type.Integer({ minimum: 1, maximum: 2147483647 }),
      endLine: Type.Integer({ minimum: 1, maximum: 2147483647 }),
      external: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['test_run'] as const),
      label: attachmentLabel,
      reference: Type.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['command'] as const),
      label: attachmentLabel,
      reference: Type.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['url'] as const),
      label: attachmentLabel,
      url: Type.String({ minLength: 1, maxLength: 2000, format: 'uri' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['note'] as const),
      label: attachmentLabel,
      text: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
] as const);
const attachments = Type.Array(attachment, { maxItems: 10 });
const questionOption = Type.Object(
  {
    id: optionId,
    label: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);
const textResponse = Type.Object(
  {
    kind: StringEnum(['text'] as const),
    options: Type.Optional(Type.Array(questionOption, { maxItems: 0 })),
  },
  { additionalProperties: false },
);
const optionResponse = Type.Object(
  {
    kind: StringEnum(['single', 'multiple', 'single_or_text', 'multiple_or_text'] as const),
    options: Type.Array(questionOption, { minItems: 2, maxItems: 8 }),
  },
  { additionalProperties: false },
);
const response = oneOf([textResponse, optionResponse] as const);
const temporaryDefault = Type.Object(
  {
    optionIds: Type.Array(optionId, { minItems: 1, maxItems: 8, uniqueItems: true }),
    disclosure: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
const recommendedOptionIds = Type.Array(optionId, { maxItems: 8, uniqueItems: true });
const workItems = Type.Array(Type.String({ minLength: 1, maxLength: 240 }), {
  maxItems: 20,
  uniqueItems: true,
});
const timestamp = Type.String({ minLength: 1, maxLength: 64, format: 'date-time' });
const questionClass = StringEnum([
  'preference',
  'information',
  'reversible',
  'authorization',
] as const);
const priority = StringEnum(['normal', 'high'] as const);
const blockingPolicy = StringEnum(['never', 'when_agent_settles'] as const);
const deliveryMode = StringEnum(['steer', 'followUp', 'nextTurn'] as const);

const editableProperties = {
  question: Type.String({ minLength: 1, maxLength: 160 }),
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
  class: questionClass,
  response,
  recommendation: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  recommendedOptionIds: Type.Optional(recommendedOptionIds),
  recommendedText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  temporaryDefault: Type.Optional(temporaryDefault),
  priority: Type.Optional(priority),
  blockingPolicy: Type.Optional(blockingPolicy),
  deliveryMode: Type.Optional(deliveryMode),
  affectedWork: Type.Optional(workItems),
  continuingWork: Type.Optional(workItems),
  attachments: Type.Optional(attachments),
  expiresAt: Type.Optional(timestamp),
};
const createParameters = Type.Object(
  { operation: StringEnum(['create'] as const), ...editableProperties },
  { additionalProperties: false },
);
const reviseParameters = Type.Object(
  {
    operation: StringEnum(['revise'] as const),
    id: questionLookupId,
    expectedRevision: Type.Integer({ minimum: 1 }),
    revisionSummary: Type.String({ minLength: 1, maxLength: 1000 }),
    ...editableProperties,
    recommendedOptionIds,
    priority,
    blockingPolicy,
    deliveryMode,
    affectedWork: workItems,
    continuingWork: workItems,
    attachments,
  },
  { additionalProperties: false },
);
const cancelParameters = Type.Object(
  {
    operation: StringEnum(['cancel'] as const),
    id: questionLookupId,
    expectedRevision: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const QUESTION_TOOL_PARAMETERS = oneOf([
  createParameters,
  reviseParameters,
  cancelParameters,
] as const);

export type QuestionToolInput =
  | ({ readonly operation: 'create' } & Omit<CreateQuestionCommand, 'commandId'>)
  | ({ readonly operation: 'revise' } & Omit<ReviseQuestionCommand, 'commandId'>)
  | ({ readonly operation: 'cancel' } & Omit<CancelQuestionCommand, 'commandId'>);

export interface QuestionToolSuccess {
  readonly ok: true;
  readonly operation: QuestionToolInput['operation'];
  readonly value: {
    readonly item: Pick<QuestionMutationResult['item'], 'id' | 'displayId' | 'revision' | 'status'>;
  };
  readonly event: QuestionMutationResult['event'];
  readonly noOp: boolean;
}
export interface QuestionToolFailure {
  readonly ok: false;
  readonly error: SignalBoardError;
}
export type QuestionToolDetails = QuestionToolSuccess | QuestionToolFailure;

export const QUESTION_TOOL_DESCRIPTION =
  'Create, fully revise, or cancel a durable asynchronous Signals question.';
export const QUESTION_TOOL_PROMPT_SNIPPET =
  'Queue a structured question only when useful independent work can continue.';
export const QUESTION_TOOL_PROMPT_GUIDELINES = [
  'Use signal_board_question only when useful independent work can continue.',
  'State the reason, recommendation, affected work, and continuing work in signal_board_question.',
  'Never use signal_board_question for permission to delete, publish, spend, expose secrets, change access, or perform another privileged or irreversible action.',
  'After signal_board_question queues a question, never assume the recommendation or temporary default is the user answer.',
  'Revise or cancel signal_board_question when evidence changes.',
];

export function registerQuestionTool(
  pi: ExtensionAPI,
  lifecycle: RuntimeLifecycle,
  pending: PendingToolFailures,
): void {
  pi.registerTool({
    name: QUESTION_TOOL_NAME,
    label: 'Signals Question',
    description: QUESTION_TOOL_DESCRIPTION,
    promptSnippet: QUESTION_TOOL_PROMPT_SNIPPET,
    promptGuidelines: QUESTION_TOOL_PROMPT_GUIDELINES,
    parameters: QUESTION_TOOL_PARAMETERS,
    async execute(toolCallId, input) {
      try {
        const runtime = lifecycle.slot.requireHealthyLocked();
        if (!runtime.ok) {
          const code =
            runtime.error.code === 'SB_DISABLED' ? 'SB_CONFIG_DISABLED' : runtime.error.code;
          return throwFailure(toolCallId, publicError(code), pending);
        }
        const service = runtime.value.questionService;
        if (service === undefined) {
          return throwFailure(toolCallId, publicError('SB_NOT_INITIALIZED'), pending);
        }
        const commandId = `tool:${toolCallId}` as const;
        const result =
          input.operation === 'create'
            ? await service.createQuestion({ ...input, commandId } as CreateQuestionCommand)
            : input.operation === 'revise'
              ? await service.reviseQuestion({ ...input, commandId } as ReviseQuestionCommand)
              : await service.cancelQuestion({ ...input, commandId } as CancelQuestionCommand);
        if (!result.ok) return throwFailure(toolCallId, result.error, pending);
        const details = successDetails(input.operation, result.value);
        return { content: [{ type: 'text' as const, text: successText(details) }], details };
      } catch (cause) {
        if (pending.has(toolCallId)) throw cause;
        return throwFailure(toolCallId, publicError('SB_INTERNAL'), pending);
      }
    },
    renderCall(input, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      const identity =
        input.operation === 'create' ? safeInline(input.question, 28) : safeInline(input.id, 32);
      component.setText(
        truncateToWidth(
          `${theme.fg('toolTitle', theme.bold(QUESTION_TOOL_NAME))} ${theme.fg('muted', safeOperation(input))}${identity ? ` ${theme.fg('dim', identity)}` : ''}`,
          240,
        ),
      );
      return component;
    },
    renderResult(result, options, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      const details = parseDetails(result.details);
      if (details === undefined) {
        component.setText(theme.fg('error', 'ERROR SB_INTERNAL Result details unavailable.'));
      } else if (!details.ok) {
        component.setText(theme.fg('error', `ERROR ${safeCode(details.error.code)}`));
      } else {
        const item = details.value.item;
        const first = `OK ${details.operation} ${safeInline(item.displayId, 12)} rev ${safeRevision(item.revision)} status ${safeStatus(item.status)}${details.noOp ? ' no-op' : ''}`;
        const guidance =
          details.operation === 'cancel'
            ? 'No answer was sent.'
            : 'Continue only independent work; do not assume an answer.';
        let text = `${theme.fg('success', first)}\n${theme.fg('muted', guidance)}`;
        if (options.expanded) {
          text += `\n${theme.fg('dim', `id ${safeInline(item.id, 64)}`)}`;
          text += `\n${theme.fg('dim', `event ${safeEventType(details.event?.eventType)}`)}`;
        }
        component.setText(text);
      }
      return component;
    },
  });
}

function throwFailure(id: string, error: SignalBoardError, pending: PendingToolFailures): never {
  pending.set(id, Object.freeze({ ok: false, error }));
  throw new Error(`Signals tool failed (${error.code}).`);
}

function publicError(
  code: 'SB_NOT_INITIALIZED' | 'SB_UNSUPPORTED_HOST' | 'SB_CONFIG_DISABLED' | 'SB_INTERNAL',
): SignalBoardError {
  const definition = ERROR_DEFINITIONS[code];
  return Object.freeze({ code, message: definition.message, retryable: definition.retryable });
}

function successDetails(
  operation: QuestionToolInput['operation'],
  result: QuestionMutationResult,
): QuestionToolSuccess {
  const item = result.item;
  return Object.freeze({
    ok: true,
    operation,
    value: Object.freeze({
      item: Object.freeze({
        id: item.id,
        displayId: item.displayId,
        revision: item.revision,
        status: item.status,
      }),
    }),
    event: result.event,
    noOp: result.noOp,
  });
}

function successText(details: QuestionToolSuccess): string {
  const item = details.value.item;
  if (details.operation === 'cancel') {
    return `Cancelled ${item.displayId} revision ${item.revision}. No answer was sent.`;
  }
  return `Queued ${item.displayId} revision ${item.revision}. Continue only work that does not depend on this answer; do not assume the recommendation or temporary default is the user's choice.`;
}

function parseDetails(value: unknown): QuestionToolDetails | undefined {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return undefined;
  const candidate = value as Partial<QuestionToolDetails>;
  if (candidate.ok === false && isErrorShape(candidate.error))
    return candidate as QuestionToolFailure;
  if (candidate.ok !== true || !('operation' in candidate) || !('value' in candidate))
    return undefined;
  const operation = candidate.operation;
  const item = (candidate as { value?: { item?: unknown } }).value?.item;
  if (
    (operation !== 'create' && operation !== 'revise' && operation !== 'cancel') ||
    typeof item !== 'object' ||
    item === null
  ) {
    return undefined;
  }
  return candidate as QuestionToolSuccess;
}

function isErrorShape(value: unknown): value is SignalBoardError {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function safeOperation(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('operation' in input)) return 'unknown';
  const value = (input as { operation?: unknown }).operation;
  return value === 'create' || value === 'revise' || value === 'cancel' ? value : 'unknown';
}

function safeStatus(value: unknown): QuestionStatus | 'unknown' {
  const statuses: readonly QuestionStatus[] = [
    'pending',
    'blocking',
    'answered',
    'delivery_queued',
    'delivery_failed',
    'needs_attention',
    'resolved',
    'stale',
    'cancelled',
    'dismissed',
  ];
  return typeof value === 'string' && statuses.includes(value as QuestionStatus)
    ? (value as QuestionStatus)
    : 'unknown';
}

function safeRevision(value: unknown): string {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? String(value) : '?';
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^SB_[A-Z_]+$/u.test(value) ? value : 'SB_INTERNAL';
}

function safeEventType(value: unknown): string {
  return value === 'question.created' ||
    value === 'question.revised' ||
    value === 'question.cancelled'
    ? value
    : 'unavailable';
}

function safeInline(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const clean = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}
