import type { BoardEvent, BoardEventActor, BoardEventType } from './events.js';
import type { AnswerValue, Attachment, QuestionSpec, ResponseSpec, UpdateFields } from './types.js';

const ACTORS = Object.freeze({
  'update.upserted': Object.freeze(['agent'] as const),
  'update.archived': Object.freeze(['agent', 'user'] as const),
  'question.created': Object.freeze(['agent'] as const),
  'question.revised': Object.freeze(['agent'] as const),
  'question.cancelled': Object.freeze(['agent'] as const),
  'question.escalated': Object.freeze(['system'] as const),
  'question.staled': Object.freeze(['system'] as const),
  'question.dismissed': Object.freeze(['user'] as const),
  'question.answered': Object.freeze(['user'] as const),
  'answer.delivery_queued': Object.freeze(['system'] as const),
  'answer.delivery_failed': Object.freeze(['system'] as const),
  'answer.acknowledged': Object.freeze(['agent'] as const),
  'board.viewed': Object.freeze(['user'] as const),
  'board.reset': Object.freeze(['user'] as const),
} satisfies Readonly<Record<BoardEventType, readonly BoardEventActor[]>>);

const EVENT_TYPES = new Set<string>(Object.keys(ACTORS));
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const UPDATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function hasValidEnvelope(event: unknown): event is BoardEvent {
  if (!isRecord(event)) return false;
  const type = event.eventType;
  if (event.schemaVersion !== 1 || typeof type !== 'string' || !EVENT_TYPES.has(type)) return false;
  if (
    typeof event.eventId !== 'string' ||
    typeof event.commandId !== 'string' ||
    !isFiniteUtcTimestamp(event.occurredAt) ||
    typeof event.actor !== 'string' ||
    !isRecord(event.payload)
  )
    return false;
  const allowed = ACTORS[type as BoardEventType] as readonly BoardEventActor[];
  return allowed.includes(event.actor as BoardEventActor);
}

/** Stable JSON form. It rejects cycles and unsupported mutable values. */
export function canonicalize(value: unknown): string | undefined {
  const active = new Set<object>();
  const visit = (item: unknown): string | undefined => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : undefined;
    if (Array.isArray(item)) {
      if (active.has(item)) return undefined;
      active.add(item);
      const values: string[] = [];
      for (const child of item) {
        const encoded = visit(child);
        if (encoded === undefined) return undefined;
        values.push(encoded);
      }
      active.delete(item);
      return `[${values.join(',')}]`;
    }
    if (!isRecord(item)) return undefined;
    if (active.has(item)) return undefined;
    active.add(item);
    const entries: string[] = [];
    for (const key of Object.keys(item).sort()) {
      const child = item[key];
      if (child === undefined) continue;
      const encoded = visit(child);
      if (encoded === undefined) return undefined;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    active.delete(item);
    return `{${entries.join(',')}}`;
  };
  return visit(value);
}

export function eventFingerprint(event: BoardEvent): string | undefined {
  return canonicalize(event);
}

export function commandFingerprint(event: BoardEvent): string | undefined {
  return canonicalize({ eventType: event.eventType, payload: event.payload });
}

export function validUpdateFields(fields: UpdateFields, completedAt?: string): boolean {
  if (
    !isRecord(fields) ||
    typeof fields.title !== 'string' ||
    fields.title.length === 0 ||
    typeof fields.kind !== 'string' ||
    !['working', 'finding', 'warning', 'blocked', 'completed', 'failed'].includes(fields.kind) ||
    !Array.isArray(fields.attachments) ||
    !validAttachments(fields.attachments)
  )
    return false;
  if (fields.key !== undefined && (typeof fields.key !== 'string' || !UPDATE_KEY.test(fields.key)))
    return false;
  if (
    fields.stage !== undefined &&
    !['discovering', 'implementing', 'testing', 'validating', 'complete'].includes(fields.stage)
  )
    return false;
  if (fields.progress !== undefined) {
    const progress = fields.progress;
    if (
      !isRecord(progress) ||
      typeof progress.current !== 'number' ||
      typeof progress.total !== 'number' ||
      !Number.isFinite(progress.current) ||
      !Number.isFinite(progress.total) ||
      progress.current < 0 ||
      progress.total <= 0 ||
      progress.current > progress.total ||
      (progress.unit !== undefined &&
        (typeof progress.unit !== 'string' || progress.unit.length === 0))
    )
      return false;
  }
  const terminal = fields.kind === 'completed' || fields.kind === 'failed';
  if (terminal !== (completedAt !== undefined)) return false;
  return fields.kind !== 'completed' || fields.stage === undefined || fields.stage === 'complete';
}

export function validQuestionSpec(spec: QuestionSpec): boolean {
  if (
    !isRecord(spec) ||
    typeof spec.question !== 'string' ||
    spec.question.length === 0 ||
    typeof spec.reason !== 'string' ||
    spec.reason.length === 0 ||
    spec.class === 'authorization' ||
    !['preference', 'information', 'reversible'].includes(spec.class) ||
    !validResponse(spec.response) ||
    !Array.isArray(spec.recommendedOptionIds) ||
    !uniqueStrings(spec.recommendedOptionIds) ||
    !['normal', 'high'].includes(spec.priority) ||
    !['never', 'when_agent_settles'].includes(spec.blockingPolicy) ||
    !['steer', 'followUp', 'nextTurn'].includes(spec.deliveryMode) ||
    !uniqueStrings(spec.affectedWork) ||
    !uniqueStrings(spec.continuingWork) ||
    !validAttachments(spec.attachments) ||
    (spec.expiresAt !== undefined && !isFiniteUtcTimestamp(spec.expiresAt))
  )
    return false;
  const options = spec.response.options ?? [];
  const optionIds = new Set(options.map((option) => option.id));
  if (!spec.recommendedOptionIds.every((id) => optionIds.has(id))) return false;
  const single = spec.response.kind === 'single' || spec.response.kind === 'single_or_text';
  if (single && spec.recommendedOptionIds.length > 1) return false;
  const allowsText = spec.response.kind === 'text' || spec.response.kind.endsWith('_or_text');
  if (
    spec.recommendedText !== undefined &&
    (!allowsText || spec.recommendedText.trim().length === 0)
  )
    return false;
  if (spec.temporaryDefault !== undefined) {
    if (spec.class !== 'reversible' || spec.response.kind === 'text') return false;
    if (
      !uniqueStrings(spec.temporaryDefault.optionIds) ||
      spec.temporaryDefault.optionIds.length === 0
    )
      return false;
    if (!spec.temporaryDefault.optionIds.every((id) => optionIds.has(id))) return false;
    if (single && spec.temporaryDefault.optionIds.length !== 1) return false;
    if (
      typeof spec.temporaryDefault.disclosure !== 'string' ||
      spec.temporaryDefault.disclosure.length === 0
    )
      return false;
  }
  return true;
}

function validResponse(response: ResponseSpec): boolean {
  if (!isRecord(response) || typeof response.kind !== 'string') return false;
  const options = response.options ?? [];
  if (!Array.isArray(options)) return false;
  if (response.kind === 'text') return options.length === 0;
  if (!['single', 'multiple', 'single_or_text', 'multiple_or_text'].includes(response.kind))
    return false;
  if (options.length < 2 || options.length > 8) return false;
  const ids = new Set<string>();
  for (const option of options) {
    if (
      !isRecord(option) ||
      typeof option.id !== 'string' ||
      !OPTION_ID.test(option.id) ||
      ids.has(option.id)
    )
      return false;
    if (typeof option.label !== 'string' || option.label.length === 0) return false;
    ids.add(option.id);
  }
  return true;
}

export function validAnswerValue(value: AnswerValue, spec: QuestionSpec): boolean {
  if (!isRecord(value) || value.kind !== spec.response.kind) return false;
  const options = spec.response.options ?? [];
  const order = new Map<string, number>(options.map((option, index) => [option.id, index]));
  const validText = (text: unknown): text is string =>
    typeof text === 'string' && text.trim() === text && text.length > 0;
  const validIds = (ids: unknown, requireOne: boolean): ids is readonly string[] => {
    if (!Array.isArray(ids) || (requireOne && ids.length === 0)) return false;
    if (!uniqueStrings(ids) || !ids.every((id) => order.has(id))) return false;
    return ids.every(
      (id, index) =>
        index === 0 || (order.get(ids[index - 1] as string) as number) < (order.get(id) as number),
    );
  };
  const candidate = value as AnswerValue;
  switch (candidate.kind) {
    case 'single':
      return typeof candidate.optionId === 'string' && order.has(candidate.optionId);
    case 'multiple':
      return validIds(candidate.optionIds, true);
    case 'text':
      return validText(candidate.text);
    case 'single_or_text':
      return (
        (candidate.optionId === undefined ||
          (typeof candidate.optionId === 'string' && order.has(candidate.optionId))) &&
        (candidate.text === undefined || validText(candidate.text)) &&
        (candidate.optionId !== undefined || candidate.text !== undefined)
      );
    case 'multiple_or_text':
      return (
        validIds(candidate.optionIds, false) &&
        (candidate.text === undefined || validText(candidate.text)) &&
        (candidate.optionIds.length > 0 || candidate.text !== undefined)
      );
    default:
      return false;
  }
}

export function answerMatchesRecommendation(value: AnswerValue, spec: QuestionSpec): boolean {
  if (spec.recommendedOptionIds.length === 0 && spec.recommendedText === undefined) return false;
  switch (value.kind) {
    case 'single':
      return (
        spec.recommendedOptionIds.length === 1 &&
        value.optionId === spec.recommendedOptionIds[0] &&
        spec.recommendedText === undefined
      );
    case 'multiple':
      return (
        sameStrings(value.optionIds, spec.recommendedOptionIds) &&
        spec.recommendedText === undefined
      );
    case 'text':
      return spec.recommendedOptionIds.length === 0 && value.text === spec.recommendedText;
    case 'single_or_text':
      return (
        (value.optionId ?? undefined) === spec.recommendedOptionIds[0] &&
        spec.recommendedOptionIds.length <= 1 &&
        value.text === spec.recommendedText
      );
    case 'multiple_or_text':
      return (
        sameStrings(value.optionIds, spec.recommendedOptionIds) &&
        value.text === spec.recommendedText
      );
    default:
      return false;
  }
}

export function validAttachments(attachments: readonly Attachment[]): boolean {
  if (!Array.isArray(attachments) || attachments.length > 10) return false;
  return attachments.every((attachment) => {
    if (
      !isRecord(attachment) ||
      typeof attachment.kind !== 'string' ||
      typeof attachment.label !== 'string' ||
      attachment.label.length === 0
    )
      return false;
    switch (attachment.kind) {
      case 'file':
        return typeof attachment.path === 'string' && attachment.path.length > 0;
      case 'line_range':
        return (
          typeof attachment.path === 'string' &&
          attachment.path.length > 0 &&
          isPositiveSafeInteger(attachment.startLine) &&
          isPositiveSafeInteger(attachment.endLine) &&
          attachment.endLine >= attachment.startLine
        );
      case 'test_run':
      case 'command':
        return typeof attachment.reference === 'string' && attachment.reference.length > 0;
      case 'url': {
        if (typeof attachment.url !== 'string') return false;
        try {
          return ['http:', 'https:'].includes(new URL(attachment.url).protocol);
        } catch {
          return false;
        }
      }
      case 'note':
        return typeof attachment.text === 'string' && attachment.text.length > 0;
      default:
        return false;
    }
  });
}

export function sameSemanticValue(left: unknown, right: unknown): boolean {
  const leftValue = canonicalize(left);
  return leftValue !== undefined && leftValue === canonicalize(right);
}

function uniqueStrings(values: readonly unknown[]): values is readonly string[] {
  return (
    Array.isArray(values) &&
    values.every((value) => typeof value === 'string' && value.length > 0) &&
    new Set(values).size === values.length
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
