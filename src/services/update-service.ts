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
import type { UpdateArchivedEvent, UpdateUpsertedEvent } from '../domain/events.js';
import type { CommandId, EventId, IdGenerator, ToolCommandId, UpdateId } from '../domain/ids.js';
import { isCommandId, isUpdateId, updateDisplayId } from '../domain/ids.js';
import { sameSemanticValue } from '../domain/invariants.js';
import { reduceBoardEvent } from '../domain/reducer.js';
import { sanitizeText, TEXT_FIELD_POLICIES } from '../domain/sanitization.js';
import type {
  Attachment,
  BoardState,
  MeasurableProgress,
  UpdateFields,
  UpdateItem,
  UpdateKind,
  UpdateStage,
} from '../domain/types.js';
import type { MutationQueue } from './mutation-queue.js';
import type { TurnUpdateRateCounter } from './update-rate-counter.js';

const UPDATE_KINDS = new Set<UpdateKind>([
  'working',
  'finding',
  'warning',
  'blocked',
  'completed',
  'failed',
]);
const UPDATE_STAGES = new Set<UpdateStage>([
  'discovering',
  'implementing',
  'testing',
  'validating',
  'complete',
]);
const DISPLAY_ID = /^U-[1-9][0-9]*$/u;
const UPDATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

type UpdateEvent = UpdateUpsertedEvent | UpdateArchivedEvent;

export interface UpsertUpdateCommand {
  readonly commandId: ToolCommandId;
  readonly id?: string;
  readonly key?: string;
  readonly kind?: UpdateKind;
  readonly title?: string;
  readonly detail?: string | null;
  readonly stage?: UpdateStage | null;
  readonly progress?: MeasurableProgress | null;
  readonly attachments?: readonly Attachment[];
}

export interface ArchiveUpdateCommand {
  readonly commandId: ToolCommandId;
  readonly id?: string;
  readonly key?: string;
  readonly expectedRevision?: number;
}

export interface UpdateMutationResult {
  readonly item: UpdateItem;
  /** Present for accepted mutations and exact accepted-command retries. */
  readonly event?: UpdateEvent;
  readonly noOp: boolean;
}

export interface UpdateServiceDependencies {
  readonly queue: MutationQueue;
  readonly readState: () => BoardState;
  readonly swapState: (state: BoardState) => void;
  readonly append: (event: UpdateEvent) => Promise<Result<void>>;
  readonly refresh: (state: BoardState) => void | Promise<void>;
  /** Runs after a durable state refresh while the shared queue remains held. */
  readonly afterMutationLocked?: () => void | Promise<void>;
  readonly clock: Clock;
  /** One generator owned by the current runtime. */
  readonly ids: Pick<IdGenerator, 'event' | 'update'>;
  readonly cwd: string;
  readonly config: Pick<EffectiveConfig, 'limits'>;
  readonly rateCounter: TurnUpdateRateCounter;
}

interface LookupInput {
  readonly id?: string;
  readonly key?: string;
}

interface LookupResult {
  readonly byId?: UpdateItem;
  readonly byKey?: UpdateItem;
  readonly existing?: UpdateItem;
}

/** Durable update mutation service. Tool registration and rendering are separate. */
export class UpdateService {
  readonly #dependencies: UpdateServiceDependencies;
  #reservedEventId: EventId | undefined;
  #reservedUpdateId: UpdateId | undefined;

  constructor(dependencies: UpdateServiceDependencies) {
    this.#dependencies = dependencies;
  }

  upsertUpdate(command: UpsertUpdateCommand): Promise<Result<UpdateMutationResult>> {
    return this.#dependencies.queue.run(() => this.#upsertLocked(command));
  }

  archiveUpdate(command: ArchiveUpdateCommand): Promise<Result<UpdateMutationResult>> {
    return this.#dependencies.queue.run(() => this.#archiveLocked(command));
  }

  async #upsertLocked(command: UpsertUpdateCommand): Promise<Result<UpdateMutationResult>> {
    const commandError = validateToolCommandId(command.commandId);
    if (commandError !== undefined) return commandError;

    const key = normalizeOptionalKey(command.key);
    if (!key.ok) return key;
    const state = this.#dependencies.readState();
    const prior = state.commandResults.get(command.commandId);
    if (prior !== undefined) return this.#resolvePriorUpsert(command, key.value, prior);

    const lookup = resolveLookup(state, {
      ...(command.id === undefined ? {} : { id: command.id }),
      ...(key.value === undefined ? {} : { key: key.value }),
    });
    if (!lookup.ok) return lookup;
    const existing = lookup.value.existing;
    if (existing?.archived === true) return fail(signalBoardError('SB_STATE_CONFLICT'));

    const fields = this.#normalizeFields(command, existing, key.value);
    if (!fields.ok) return fields;
    if (existing !== undefined && sameSemanticValue(updateSemantic(existing), fields.value)) {
      return succeed(frozenResult(existing, undefined, true));
    }

    if (
      existing === undefined &&
      activeUpdateCount(state) >= this.#dependencies.config.limits.maxActiveUpdates
    ) {
      return fail(signalBoardError('SB_LIMIT_EXCEEDED'));
    }
    const rate = this.#dependencies.rateCounter.check(
      this.#dependencies.config.limits.maxUpdateMutationsPerTurn,
    );
    if (!rate.ok) return rate;

    let occurredAt: string;
    let eventId: EventId;
    let updateId: UpdateId;
    try {
      occurredAt = utcNow(this.#dependencies.clock);
      eventId = this.#reserveEventId();
      updateId = existing?.id ?? this.#reserveUpdateId();
    } catch {
      return fail(internalError());
    }
    const terminal = fields.value.kind === 'completed' || fields.value.kind === 'failed';
    const event: UpdateUpsertedEvent = {
      schemaVersion: 1,
      eventId,
      eventType: 'update.upserted',
      occurredAt,
      actor: 'agent',
      commandId: command.commandId,
      payload: {
        updateId,
        displayId: existing?.displayId ?? updateDisplayId(state.counters.nextUpdate),
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? occurredAt,
        updatedAt: occurredAt,
        ...(terminal ? { completedAt: occurredAt } : {}),
        fields: fields.value,
      },
    };
    return this.#persistLocked(state, event, existing === undefined);
  }

  async #archiveLocked(command: ArchiveUpdateCommand): Promise<Result<UpdateMutationResult>> {
    const commandError = validateToolCommandId(command.commandId);
    if (commandError !== undefined) return commandError;
    if (command.id === undefined && command.key === undefined) {
      return invalid('id', 'required');
    }
    if (
      command.expectedRevision !== undefined &&
      (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)
    ) {
      return invalid('expectedRevision', 'out_of_range');
    }

    const key = normalizeOptionalKey(command.key);
    if (!key.ok) return key;
    const state = this.#dependencies.readState();
    const prior = state.commandResults.get(command.commandId);
    if (prior !== undefined) return this.#resolvePriorArchive(state, command, key.value, prior);

    const lookup = resolveLookup(state, {
      ...(command.id === undefined ? {} : { id: command.id }),
      ...(key.value === undefined ? {} : { key: key.value }),
    });
    if (!lookup.ok) return lookup;
    const existing = lookup.value.existing;
    if (existing === undefined) return fail(signalBoardError('SB_NOT_FOUND'));
    if (existing.archived) return succeed(frozenResult(existing, undefined, true));
    if (command.expectedRevision !== undefined && command.expectedRevision !== existing.revision) {
      return fail(signalBoardError('SB_REVISION_MISMATCH'));
    }

    const rate = this.#dependencies.rateCounter.check(
      this.#dependencies.config.limits.maxUpdateMutationsPerTurn,
    );
    if (!rate.ok) return rate;

    let occurredAt: string;
    let eventId: EventId;
    try {
      occurredAt = utcNow(this.#dependencies.clock);
      eventId = this.#reserveEventId();
    } catch {
      return fail(internalError());
    }
    const event: UpdateArchivedEvent = {
      schemaVersion: 1,
      eventId,
      eventType: 'update.archived',
      occurredAt,
      actor: 'agent',
      commandId: command.commandId,
      payload: {
        updateId: existing.id,
        expectedRevision: existing.revision,
        revision: existing.revision + 1,
        archivedAt: occurredAt,
      },
    };
    return this.#persistLocked(state, event, false);
  }

  async #persistLocked(
    state: BoardState,
    event: UpdateEvent,
    createdUpdate: boolean,
  ): Promise<Result<UpdateMutationResult>> {
    const reduced = reduceBoardEvent(state, event);
    if (!reduced.ok) return fail(signalBoardError(reduced.code));
    if (reduced.idempotent) return fail(signalBoardError('SB_STATE_CONFLICT'));

    let appended: Result<void>;
    try {
      appended = await this.#dependencies.append(event);
    } catch {
      return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
    }
    if (!appended.ok) return appended;

    this.#dependencies.swapState(reduced.state);
    this.#dependencies.rateCounter.commit();
    this.#reservedEventId = undefined;
    if (createdUpdate) this.#reservedUpdateId = undefined;

    let refreshFailed = false;
    try {
      await this.#dependencies.refresh(reduced.state);
    } catch {
      refreshFailed = true;
    }
    try {
      await this.#dependencies.afterMutationLocked?.();
    } catch {
      // The accepted update remains durable and exposed. Lifecycle diagnostics own the error.
    }
    if (refreshFailed) return fail(signalBoardError('SB_UI_UNAVAILABLE'));

    const item = reduced.state.updates.get(event.payload.updateId);
    if (item === undefined) return fail(internalError());
    return succeed(frozenResult(item, event, false));
  }

  #normalizeFields(
    command: UpsertUpdateCommand,
    existing: UpdateItem | undefined,
    key: string | undefined,
  ): Result<UpdateFields> {
    const kind = command.kind ?? existing?.kind;
    if (kind === undefined) return invalid('kind', 'required');
    if (!UPDATE_KINDS.has(kind)) return invalid('kind', 'unsupported');

    const titleInput = command.title ?? existing?.title;
    if (titleInput === undefined) return invalid('title', 'required');
    const title = sanitizeRequired(titleInput, TEXT_FIELD_POLICIES.updateTitle, 'title');
    if (!title.ok) return title;

    let detail = existing?.detail;
    if (command.detail === null) detail = undefined;
    else if (command.detail !== undefined) {
      const normalized = sanitizeRequired(
        command.detail,
        TEXT_FIELD_POLICIES.updateDetail,
        'detail',
      );
      if (!normalized.ok) return normalized;
      detail = normalized.value;
    }

    let stage = existing?.stage;
    if (command.stage === null) stage = undefined;
    else if (command.stage !== undefined) {
      if (!UPDATE_STAGES.has(command.stage)) return invalid('stage', 'unsupported');
      stage = command.stage;
    }
    if (kind === 'completed') {
      if (stage !== undefined && stage !== 'complete') return invalid('stage', 'invalid_value');
      stage = 'complete';
    }

    let progress = existing?.progress;
    if (command.progress === null) progress = undefined;
    else if (command.progress !== undefined) {
      const normalized = normalizeProgress(command.progress);
      if (!normalized.ok) return normalized;
      progress = normalized.value;
    }

    let attachments = existing?.attachments ?? Object.freeze([] as Attachment[]);
    if (command.attachments !== undefined) {
      const normalized = normalizeAttachments(command.attachments, this.#dependencies.cwd);
      if (!normalized.ok) return normalized;
      attachments = normalized.value;
    }

    return succeed(
      freezeCopy({
        ...((key ?? existing?.key) === undefined ? {} : { key: key ?? existing?.key }),
        kind,
        title: title.value,
        ...(detail === undefined ? {} : { detail }),
        ...(stage === undefined ? {} : { stage }),
        ...(progress === undefined ? {} : { progress }),
        attachments,
      }) as UpdateFields,
    );
  }

  #resolvePriorUpsert(
    command: UpsertUpdateCommand,
    key: string | undefined,
    prior: BoardState['commandResults'] extends ReadonlyMap<CommandId, infer Value> ? Value : never,
  ): Result<UpdateMutationResult> {
    if (prior.eventType !== 'update.upserted') return fail(signalBoardError('SB_STATE_CONFLICT'));
    const payload = prior.semanticPayload as UpdateUpsertedEvent['payload'];
    const priorItem = itemFromUpsert(payload, prior.eventId, command.commandId);
    if (!lookupMatchesPrior(command.id, key, priorItem)) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    const fields = this.#normalizeFields(command, priorItem, key);
    if (!fields.ok) return fields;
    if (!sameSemanticValue(fields.value, payload.fields)) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    const event = upsertEventFromPrior(command.commandId, prior.eventId, payload);
    return succeed(frozenResult(priorItem, event, true));
  }

  #resolvePriorArchive(
    state: BoardState,
    command: ArchiveUpdateCommand,
    key: string | undefined,
    prior: BoardState['commandResults'] extends ReadonlyMap<CommandId, infer Value> ? Value : never,
  ): Result<UpdateMutationResult> {
    if (prior.eventType !== 'update.archived') return fail(signalBoardError('SB_STATE_CONFLICT'));
    const payload = prior.semanticPayload as UpdateArchivedEvent['payload'];
    const current = state.updates.get(payload.updateId);
    if (
      current === undefined ||
      !lookupMatchesPrior(command.id, key, current) ||
      (command.expectedRevision !== undefined &&
        command.expectedRevision !== payload.expectedRevision)
    ) {
      return fail(signalBoardError('SB_STATE_CONFLICT'));
    }
    const event = archiveEventFromPrior(command.commandId, prior.eventId, payload);
    return succeed(frozenResult(current, event, true));
  }

  #reserveEventId(): EventId {
    this.#reservedEventId ??= this.#dependencies.ids.event();
    return this.#reservedEventId;
  }

  #reserveUpdateId(): UpdateId {
    this.#reservedUpdateId ??= this.#dependencies.ids.update();
    return this.#reservedUpdateId;
  }
}

function resolveLookup(state: BoardState, input: LookupInput): Result<LookupResult> {
  let byId: UpdateItem | undefined;
  if (input.id !== undefined) {
    if (!isUpdateId(input.id) && !DISPLAY_ID.test(input.id)) return invalid('id', 'invalid_value');
    byId = isUpdateId(input.id)
      ? state.updates.get(input.id)
      : [...state.updates.values()].find((item) => item.displayId === input.id);
  }
  const keyMatches =
    input.key === undefined
      ? []
      : [...state.updates.values()].filter((item) => !item.archived && item.key === input.key);
  if (keyMatches.length > 1) return fail(signalBoardError('SB_STATE_CONFLICT'));
  const byKey = keyMatches[0];
  if (byId !== undefined && byKey !== undefined && byId.id !== byKey.id) {
    return fail(signalBoardError('SB_STATE_CONFLICT'));
  }
  const existing = byId ?? byKey;
  return succeed({
    ...(byId === undefined ? {} : { byId }),
    ...(byKey === undefined ? {} : { byKey }),
    ...(existing === undefined ? {} : { existing }),
  });
}

function normalizeOptionalKey(value: string | undefined): Result<string | undefined> {
  if (value === undefined) return succeed(undefined);
  if (typeof value !== 'string') return invalid('key', 'invalid_type');
  const sanitized = sanitizeText(value, TEXT_FIELD_POLICIES.updateKey);
  if (!sanitized.ok) return invalid('key', textReason(sanitized.reason));
  if (!UPDATE_KEY.test(sanitized.value)) return invalid('key', 'invalid_value');
  return succeed(sanitized.value);
}

function normalizeProgress(value: MeasurableProgress): Result<MeasurableProgress> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('progress', 'invalid_type');
  }
  if (typeof value.current !== 'number' || !Number.isFinite(value.current)) {
    return invalid('progress.current', 'invalid_value');
  }
  if (typeof value.total !== 'number' || !Number.isFinite(value.total)) {
    return invalid('progress.total', 'invalid_value');
  }
  if (value.current < 0 || value.current > value.total) {
    return invalid('progress.current', 'out_of_range');
  }
  if (value.total <= 0) return invalid('progress.total', 'out_of_range');
  let unit: string | undefined;
  if (value.unit !== undefined) {
    if (typeof value.unit !== 'string') return invalid('progress.unit', 'invalid_type');
    const normalized = sanitizeText(value.unit, TEXT_FIELD_POLICIES.progressUnit);
    if (!normalized.ok) return invalid('progress.unit', textReason(normalized.reason));
    unit = normalized.value;
  }
  return succeed(
    freezeCopy({ current: value.current, total: value.total, ...(unit ? { unit } : {}) }),
  );
}

function sanitizeRequired(
  value: string,
  policy: (typeof TEXT_FIELD_POLICIES)[keyof typeof TEXT_FIELD_POLICIES],
  path: string,
): Result<string> {
  if (typeof value !== 'string') return invalid(path, 'invalid_type');
  const normalized = sanitizeText(value, policy);
  return normalized.ok ? succeed(normalized.value) : invalid(path, textReason(normalized.reason));
}

function validateToolCommandId(commandId: string): Result<never> | undefined {
  return isCommandId(commandId) && commandId.startsWith('tool:')
    ? undefined
    : invalid('commandId', 'invalid_value');
}

function lookupMatchesPrior(
  id: string | undefined,
  key: string | undefined,
  item: UpdateItem,
): boolean {
  const idMatches = id === undefined || id === item.id || id === item.displayId;
  const keyMatches = key === undefined || key === item.key;
  return idMatches && keyMatches;
}

function updateSemantic(item: UpdateItem): UpdateFields {
  return {
    ...(item.key === undefined ? {} : { key: item.key }),
    kind: item.kind,
    title: item.title,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.stage === undefined ? {} : { stage: item.stage }),
    ...(item.progress === undefined ? {} : { progress: item.progress }),
    attachments: item.attachments,
  };
}

function itemFromUpsert(
  payload: UpdateUpsertedEvent['payload'],
  eventId: EventId,
  commandId: CommandId,
): UpdateItem {
  return freezeCopy({
    ...payload.fields,
    id: payload.updateId,
    displayId: payload.displayId,
    revision: payload.revision,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    ...(payload.completedAt === undefined ? {} : { completedAt: payload.completedAt }),
    archived: false,
    lastEventId: eventId,
    lastCommandId: commandId,
  });
}

function upsertEventFromPrior(
  commandId: CommandId,
  eventId: EventId,
  payload: UpdateUpsertedEvent['payload'],
): UpdateUpsertedEvent {
  return freezeCopy({
    schemaVersion: 1,
    eventId,
    eventType: 'update.upserted',
    occurredAt: payload.updatedAt,
    actor: 'agent',
    commandId,
    payload,
  });
}

function archiveEventFromPrior(
  commandId: CommandId,
  eventId: EventId,
  payload: UpdateArchivedEvent['payload'],
): UpdateArchivedEvent {
  return freezeCopy({
    schemaVersion: 1,
    eventId,
    eventType: 'update.archived',
    occurredAt: payload.archivedAt,
    actor: 'agent',
    commandId,
    payload,
  });
}

function activeUpdateCount(state: BoardState): number {
  return [...state.updates.values()].filter((item) => !item.archived).length;
}

function frozenResult(
  item: UpdateItem,
  event: UpdateEvent | undefined,
  noOp: boolean,
): UpdateMutationResult {
  return freezeCopy({ item, ...(event === undefined ? {} : { event }), noOp });
}

function textReason(reason: string): 'required' | 'too_long' | 'invalid_value' {
  if (reason === 'empty') return 'required';
  if (reason === 'too_long') return 'too_long';
  return 'invalid_value';
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
  const definition = ERROR_DEFINITIONS.SB_INTERNAL;
  return Object.freeze({
    code: 'SB_INTERNAL' as const,
    message: definition.message,
    retryable: definition.retryable,
  });
}

function freezeCopy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeCopy(item))) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = freezeCopy(child);
  return Object.freeze(copy) as T;
}
