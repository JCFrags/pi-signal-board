import { type Static, Type } from 'typebox';
import { Check } from 'typebox/schema';

import { deepFreeze } from './defaults.js';
import type { DeepReadonly } from './types.js';

const deliveryModeSchema = Type.Union(
  [Type.Literal('steer'), Type.Literal('followUp'), Type.Literal('nextTurn')],
  { default: 'steer' },
);

const blockingPolicySchema = Type.Union(
  [Type.Literal('never'), Type.Literal('when_agent_settles')],
  { default: 'when_agent_settles' },
);

/** Runtime form of schemas/config.schema.json. */
export const configDocumentSchema = deepFreeze(
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      enabled: Type.Optional(Type.Boolean({ default: true })),
      widget: Type.Optional(
        Type.Object(
          {
            enabled: Type.Optional(Type.Boolean({ default: true })),
            placement: Type.Optional(Type.Literal('aboveEditor', { default: 'aboveEditor' })),
            maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 4 })),
            showCompletedForMinutes: Type.Optional(
              Type.Integer({ minimum: 0, maximum: 1440, default: 10 }),
            ),
            hideWhenClear: Type.Optional(Type.Boolean({ default: true })),
          },
          { additionalProperties: false },
        ),
      ),
      status: Type.Optional(
        Type.Object(
          {
            enabled: Type.Optional(Type.Boolean({ default: true })),
            hideWhenClear: Type.Optional(Type.Boolean({ default: true })),
          },
          { additionalProperties: false },
        ),
      ),
      notifications: Type.Optional(
        Type.Object(
          {
            highPriorityQuestion: Type.Optional(Type.Boolean({ default: true })),
            questionEscalated: Type.Optional(Type.Boolean({ default: true })),
            deliveryFailed: Type.Optional(Type.Boolean({ default: true })),
            normalQuestion: Type.Optional(Type.Boolean({ default: false })),
            updateCompleted: Type.Optional(Type.Boolean({ default: false })),
          },
          { additionalProperties: false },
        ),
      ),
      questions: Type.Optional(
        Type.Object(
          {
            defaultDeliveryMode: Type.Optional(deliveryModeSchema),
            defaultBlockingPolicy: Type.Optional(blockingPolicySchema),
            recoveryDeliveryOnStart: Type.Optional(Type.Boolean({ default: true })),
          },
          { additionalProperties: false },
        ),
      ),
      limits: Type.Optional(
        Type.Object(
          {
            maxActiveUpdates: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
            ),
            maxActionableQuestions: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
            ),
            visibleHistoryLimit: Type.Optional(
              Type.Integer({ minimum: 50, maximum: 2000, default: 500 }),
            ),
            maxUpdateMutationsPerTurn: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 50, default: 12 }),
            ),
            maxQuestionMutationsPerTurn: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 20, default: 5 }),
            ),
            maxAcknowledgementsPerTurn: Type.Optional(
              Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      ui: Type.Optional(
        Type.Object(
          {
            wideLayoutMinimumColumns: Type.Optional(
              Type.Integer({ minimum: 80, maximum: 160, default: 100 }),
            ),
            minimumColumns: Type.Optional(Type.Integer({ minimum: 40, maximum: 80, default: 50 })),
            showRelativeTime: Type.Optional(Type.Boolean({ default: true })),
          },
          { additionalProperties: false },
        ),
      ),
      debug: Type.Optional(
        Type.Object(
          {
            enabled: Type.Optional(Type.Boolean({ default: false })),
            showAnswerMessages: Type.Optional(Type.Boolean({ default: false })),
          },
          { additionalProperties: false },
        ),
      ),
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://schemas.pi-signal-board.local/config.schema.json',
      title: 'Pi Signal Board configuration',
      description:
        'Global or trusted-project configuration. Unknown properties and null values are rejected. Missing fields inherit lower-precedence values/defaults.',
      additionalProperties: false,
    },
  ),
);

export type ConfigDocument = DeepReadonly<Static<typeof configDocumentSchema>>;

/** Validate one complete source document without applying defaults or coercion. */
export function isConfigDocument(value: unknown): value is ConfigDocument {
  return Check(configDocumentSchema, value);
}
