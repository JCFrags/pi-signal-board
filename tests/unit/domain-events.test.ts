import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertNeverBoardEvent,
  type BoardEvent,
  type BoardEventOf,
  type BoardEventType,
} from '../../src/domain/events.js';
import type { AnswerMessageDetails } from '../../src/domain/types.js';
import { schemaPositiveAnswerMessage, schemaPositiveEvents } from '../fixtures/schema-positive.js';

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type RequiredKeys<Value> = {
  [Key in keyof Value]-?: Record<string, never> extends Pick<Value, Key> ? never : Key;
}[keyof Value];

type ExpectedEventType =
  | 'update.upserted'
  | 'update.archived'
  | 'question.created'
  | 'question.revised'
  | 'question.cancelled'
  | 'question.escalated'
  | 'question.staled'
  | 'question.dismissed'
  | 'question.answered'
  | 'answer.delivery_queued'
  | 'answer.delivery_failed'
  | 'answer.acknowledged'
  | 'board.viewed'
  | 'board.reset';

type ExpectedPayloadKeys = {
  readonly 'update.upserted':
    | 'updateId'
    | 'displayId'
    | 'revision'
    | 'createdAt'
    | 'updatedAt'
    | 'completedAt'
    | 'fields';
  readonly 'update.archived': 'updateId' | 'expectedRevision' | 'revision' | 'archivedAt';
  readonly 'question.created': 'questionId' | 'displayId' | 'revision' | 'createdAt' | 'spec';
  readonly 'question.revised':
    | 'questionId'
    | 'expectedRevision'
    | 'revision'
    | 'updatedAt'
    | 'revisionSummary'
    | 'spec';
  readonly 'question.cancelled':
    | 'questionId'
    | 'expectedRevision'
    | 'revision'
    | 'cancelledAt'
    | 'reason';
  readonly 'question.escalated': 'questionId' | 'expectedRevision' | 'revision' | 'escalatedAt';
  readonly 'question.staled': 'questionId' | 'expectedRevision' | 'revision' | 'staleAt' | 'reason';
  readonly 'question.dismissed': 'questionId' | 'expectedRevision' | 'revision' | 'dismissedAt';
  readonly 'question.answered': 'questionId' | 'expectedRevision' | 'answer';
  readonly 'answer.delivery_queued': 'answerId' | 'questionId' | 'attempt' | 'at' | 'mode';
  readonly 'answer.delivery_failed':
    | 'answerId'
    | 'questionId'
    | 'attempt'
    | 'at'
    | 'mode'
    | 'errorCode'
    | 'errorCategory';
  readonly 'answer.acknowledged': 'acknowledgement';
  readonly 'board.viewed': 'cutoffAt';
  readonly 'board.reset': 'resetAt' | 'reason';
};

type ExpectedRequiredPayloadKeys = Omit<ExpectedPayloadKeys, 'update.upserted'> & {
  readonly 'update.upserted': Exclude<ExpectedPayloadKeys['update.upserted'], 'completedAt'>;
};

type PayloadKeyParity = {
  [EventType in BoardEventType]: Equal<
    keyof BoardEventOf<EventType>['payload'],
    ExpectedPayloadKeys[EventType]
  >;
}[BoardEventType];
type RequiredPayloadKeyParity = {
  [EventType in BoardEventType]: Equal<
    RequiredKeys<BoardEventOf<EventType>['payload']>,
    ExpectedRequiredPayloadKeys[EventType]
  >;
}[BoardEventType];

const EVENT_TYPE_PARITY: Equal<BoardEventType, ExpectedEventType> = true;
const AGENT_ACTOR_PARITY: Equal<BoardEventOf<'question.created'>['actor'], 'agent'> = true;
const ARCHIVE_ACTOR_PARITY: Equal<BoardEventOf<'update.archived'>['actor'], 'agent' | 'user'> =
  true;
const RESET_ACTOR_PARITY: Equal<BoardEventOf<'board.reset'>['actor'], 'user'> = true;
const PAYLOAD_KEY_PARITY: PayloadKeyParity = true;
const REQUIRED_PAYLOAD_KEY_PARITY: RequiredPayloadKeyParity = true;

function exhaustivelyVisit(event: BoardEvent): BoardEventType {
  switch (event.eventType) {
    case 'update.upserted':
    case 'update.archived':
    case 'question.created':
    case 'question.revised':
    case 'question.cancelled':
    case 'question.escalated':
    case 'question.staled':
    case 'question.dismissed':
    case 'question.answered':
    case 'answer.delivery_queued':
    case 'answer.delivery_failed':
    case 'answer.acknowledged':
    case 'board.viewed':
    case 'board.reset':
      return event.eventType;
    default:
      return assertNeverBoardEvent(event);
  }
}

function compileReadonlyEvidence(event: BoardEvent, message: AnswerMessageDetails): void {
  // @ts-expect-error The event envelope is immutable.
  event.eventId = 'evt_00000000-0000-4000-8000-000000000000';
  // @ts-expect-error Nested answer-message data is immutable.
  message.answer = { kind: 'text', text: 'changed' };
}

void compileReadonlyEvidence;

function readAuthoritativeEvents(): readonly unknown[] {
  const path = fileURLToPath(new URL('../fixtures/session-events.example.jsonl', import.meta.url));
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function readAuthoritativeAnswerMessage(): unknown {
  const path = fileURLToPath(new URL('../fixtures/answer-message.example.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

describe('SB-008 domain event schema parity', () => {
  it('has compile-time parity with every board-event schema v1 discriminant', () => {
    expect(EVENT_TYPE_PARITY).toBe(true);
    expect(AGENT_ACTOR_PARITY).toBe(true);
    expect(ARCHIVE_ACTOR_PARITY).toBe(true);
    expect(RESET_ACTOR_PARITY).toBe(true);
    expect(PAYLOAD_KEY_PARITY).toBe(true);
    expect(REQUIRED_PAYLOAD_KEY_PARITY).toBe(true);
  });

  it('exhaustively dispatches every authoritative schema-positive event fixture', () => {
    expect(schemaPositiveEvents.map(exhaustivelyVisit)).toEqual(
      schemaPositiveEvents.map((event) => event.eventType),
    );
  });

  it('keeps typed event fixtures value-for-value equal to the authoritative JSONL examples', () => {
    expect(schemaPositiveEvents).toEqual(readAuthoritativeEvents());
  });

  it('keeps the typed answer contract equal to the authoritative JSON example', () => {
    expect(schemaPositiveAnswerMessage).toEqual(readAuthoritativeAnswerMessage());
  });
});
