import type { BoardEvent } from '../../src/domain/events.js';
import type { AnswerMessageDetails } from '../../src/domain/types.js';

// These typed values mirror the authoritative specification examples in this fixture directory.

export const schemaPositiveEvents = [
  {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    eventType: 'update.upserted',
    occurredAt: '2026-08-08T20:00:00.000Z',
    actor: 'agent',
    commandId: 'tool:update-call-1',
    payload: {
      updateId: 'upd_11111111-1111-4111-8111-111111111111',
      displayId: 'U-1',
      revision: 1,
      createdAt: '2026-08-08T20:00:00.000Z',
      updatedAt: '2026-08-08T20:00:00.000Z',
      fields: {
        key: 'auth-refactor',
        kind: 'working',
        title: 'Refactoring authentication middleware',
        detail: 'Token parsing is complete; compatibility tests remain.',
        stage: 'testing',
        progress: {
          current: 8,
          total: 12,
          unit: 'tests',
        },
        attachments: [
          {
            kind: 'file',
            label: 'Middleware',
            path: 'src/auth/middleware.ts',
          },
        ],
      },
    },
  },
  {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    eventType: 'question.created',
    occurredAt: '2026-08-08T20:02:00.000Z',
    actor: 'agent',
    commandId: 'tool:question-call-1',
    payload: {
      questionId: 'qst_22222222-2222-4222-8222-222222222222',
      displayId: 'Q-1',
      revision: 1,
      createdAt: '2026-08-08T20:02:00.000Z',
      spec: {
        question: 'Should the deprecated cache option remain supported?',
        reason: 'Removing it simplifies the parser but may break older configuration files.',
        class: 'reversible',
        response: {
          kind: 'single_or_text',
          options: [
            {
              id: 'keep',
              label: 'Keep for one release',
              description: 'Emit a deprecation warning.',
            },
            {
              id: 'remove',
              label: 'Remove now',
            },
          ],
        },
        recommendation: 'Keep it for one release and warn.',
        recommendedOptionIds: ['keep'],
        temporaryDefault: {
          optionIds: ['keep'],
          disclosure:
            'Current behavior will be preserved while waiting; choosing removal may require rework.',
        },
        priority: 'normal',
        blockingPolicy: 'when_agent_settles',
        deliveryMode: 'steer',
        affectedWork: ['Final parser implementation'],
        continuingWork: ['New-format tests', 'Migration documentation'],
        attachments: [
          {
            kind: 'file',
            label: 'Parser',
            path: 'src/config/parser.ts',
          },
        ],
      },
    },
  },
  {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    eventType: 'question.escalated',
    occurredAt: '2026-08-08T20:15:00.000Z',
    actor: 'system',
    commandId: 'system:escalate:qst_22222222-2222-4222-8222-222222222222:1',
    payload: {
      questionId: 'qst_22222222-2222-4222-8222-222222222222',
      expectedRevision: 1,
      revision: 2,
      escalatedAt: '2026-08-08T20:15:00.000Z',
    },
  },
  {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    eventType: 'question.answered',
    occurredAt: '2026-08-08T20:16:00.000Z',
    actor: 'user',
    commandId: 'ui:answer-example-1',
    payload: {
      questionId: 'qst_22222222-2222-4222-8222-222222222222',
      expectedRevision: 2,
      answer: {
        id: 'ans_33333333-3333-4333-8333-333333333333',
        questionId: 'qst_22222222-2222-4222-8222-222222222222',
        questionDisplayId: 'Q-1',
        questionRevision: 2,
        source: 'recommendation',
        value: {
          kind: 'single_or_text',
          optionId: 'keep',
        },
        answeredAt: '2026-08-08T20:16:00.000Z',
      },
    },
  },
  {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    eventType: 'answer.delivery_queued',
    occurredAt: '2026-08-08T20:20:00.000Z',
    actor: 'system',
    commandId: 'system:deliver:ans_33333333-3333-4333-8333-333333333333:1',
    payload: {
      answerId: 'ans_33333333-3333-4333-8333-333333333333',
      questionId: 'qst_22222222-2222-4222-8222-222222222222',
      attempt: 1,
      at: '2026-08-08T20:20:00.000Z',
      mode: 'steer',
    },
  },
  {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
    eventType: 'answer.acknowledged',
    occurredAt: '2026-08-08T20:25:00.000Z',
    actor: 'agent',
    commandId: 'tool:ack-call-1',
    payload: {
      acknowledgement: {
        answerId: 'ans_33333333-3333-4333-8333-333333333333',
        questionId: 'qst_22222222-2222-4222-8222-222222222222',
        outcome: 'applied',
        summary:
          'Kept compatibility support, added a deprecation warning, and updated migration documentation.',
        resultingUpdateIds: ['upd_11111111-1111-4111-8111-111111111111'],
        attachments: [
          {
            kind: 'file',
            label: 'Parser',
            path: 'src/config/parser.ts',
          },
        ],
        acknowledgedAt: '2026-08-08T20:25:00.000Z',
      },
    },
  },
] as const satisfies readonly BoardEvent[];

export const schemaPositiveAnswerMessage = {
  schemaVersion: 1,
  answerId: 'ans_33333333-3333-4333-8333-333333333333',
  questionId: 'qst_22222222-2222-4222-8222-222222222222',
  questionDisplayId: 'Q-1',
  questionRevision: 2,
  question: 'Should the deprecated cache option remain supported?',
  answer: {
    kind: 'single_or_text',
    optionId: 'keep',
    optionLabel: 'Keep for one release',
  },
  answeredAt: '2026-08-08T20:16:00.000Z',
  temporaryDefault: {
    optionIds: ['keep'],
    disclosure:
      'Current behavior will be preserved while waiting; choosing removal may require rework.',
    conflictsWithAnswer: false,
  },
  instruction:
    'Process this answer once. Deduplicate by answerId and call signal_board_ack with the outcome.',
} as const satisfies AnswerMessageDetails;
