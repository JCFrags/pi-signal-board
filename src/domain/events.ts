import type {
  AnswerId,
  CommandId,
  EventId,
  QuestionDisplayId,
  QuestionId,
  UpdateDisplayId,
  UpdateId,
} from './ids.js';
import type {
  AcknowledgementRecordEvent,
  AnswerRecordEvent,
  DeliveryErrorCategory,
  DeliveryMode,
  IdempotentCommandResult,
  IsoTimestamp,
  QuestionSpec,
  UpdateFields,
} from './types.js';

export type BoardEventActor = 'agent' | 'user' | 'system';

export interface BoardEventEnvelope<
  TType extends string,
  TActor extends BoardEventActor,
  TPayload,
> {
  readonly schemaVersion: 1;
  readonly eventId: EventId;
  readonly eventType: TType;
  readonly occurredAt: IsoTimestamp;
  readonly actor: TActor;
  readonly commandId: CommandId;
  readonly payload: TPayload;
}

export interface UpdateUpsertedPayload {
  readonly updateId: UpdateId;
  readonly displayId: UpdateDisplayId;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly fields: UpdateFields;
}

export interface UpdateArchivedPayload {
  readonly updateId: UpdateId;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly archivedAt: IsoTimestamp;
}

export interface QuestionCreatedPayload {
  readonly questionId: QuestionId;
  readonly displayId: QuestionDisplayId;
  readonly revision: 1;
  readonly createdAt: IsoTimestamp;
  readonly spec: QuestionSpec;
}

export interface QuestionRevisedPayload {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly revisionSummary: string;
  readonly spec: QuestionSpec;
}

export interface QuestionCancelledPayload {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly cancelledAt: IsoTimestamp;
  readonly reason: string;
}

export interface QuestionEscalatedPayload {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly escalatedAt: IsoTimestamp;
}

export interface QuestionStaledPayload {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly staleAt: IsoTimestamp;
  readonly reason: string;
}

export interface QuestionDismissedPayload {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly dismissedAt: IsoTimestamp;
}

export interface QuestionAnsweredPayload {
  readonly questionId: QuestionId;
  readonly expectedRevision: number;
  readonly answer: AnswerRecordEvent;
}

export interface AnswerDeliveryQueuedPayload {
  readonly answerId: AnswerId;
  readonly questionId: QuestionId;
  readonly attempt: number;
  readonly at: IsoTimestamp;
  readonly mode: DeliveryMode;
}

export interface AnswerDeliveryFailedPayload extends AnswerDeliveryQueuedPayload {
  readonly errorCode: 'SB_DELIVERY_FAILED';
  readonly errorCategory: DeliveryErrorCategory;
}

export interface AnswerAcknowledgedPayload {
  readonly acknowledgement: AcknowledgementRecordEvent;
}

export interface BoardViewedPayload {
  readonly cutoffAt: IsoTimestamp;
}

export interface BoardResetPayload {
  readonly resetAt: IsoTimestamp;
  readonly reason: string;
}

export interface BoardEventMap {
  readonly 'update.upserted': BoardEventEnvelope<'update.upserted', 'agent', UpdateUpsertedPayload>;
  readonly 'update.archived': BoardEventEnvelope<
    'update.archived',
    'agent' | 'user',
    UpdateArchivedPayload
  >;
  readonly 'question.created': BoardEventEnvelope<
    'question.created',
    'agent',
    QuestionCreatedPayload
  >;
  readonly 'question.revised': BoardEventEnvelope<
    'question.revised',
    'agent',
    QuestionRevisedPayload
  >;
  readonly 'question.cancelled': BoardEventEnvelope<
    'question.cancelled',
    'agent',
    QuestionCancelledPayload
  >;
  readonly 'question.escalated': BoardEventEnvelope<
    'question.escalated',
    'system',
    QuestionEscalatedPayload
  >;
  readonly 'question.staled': BoardEventEnvelope<
    'question.staled',
    'system',
    QuestionStaledPayload
  >;
  readonly 'question.dismissed': BoardEventEnvelope<
    'question.dismissed',
    'user',
    QuestionDismissedPayload
  >;
  readonly 'question.answered': BoardEventEnvelope<
    'question.answered',
    'user',
    QuestionAnsweredPayload
  >;
  readonly 'answer.delivery_queued': BoardEventEnvelope<
    'answer.delivery_queued',
    'system',
    AnswerDeliveryQueuedPayload
  >;
  readonly 'answer.delivery_failed': BoardEventEnvelope<
    'answer.delivery_failed',
    'system',
    AnswerDeliveryFailedPayload
  >;
  readonly 'answer.acknowledged': BoardEventEnvelope<
    'answer.acknowledged',
    'agent',
    AnswerAcknowledgedPayload
  >;
  readonly 'board.viewed': BoardEventEnvelope<'board.viewed', 'user', BoardViewedPayload>;
  readonly 'board.reset': BoardEventEnvelope<'board.reset', 'user', BoardResetPayload>;
}

export type BoardEventType = keyof BoardEventMap;
export type EventType = BoardEventType;
export type UpdateUpsertedEvent = BoardEventMap['update.upserted'];
export type UpdateArchivedEvent = BoardEventMap['update.archived'];
export type QuestionCreatedEvent = BoardEventMap['question.created'];
export type QuestionRevisedEvent = BoardEventMap['question.revised'];
export type QuestionCancelledEvent = BoardEventMap['question.cancelled'];
export type QuestionEscalatedEvent = BoardEventMap['question.escalated'];
export type QuestionStaledEvent = BoardEventMap['question.staled'];
export type QuestionDismissedEvent = BoardEventMap['question.dismissed'];
export type QuestionAnsweredEvent = BoardEventMap['question.answered'];
export type AnswerDeliveryQueuedEvent = BoardEventMap['answer.delivery_queued'];
export type AnswerDeliveryFailedEvent = BoardEventMap['answer.delivery_failed'];
export type AnswerAcknowledgedEvent = BoardEventMap['answer.acknowledged'];
export type BoardViewedEvent = BoardEventMap['board.viewed'];
export type BoardResetEvent = BoardEventMap['board.reset'];
export type BoardEvent = BoardEventMap[BoardEventType];
export type BoardEventOf<TType extends BoardEventType> = BoardEventMap[TType];
export type BoardEventCommandResult = {
  readonly [TType in BoardEventType]: IdempotentCommandResult<
    TType,
    BoardEventMap[TType]['payload']
  >;
}[BoardEventType];

/** Use at the default branch of a switch to require compile-time event exhaustiveness. */
export function assertNeverBoardEvent(event: never): never {
  throw new TypeError(`Unhandled BoardEvent: ${String(event)}`);
}
