import type {
  AnswerId,
  CommandId,
  DecisionDisplayId,
  EventId,
  QuestionDisplayId,
  QuestionId,
  UpdateDisplayId,
  UpdateId,
} from './ids.js';

/** A UTC ISO-8601 timestamp after structural validation. */
export type IsoTimestamp = string;

export type UpdateKind = 'working' | 'finding' | 'warning' | 'blocked' | 'completed' | 'failed';
export type UpdateStage = 'discovering' | 'implementing' | 'testing' | 'validating' | 'complete';
export type QuestionClass = 'preference' | 'information' | 'reversible' | 'authorization';
export type ResponseKind = 'single' | 'multiple' | 'text' | 'single_or_text' | 'multiple_or_text';
export type QuestionStatus =
  | 'pending'
  | 'blocking'
  | 'answered'
  | 'delivery_queued'
  | 'delivery_failed'
  | 'needs_attention'
  | 'resolved'
  | 'stale'
  | 'cancelled'
  | 'dismissed';
export type QuestionPriority = 'normal' | 'high';
export type BlockingPolicy = 'never' | 'when_agent_settles';
export type DeliveryMode = 'steer' | 'followUp' | 'nextTurn';
export type AnswerSource = 'manual' | 'recommendation';
export type DeliveryStatus = 'recorded' | 'queued' | 'failed' | 'acknowledged';
export type AckOutcome =
  | 'applied'
  | 'partially_applied'
  | 'cannot_apply'
  | 'duplicate'
  | 'superseded';
export type DeliveryErrorCategory = 'host_rejected' | 'runtime_unavailable' | 'unknown';

export type OptionId = Lowercase<string>;
export type UpdateKey = string;
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export interface MeasurableProgress {
  readonly current: number;
  readonly total: number;
  readonly unit?: string;
}

export interface FileAttachment {
  readonly kind: 'file';
  readonly label: string;
  readonly path: string;
  readonly external?: boolean;
}

export interface LineRangeAttachment {
  readonly kind: 'line_range';
  readonly label: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly external?: boolean;
}

export interface ReferenceAttachment {
  readonly kind: 'test_run' | 'command';
  readonly label: string;
  readonly reference: string;
}

export interface UrlAttachment {
  readonly kind: 'url';
  readonly label: string;
  readonly url: string;
}

export interface NoteAttachment {
  readonly kind: 'note';
  readonly label: string;
  readonly text: string;
}

export type Attachment =
  | FileAttachment
  | LineRangeAttachment
  | ReferenceAttachment
  | UrlAttachment
  | NoteAttachment;

export interface QuestionOption {
  readonly id: OptionId;
  readonly label: string;
  readonly description?: string;
}

export interface TextResponseSpec {
  readonly kind: 'text';
  readonly options?: readonly [];
}

export interface OptionResponseSpec {
  readonly kind: Exclude<ResponseKind, 'text'>;
  readonly options: readonly QuestionOption[];
}

export type ResponseSpec = TextResponseSpec | OptionResponseSpec;

export interface TemporaryDefault {
  readonly optionIds: readonly OptionId[];
  readonly disclosure: string;
}

export interface UpdateFields {
  readonly key?: UpdateKey;
  readonly kind: UpdateKind;
  readonly title: string;
  readonly detail?: string;
  readonly stage?: UpdateStage;
  readonly progress?: MeasurableProgress;
  readonly attachments: readonly Attachment[];
}

export interface QuestionSpec {
  readonly question: string;
  readonly reason: string;
  readonly class: QuestionClass;
  readonly response: ResponseSpec;
  readonly recommendation?: string;
  readonly recommendedOptionIds: readonly OptionId[];
  readonly recommendedText?: string;
  readonly temporaryDefault?: TemporaryDefault;
  readonly priority: QuestionPriority;
  readonly blockingPolicy: BlockingPolicy;
  readonly deliveryMode: DeliveryMode;
  readonly affectedWork: readonly string[];
  readonly continuingWork: readonly string[];
  readonly attachments: readonly Attachment[];
  readonly expiresAt?: IsoTimestamp;
}

export interface SingleAnswerValue {
  readonly kind: 'single';
  readonly optionId: OptionId;
}

export interface MultipleAnswerValue {
  readonly kind: 'multiple';
  readonly optionIds: NonEmptyReadonlyArray<OptionId>;
}

export interface TextAnswerValue {
  readonly kind: 'text';
  readonly text: string;
}

type SingleOrTextAnswerValue =
  | {
      readonly kind: 'single_or_text';
      readonly optionId: OptionId;
      readonly text?: string;
    }
  | {
      readonly kind: 'single_or_text';
      readonly optionId?: OptionId;
      readonly text: string;
    };

type MultipleOrTextAnswerValue =
  | {
      readonly kind: 'multiple_or_text';
      readonly optionIds: NonEmptyReadonlyArray<OptionId>;
      readonly text?: string;
    }
  | {
      readonly kind: 'multiple_or_text';
      readonly optionIds: readonly [];
      readonly text: string;
    };

export type AnswerValue =
  | SingleAnswerValue
  | MultipleAnswerValue
  | TextAnswerValue
  | SingleOrTextAnswerValue
  | MultipleOrTextAnswerValue;

/** Immutable answer data persisted inside question.answered. */
export interface AnswerRecordEvent {
  readonly id: AnswerId;
  readonly questionId: QuestionId;
  readonly questionDisplayId: QuestionDisplayId;
  readonly questionRevision: number;
  readonly source: AnswerSource;
  readonly value: AnswerValue;
  readonly answeredAt: IsoTimestamp;
}

export interface DeliveryAttempt {
  readonly attempt: number;
  readonly at: IsoTimestamp;
  readonly mode: DeliveryMode;
  readonly outcome: 'queued' | 'failed';
  readonly errorCode?: string;
  readonly errorCategory?: DeliveryErrorCategory;
}

export interface AnswerRecord extends AnswerRecordEvent {
  readonly deliveryStatus: DeliveryStatus;
  readonly deliveryAttempts: readonly DeliveryAttempt[];
  readonly lastEventId: EventId;
}

/** Immutable acknowledgement data persisted inside answer.acknowledged. */
export interface AcknowledgementRecordEvent {
  readonly answerId: AnswerId;
  readonly questionId: QuestionId;
  readonly outcome: AckOutcome;
  readonly summary: string;
  readonly resultingUpdateIds: readonly UpdateId[];
  readonly attachments: readonly Attachment[];
  readonly acknowledgedAt: IsoTimestamp;
}

export interface AnswerAcknowledgement extends AcknowledgementRecordEvent {
  readonly eventId: EventId;
  readonly commandId: CommandId;
  /** Stable derived sequence for outcomes that produce a Decision. */
  readonly decisionDisplayId?: DecisionDisplayId;
}

export interface UpdateItem extends UpdateFields {
  readonly id: UpdateId;
  readonly displayId: UpdateDisplayId;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly archivedAt?: IsoTimestamp;
  readonly archived: boolean;
  readonly lastEventId: EventId;
  readonly lastCommandId: CommandId;
}

export interface QuestionItem extends QuestionSpec {
  readonly id: QuestionId;
  readonly displayId: QuestionDisplayId;
  readonly revision: number;
  readonly status: QuestionStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly escalatedAt?: IsoTimestamp;
  readonly staleAt?: IsoTimestamp;
  readonly cancelledAt?: IsoTimestamp;
  readonly dismissedAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly answerId?: AnswerId;
  /** Replay-safe detail for the latest specification revision. */
  readonly revisionSummary?: string;
  readonly cancelReason?: string;
  readonly staleReason?: string;
  readonly lastEventId: EventId;
  readonly lastCommandId: CommandId;
}

export interface DecisionRecord {
  readonly id: DecisionDisplayId;
  readonly questionId: QuestionId;
  readonly answerId: AnswerId;
  readonly questionRevision: number;
  readonly question: string;
  readonly answer: AnswerValue;
  readonly recommendation?: string;
  readonly actor: 'user';
  readonly reason: string;
  readonly acknowledgement: AnswerAcknowledgement;
  readonly decidedAt: IsoTimestamp;
  readonly resolvedAt: IsoTimestamp;
}

export interface NormalizedOption {
  readonly optionId: OptionId;
  readonly optionLabel: string;
}

export type NormalizedAnswer =
  | { readonly kind: 'single'; readonly optionId: OptionId; readonly optionLabel: string }
  | { readonly kind: 'multiple'; readonly options: NonEmptyReadonlyArray<NormalizedOption> }
  | { readonly kind: 'text'; readonly text: string }
  | (
      | {
          readonly kind: 'single_or_text';
          readonly optionId: OptionId;
          readonly optionLabel: string;
          readonly text?: string;
        }
      | {
          readonly kind: 'single_or_text';
          readonly optionId?: OptionId;
          readonly optionLabel?: string;
          readonly text: string;
        }
    )
  | (
      | {
          readonly kind: 'multiple_or_text';
          readonly options: NonEmptyReadonlyArray<NormalizedOption>;
          readonly text?: string;
        }
      | {
          readonly kind: 'multiple_or_text';
          readonly options: readonly [];
          readonly text: string;
        }
    );

export interface AnswerMessageDetails {
  readonly schemaVersion: 1;
  readonly answerId: AnswerId;
  readonly questionId: QuestionId;
  readonly questionDisplayId: QuestionDisplayId;
  readonly questionRevision: number;
  readonly question: string;
  readonly answer: NormalizedAnswer;
  readonly answeredAt: IsoTimestamp;
  readonly temporaryDefault?: TemporaryDefault & { readonly conflictsWithAnswer: boolean };
  readonly instruction: string;
}

export type ReplayWarningCode =
  | 'SB_REPLAY_DECODE_INVALID'
  | 'SB_REPLAY_UNSUPPORTED_VERSION'
  | 'SB_REPLAY_REDUCER_REJECTED';

/** Bounded, content-free replay evidence. */
export interface ReplayWarning {
  readonly entryIndex: number;
  readonly entryId?: string;
  readonly code: ReplayWarningCode;
}

/** Compact replay-safe evidence retained for one accepted command. */
export interface IdempotentCommandResult<
  TEventType extends string = string,
  TSemanticPayload = unknown,
> {
  readonly eventId: EventId;
  readonly eventType: TEventType;
  readonly semanticPayload: TSemanticPayload;
}

export interface BoardState {
  readonly schemaVersion: 1;
  readonly updates: ReadonlyMap<UpdateId, UpdateItem>;
  readonly questions: ReadonlyMap<QuestionId, QuestionItem>;
  readonly answers: ReadonlyMap<AnswerId, AnswerRecord>;
  readonly acknowledgements: ReadonlyMap<AnswerId, AnswerAcknowledgement>;
  readonly commandResults: ReadonlyMap<CommandId, IdempotentCommandResult>;
  /** Canonical accepted event content keyed by event ID for collision detection. */
  readonly acceptedEventIds: ReadonlyMap<EventId, string>;
  readonly lastViewedAt?: IsoTimestamp;
  readonly resetEventId?: EventId;
  readonly counters: {
    readonly nextUpdate: number;
    readonly nextQuestion: number;
    readonly nextDecision: number;
  };
  readonly replay: {
    readonly acceptedEvents: number;
    readonly skippedEvents: number;
    readonly warnings: readonly ReplayWarning[];
  };
}
