/** Delivery timing accepted by Agent Board configuration version 1. */
export type ConfigDeliveryMode = 'steer' | 'followUp' | 'nextTurn';

/** Policy that controls question escalation when an agent settles. */
export type ConfigBlockingPolicy = 'never' | 'when_agent_settles';

export interface WidgetConfig {
  readonly enabled: boolean;
  readonly placement: 'aboveEditor';
  readonly maxItems: number;
  readonly showCompletedForMinutes: number;
  readonly hideWhenClear: boolean;
}

export interface StatusConfig {
  readonly enabled: boolean;
  readonly hideWhenClear: boolean;
}

export interface NotificationConfig {
  readonly highPriorityQuestion: boolean;
  readonly questionEscalated: boolean;
  readonly deliveryFailed: boolean;
  readonly normalQuestion: boolean;
  readonly updateCompleted: boolean;
}

export interface QuestionConfig {
  readonly defaultDeliveryMode: ConfigDeliveryMode;
  readonly defaultBlockingPolicy: ConfigBlockingPolicy;
  readonly recoveryDeliveryOnStart: boolean;
}

export interface LimitConfig {
  readonly maxActiveUpdates: number;
  readonly maxActionableQuestions: number;
  readonly visibleHistoryLimit: number;
  readonly maxUpdateMutationsPerTurn: number;
  readonly maxQuestionMutationsPerTurn: number;
  readonly maxAcknowledgementsPerTurn: number;
}

export interface UiConfig {
  readonly wideLayoutMinimumColumns: number;
  readonly minimumColumns: number;
  readonly showRelativeTime: boolean;
}

export interface DebugConfig {
  readonly enabled: boolean;
  readonly showAnswerMessages: boolean;
}

/** Complete, merged, immutable configuration used by runtime services. */
export interface EffectiveConfig {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly widget: WidgetConfig;
  readonly status: StatusConfig;
  readonly notifications: NotificationConfig;
  readonly questions: QuestionConfig;
  readonly limits: LimitConfig;
  readonly ui: UiConfig;
  readonly debug: DebugConfig;
}

/** Recursively make schema-derived document fields immutable. */
export type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ConfigSource = 'global' | 'project';
export type ConfigSourceStatus = 'absent' | 'applied' | 'rejected';
export type ProjectConfigSourceStatus = ConfigSourceStatus | 'not_read_untrusted';
export type ConfigWarningReason =
  | 'too_large'
  | 'unreadable'
  | 'invalid_encoding'
  | 'malformed_json'
  | 'invalid_schema'
  | 'invalid_semantics';

/** Content-free warning safe for diagnostics and doctor output. */
export interface ConfigWarning {
  readonly source: ConfigSource;
  readonly reason: ConfigWarningReason;
  readonly safeCategory?: 'access_denied' | 'wrong_type' | 'io_error';
}

export interface ConfigLoadResult {
  readonly config: EffectiveConfig;
  readonly sources: {
    readonly global: ConfigSourceStatus;
    readonly project: ProjectConfigSourceStatus;
  };
  readonly warnings: readonly ConfigWarning[];
}
