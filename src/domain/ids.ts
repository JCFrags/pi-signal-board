import { randomUUID } from 'node:crypto';

export type UpdateId = `upd_${string}`;
export type QuestionId = `qst_${string}`;
export type AnswerId = `ans_${string}`;
export type EventId = `evt_${string}`;
export type ToolCommandId = `tool:${string}`;
export type UiCommandId = `ui:${string}`;
export type SystemCommandId = `system:${string}`;
export type CommandId = ToolCommandId | UiCommandId | SystemCommandId;
export type UpdateDisplayId = `U-${number}`;
export type QuestionDisplayId = `Q-${number}`;
export type DecisionDisplayId = `D-${number}`;

export interface IdGenerator {
  event(): EventId;
  update(): UpdateId;
  question(): QuestionId;
  answer(): AnswerId;
  command(): UiCommandId;
}

export interface UuidSource {
  nextUuid(): string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UPDATE_ID_PATTERN = /^upd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const QUESTION_ID_PATTERN = /^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ANSWER_ID_PATTERN = /^ans_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMAND_ID_PATTERN =
  /^(?:tool:[A-Za-z0-9._:|-]{1,240}|(?:ui|system):[A-Za-z0-9._:-]{1,240})$/u;
const UPDATE_DISPLAY_ID_PATTERN = /^U-[1-9][0-9]*$/u;
const QUESTION_DISPLAY_ID_PATTERN = /^Q-[1-9][0-9]*$/u;
const DECISION_DISPLAY_ID_PATTERN = /^D-[1-9][0-9]*$/u;
const MAX_UNIQUE_ID_ATTEMPTS = 128;

class CryptoUuidSource implements UuidSource {
  nextUuid(): string {
    return randomUUID();
  }
}

/**
 * Prefixed UUIDv4 generator with collision protection for one runtime.
 * Construct one instance per Agent Board runtime. Do not share it globally.
 */
export class RuntimeIdGenerator implements IdGenerator {
  readonly #issued = new Set<string>();

  constructor(private readonly uuidSource: UuidSource = new CryptoUuidSource()) {}

  event(): EventId {
    return this.nextPrefixed('evt_') as EventId;
  }

  update(): UpdateId {
    return this.nextPrefixed('upd_') as UpdateId;
  }

  question(): QuestionId {
    return this.nextPrefixed('qst_') as QuestionId;
  }

  answer(): AnswerId {
    return this.nextPrefixed('ans_') as AnswerId;
  }

  command(): UiCommandId {
    return this.nextPrefixed('ui:') as UiCommandId;
  }

  private nextPrefixed(prefix: 'evt_' | 'upd_' | 'qst_' | 'ans_' | 'ui:'): string {
    for (let attempt = 0; attempt < MAX_UNIQUE_ID_ATTEMPTS; attempt += 1) {
      const uuid = this.uuidSource.nextUuid();
      if (!UUID_V4_PATTERN.test(uuid)) {
        throw new TypeError('UUID source must provide a lowercase UUIDv4.');
      }

      const id = `${prefix}${uuid}`;
      if (!this.#issued.has(id)) {
        this.#issued.add(id);
        return id;
      }
    }

    throw new Error('UUID source could not provide a unique ID.');
  }
}

/** Deterministic UUID source for tests. It fails rather than adding random fallback data. */
export class SequenceUuidSource implements UuidSource {
  readonly #values: string[];

  constructor(values: readonly string[]) {
    this.#values = [...values];
  }

  nextUuid(): string {
    const value = this.#values.shift();
    if (value === undefined) {
      throw new Error('Deterministic UUID sequence is exhausted.');
    }
    return value;
  }
}

export function isUpdateId(value: string): value is UpdateId {
  return value.length <= 64 && UPDATE_ID_PATTERN.test(value);
}

export function isQuestionId(value: string): value is QuestionId {
  return value.length <= 64 && QUESTION_ID_PATTERN.test(value);
}

export function isAnswerId(value: string): value is AnswerId {
  return value.length <= 64 && ANSWER_ID_PATTERN.test(value);
}

export function isEventId(value: string): value is EventId {
  return value.length <= 64 && EVENT_ID_PATTERN.test(value);
}

export function isCommandId(value: string): value is CommandId {
  return value.length <= 256 && COMMAND_ID_PATTERN.test(value);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function updateDisplayId(sequence: number): UpdateDisplayId {
  return makeDisplayId('U', sequence) as UpdateDisplayId;
}

export function questionDisplayId(sequence: number): QuestionDisplayId {
  return makeDisplayId('Q', sequence) as QuestionDisplayId;
}

export function decisionDisplayId(sequence: number): DecisionDisplayId {
  return makeDisplayId('D', sequence) as DecisionDisplayId;
}

export function displaySequence(value: string): number | undefined {
  if (
    !UPDATE_DISPLAY_ID_PATTERN.test(value) &&
    !QUESTION_DISPLAY_ID_PATTERN.test(value) &&
    !DECISION_DISPLAY_ID_PATTERN.test(value)
  ) {
    return undefined;
  }

  const sequence = Number(value.slice(2));
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function makeDisplayId(prefix: 'U' | 'Q' | 'D', sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('Display sequence must be a positive safe integer.');
  }

  const value = `${prefix}-${sequence}`;
  if (value.length > 32) {
    throw new RangeError('Display ID exceeds its schema length.');
  }
  return value;
}
