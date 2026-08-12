import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { type Static, type TSchema, Type } from 'typebox';

import { ACK_TOOL_NAME, QUESTION_TOOL_NAME, UPDATE_TOOL_NAME } from '../constants.js';
import type { SignalBoardError } from '../domain/errors.js';
import { ERROR_DEFINITIONS } from '../domain/errors.js';
import type { Attachment, MeasurableProgress, UpdateKind, UpdateStage } from '../domain/types.js';
import type { RuntimeLifecycle } from '../integration/lifecycle.js';
import type {
  ArchiveUpdateCommand,
  UpdateMutationResult,
  UpsertUpdateCommand,
} from '../services/update-service.js';

function oneOf<const Schemas extends readonly TSchema[]>(schemas: Schemas) {
  return Type.Unsafe<Static<Schemas[number]>>({ oneOf: schemas });
}

const lookupId = oneOf([
  Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^upd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  }),
  Type.String({ minLength: 1, maxLength: 32, pattern: '^U-[1-9][0-9]*$' }),
] as const);
const key = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$',
});
const label = Type.String({ minLength: 1, maxLength: 160 });
const attachment = oneOf([
  Type.Object(
    {
      kind: StringEnum(['file'] as const),
      label,
      path: Type.String({ minLength: 1, maxLength: 1000 }),
      external: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['line_range'] as const),
      label,
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
      label,
      reference: Type.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['command'] as const),
      label,
      reference: Type.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['url'] as const),
      label,
      url: Type.String({ minLength: 1, maxLength: 2000, format: 'uri' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: StringEnum(['note'] as const),
      label,
      text: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
] as const);
const progress = Type.Object(
  {
    current: Type.Number({ minimum: 0 }),
    total: Type.Number({ exclusiveMinimum: 0 }),
    unit: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  },
  { additionalProperties: false },
);
const updateKind = StringEnum([
  'working',
  'finding',
  'warning',
  'blocked',
  'completed',
  'failed',
] as const);
const updateStage = StringEnum([
  'discovering',
  'implementing',
  'testing',
  'validating',
  'complete',
] as const);

const upsertParameters = Type.Object(
  {
    operation: StringEnum(['upsert'] as const),
    id: Type.Optional(lookupId),
    key: Type.Optional(key),
    kind: Type.Optional(updateKind),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    detail: Type.Optional(
      oneOf([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()] as const),
    ),
    stage: Type.Optional(oneOf([updateStage, Type.Null()] as const)),
    progress: Type.Optional(oneOf([progress, Type.Null()] as const)),
    attachments: Type.Optional(Type.Array(attachment, { maxItems: 10 })),
  },
  { additionalProperties: false },
);
const archiveObject = Type.Object(
  {
    operation: StringEnum(['archive'] as const),
    id: Type.Optional(lookupId),
    key: Type.Optional(key),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const archiveParameters = Type.Unsafe<Static<typeof archiveObject>>({
  ...archiveObject,
  anyOf: [{ required: ['id'] }, { required: ['key'] }],
});

export const UPDATE_TOOL_PARAMETERS = oneOf([upsertParameters, archiveParameters] as const);

export type UpdateToolInput =
  | ({ readonly operation: 'upsert' } & Omit<UpsertUpdateCommand, 'commandId'>)
  | ({ readonly operation: 'archive' } & Omit<ArchiveUpdateCommand, 'commandId'>);

export interface UpdateToolSuccess {
  readonly ok: true;
  readonly operation: 'upsert' | 'archive';
  readonly value: {
    readonly item: Pick<
      UpdateMutationResult['item'],
      'id' | 'displayId' | 'revision' | 'key' | 'kind' | 'title'
    >;
  };
  readonly event?: UpdateMutationResult['event'];
  readonly noOp: boolean;
}
export interface UpdateToolFailure {
  readonly ok: false;
  readonly error: SignalBoardError;
}
export type UpdateToolDetails = UpdateToolSuccess | UpdateToolFailure;

export const UPDATE_TOOL_DESCRIPTION =
  'create, revise, or archive a durable significant board update.';
export const UPDATE_TOOL_PROMPT_SNIPPET =
  'Post or revise a durable Signal Board milestone, finding, warning, blocker, failure, or completion.';
export const UPDATE_TOOL_PROMPT_GUIDELINES = [
  'Use signal_board_update only for durable milestones, material findings, warnings, blockers, failures, and completion.',
  'Use the same signal_board_update key to revise one workstream instead of posting routine activity.',
  'Do not use signal_board_update for reads, commands, or narration.',
  'Use signal_board_update measurable progress only when current and total are known.',
];

export class PendingToolFailures {
  readonly #values = new Map<string, UpdateToolFailure>();
  readonly #capacity: number;
  constructor(capacity = 100) {
    this.#capacity = capacity;
  }
  set(id: string, failure: UpdateToolFailure): void {
    if (!this.#values.has(id) && this.#values.size >= this.#capacity) {
      const oldest = this.#values.keys().next().value;
      if (oldest !== undefined) this.#values.delete(oldest);
    }
    this.#values.set(id, failure);
  }
  take(id: string): UpdateToolFailure | undefined {
    const value = this.#values.get(id);
    this.#values.delete(id);
    return value;
  }
  clear(): void {
    this.#values.clear();
  }
  has(id: string): boolean {
    return this.#values.has(id);
  }
  get size(): number {
    return this.#values.size;
  }
}

export function registerUpdateTool(
  pi: ExtensionAPI,
  lifecycle: RuntimeLifecycle,
  pending: PendingToolFailures,
): void {
  pi.registerTool({
    name: UPDATE_TOOL_NAME,
    label: 'Signal Board Update',
    description: UPDATE_TOOL_DESCRIPTION,
    promptSnippet: UPDATE_TOOL_PROMPT_SNIPPET,
    promptGuidelines: UPDATE_TOOL_PROMPT_GUIDELINES,
    parameters: UPDATE_TOOL_PARAMETERS,
    async execute(toolCallId, input) {
      try {
        const runtime = lifecycle.slot.requireHealthyLocked();
        if (!runtime.ok) {
          const code =
            runtime.error.code === 'SB_DISABLED' ? 'SB_CONFIG_DISABLED' : runtime.error.code;
          return throwFailure(toolCallId, publicError(code), pending);
        }
        const service = runtime.value.updateService;
        if (service === undefined)
          return throwFailure(toolCallId, publicError('SB_NOT_INITIALIZED'), pending);
        const commandId = `tool:${toolCallId}` as const;
        const result =
          input.operation === 'upsert'
            ? await service.upsertUpdate({ ...input, commandId } as UpsertUpdateCommand)
            : await service.archiveUpdate({ ...input, commandId } as ArchiveUpdateCommand);
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
      const identity = safeInline(
        input.id ?? input.key ?? ('title' in input ? input.title : undefined),
        18,
      );
      component.setText(
        truncateToWidth(
          `${theme.fg('toolTitle', theme.bold(UPDATE_TOOL_NAME))} ${theme.fg('muted', input.operation)}${identity ? ` ${theme.fg('dim', identity)}` : ''}`,
          240,
        ),
      );
      return component;
    },
    renderResult(result, options, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
      const details = result.details as UpdateToolDetails | undefined;
      if (!details || typeof details !== 'object' || !('ok' in details)) {
        component.setText(
          theme.fg('error', 'ERROR SB_INTERNAL Signal Board result details are unavailable.'),
        );
      } else if (!details.ok) {
        component.setText(
          theme.fg('error', `ERROR ${details.error.code} ${safeInline(details.error.message, 65)}`),
        );
      } else {
        const item = details.value.item;
        const first = `OK ${details.operation} ${safeInline(item.displayId, 8)}/${safeInline(item.id, 12)} rev ${item.revision}${details.noOp ? ' no-op' : ''}`;
        const second = `${safeInline(item.kind, 10)} ${safeInline(item.title, 34)}`;
        let text = `${theme.fg('success', first)}\n${theme.fg('muted', second)}`;
        if (options.expanded) {
          text += `\n${theme.fg('dim', `id ${safeInline(item.id, 64)} revision ${item.revision}`)}`;
          if (details.event?.eventType === 'update.upserted') {
            text += `\n${theme.fg('dim', `attachments ${details.event.payload.fields.attachments.length}`)}`;
          }
        }
        component.setText(text);
      }
      return component;
    },
  });
}

export function patchPendingToolFailure(event: ToolResultEvent, pending: PendingToolFailures) {
  if (
    event.toolName !== UPDATE_TOOL_NAME &&
    event.toolName !== QUESTION_TOOL_NAME &&
    event.toolName !== ACK_TOOL_NAME
  ) {
    return undefined;
  }
  const failure = pending.take(event.toolCallId);
  if (failure === undefined) return undefined;
  return {
    content: [
      { type: 'text' as const, text: `ERROR ${failure.error.code}: ${failure.error.message}` },
    ],
    details: failure,
    isError: true,
  };
}

function throwFailure(id: string, error: SignalBoardError, pending: PendingToolFailures): never {
  pending.set(id, Object.freeze({ ok: false, error }));
  throw new Error(`Signal Board tool failed (${error.code}).`);
}
function publicError(
  code: 'SB_NOT_INITIALIZED' | 'SB_UNSUPPORTED_HOST' | 'SB_CONFIG_DISABLED' | 'SB_INTERNAL',
): SignalBoardError {
  const definition = ERROR_DEFINITIONS[code];
  return Object.freeze({ code, message: definition.message, retryable: definition.retryable });
}
function successDetails(
  operation: 'upsert' | 'archive',
  result: UpdateMutationResult,
): UpdateToolSuccess {
  const item = result.item;
  return Object.freeze({
    ok: true,
    operation,
    value: {
      item: Object.freeze({
        id: item.id,
        displayId: item.displayId,
        revision: item.revision,
        ...(item.key === undefined ? {} : { key: item.key }),
        kind: item.kind,
        title: item.title,
      }),
    },
    ...(result.event === undefined ? {} : { event: result.event }),
    noOp: result.noOp,
  });
}
function successText(details: UpdateToolSuccess): string {
  const item = details.value.item;
  return `OK ${details.operation} ${item.displayId}/${item.id} revision ${item.revision} ${item.kind}: ${item.title}${details.noOp ? ' (no-op)' : ''}`;
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

export type { Attachment, MeasurableProgress, UpdateKind, UpdateStage };
