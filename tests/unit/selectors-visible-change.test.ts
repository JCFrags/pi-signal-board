import { describe, expect, it } from 'vitest';

import type { BoardEvent, BoardEventType } from '../../src/domain/events.js';
import { createEmptyBoardState, reduceBoardEvent } from '../../src/domain/reducer.js';
import type { BoardState, QuestionSpec, UpdateKind } from '../../src/domain/types.js';

const BASE = Date.parse('2026-08-12T09:00:00.000Z');
const UPDATE_1 = 'upd_10000000-0000-4000-8000-000000000001' as const;
const UPDATE_2 = 'upd_10000000-0000-4000-8000-000000000002' as const;
const QUESTION_1 = 'qst_20000000-0000-4000-8000-000000000001' as const;
const QUESTION_2 = 'qst_20000000-0000-4000-8000-000000000002' as const;
const QUESTION_3 = 'qst_20000000-0000-4000-8000-000000000003' as const;
const QUESTION_4 = 'qst_20000000-0000-4000-8000-000000000004' as const;

const SPEC: QuestionSpec = {
  question: 'Choose a path?',
  reason: 'The implementation needs one stable choice.',
  class: 'reversible',
  response: {
    kind: 'single',
    options: [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ],
  },
  recommendation: 'Use one.',
  recommendedOptionIds: ['one'],
  priority: 'normal',
  blockingPolicy: 'when_agent_settles',
  deliveryMode: 'steer',
  affectedWork: [],
  continuingWork: [],
  attachments: [],
};

let eventNumber = 0;
let minute = 0;
function time(): string {
  minute += 1;
  return new Date(BASE + minute * 60_000).toISOString();
}
function event<T extends BoardEventType>(
  eventType: T,
  actor: BoardEvent['actor'],
  commandId: BoardEvent['commandId'],
  occurredAt: string,
  payload: Extract<BoardEvent, { eventType: T }>['payload'],
): Extract<BoardEvent, { eventType: T }> {
  eventNumber += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_40000000-0000-4000-8000-${eventNumber.toString().padStart(12, '0')}`,
    eventType,
    occurredAt,
    actor,
    commandId,
    payload,
  } as Extract<BoardEvent, { eventType: T }>;
}
function apply(state: BoardState, next: BoardEvent): BoardState {
  const result = reduceBoardEvent(state, next);
  expect(result).toMatchObject({ ok: true, idempotent: false });
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}
function upsert(
  id: typeof UPDATE_1 | typeof UPDATE_2,
  displayId: `U-${number}`,
  revision: number,
  kind: UpdateKind,
  createdAt: string,
): BoardEvent {
  const occurredAt = revision === 1 ? createdAt : time();
  const terminal = kind === 'completed' || kind === 'failed';
  return event('update.upserted', 'agent', `tool:update-${id}-${revision}`, occurredAt, {
    updateId: id,
    displayId,
    revision,
    createdAt,
    updatedAt: occurredAt,
    ...(terminal ? { completedAt: occurredAt } : {}),
    fields: { kind, title: `${displayId} ${kind}`, attachments: [] },
  });
}
function createQuestion(
  id: typeof QUESTION_1 | typeof QUESTION_2 | typeof QUESTION_3 | typeof QUESTION_4,
  displayId: `Q-${number}`,
): BoardEvent {
  const occurredAt = time();
  return event('question.created', 'agent', `tool:create-${displayId}`, occurredAt, {
    questionId: id,
    displayId,
    revision: 1,
    createdAt: occurredAt,
    spec: SPEC,
  });
}
function answerQuestion(
  id: typeof QUESTION_1 | typeof QUESTION_3 | typeof QUESTION_4,
  displayId: `Q-${number}`,
  revision: number,
  answerNumber: number,
): Extract<BoardEvent, { eventType: 'question.answered' }> {
  const occurredAt = time();
  const answerId =
    `ans_30000000-0000-4000-8000-${answerNumber.toString().padStart(12, '0')}` as const;
  return event('question.answered', 'user', `ui:answer-${answerNumber}`, occurredAt, {
    questionId: id,
    expectedRevision: revision,
    answer: {
      id: answerId,
      questionId: id,
      questionDisplayId: displayId,
      questionRevision: revision,
      source: 'manual',
      value: { kind: 'single', optionId: 'one' },
      answeredAt: occurredAt,
    },
  });
}

function buildVisibleCategories(): { state: BoardState; first: BoardEvent } {
  eventNumber = 0;
  minute = 0;
  let state = createEmptyBoardState();
  const createdAt = time();
  const first = upsert(UPDATE_1, 'U-1', 1, 'working', createdAt);
  state = apply(state, first);
  state = apply(state, upsert(UPDATE_1, 'U-1', 2, 'blocked', createdAt));
  state = apply(state, upsert(UPDATE_1, 'U-1', 3, 'completed', createdAt));
  const archivedAt = time();
  state = apply(
    state,
    event('update.archived', 'user', 'ui:archive-u1', archivedAt, {
      updateId: UPDATE_1,
      expectedRevision: 3,
      revision: 4,
      archivedAt,
    }),
  );
  const secondCreatedAt = time();
  state = apply(state, upsert(UPDATE_2, 'U-2', 1, 'working', secondCreatedAt));
  state = apply(state, upsert(UPDATE_2, 'U-2', 2, 'failed', secondCreatedAt));

  state = apply(state, createQuestion(QUESTION_1, 'Q-1'));
  const revisedAt = time();
  state = apply(
    state,
    event('question.revised', 'agent', 'tool:revise-q1', revisedAt, {
      questionId: QUESTION_1,
      expectedRevision: 1,
      revision: 2,
      updatedAt: revisedAt,
      revisionSummary: 'Add evidence.',
      spec: { ...SPEC, reason: 'New evidence requires one stable choice.' },
    }),
  );
  const escalatedAt = time();
  state = apply(
    state,
    event('question.escalated', 'system', 'system:escalate-q1', escalatedAt, {
      questionId: QUESTION_1,
      expectedRevision: 2,
      revision: 3,
      escalatedAt,
    }),
  );
  const q1Answer = answerQuestion(QUESTION_1, 'Q-1', 3, 1);
  state = apply(state, q1Answer);
  const queuedAt = time();
  state = apply(
    state,
    event('answer.delivery_queued', 'system', 'system:queue-a1', queuedAt, {
      answerId: q1Answer.payload.answer.id,
      questionId: QUESTION_1,
      attempt: 1,
      at: queuedAt,
      mode: 'steer',
    }),
  );
  const appliedAt = time();
  state = apply(
    state,
    event('answer.acknowledged', 'agent', 'tool:ack-a1', appliedAt, {
      acknowledgement: {
        answerId: q1Answer.payload.answer.id,
        questionId: QUESTION_1,
        outcome: 'applied',
        summary: 'Applied.',
        resultingUpdateIds: [],
        attachments: [],
        acknowledgedAt: appliedAt,
      },
    }),
  );

  state = apply(state, createQuestion(QUESTION_2, 'Q-2'));
  const cancelledAt = time();
  state = apply(
    state,
    event('question.cancelled', 'agent', 'tool:cancel-q2', cancelledAt, {
      questionId: QUESTION_2,
      expectedRevision: 1,
      revision: 2,
      cancelledAt,
      reason: 'Not needed.',
    }),
  );

  state = apply(state, createQuestion(QUESTION_3, 'Q-3'));
  const q3Answer = answerQuestion(QUESTION_3, 'Q-3', 1, 3);
  state = apply(state, q3Answer);
  const q3QueuedAt = time();
  state = apply(
    state,
    event('answer.delivery_queued', 'system', 'system:queue-a3', q3QueuedAt, {
      answerId: q3Answer.payload.answer.id,
      questionId: QUESTION_3,
      attempt: 1,
      at: q3QueuedAt,
      mode: 'steer',
    }),
  );
  const attentionAt = time();
  state = apply(
    state,
    event('answer.acknowledged', 'agent', 'tool:ack-a3', attentionAt, {
      acknowledgement: {
        answerId: q3Answer.payload.answer.id,
        questionId: QUESTION_3,
        outcome: 'cannot_apply',
        summary: 'Cannot apply.',
        resultingUpdateIds: [],
        attachments: [],
        acknowledgedAt: attentionAt,
      },
    }),
  );

  state = apply(state, createQuestion(QUESTION_4, 'Q-4'));
  const q4Answer = answerQuestion(QUESTION_4, 'Q-4', 1, 4);
  state = apply(state, q4Answer);
  const failedAt = time();
  state = apply(
    state,
    event('answer.delivery_failed', 'system', 'system:fail-a4', failedAt, {
      answerId: q4Answer.payload.answer.id,
      questionId: QUESTION_4,
      attempt: 1,
      at: failedAt,
      mode: 'steer',
      errorCode: 'SB_DELIVERY_FAILED',
      errorCategory: 'host_rejected',
    }),
  );
  return { state, first };
}

describe('SB-010 correction visible-change records', () => {
  it('records every item category in accepted order with exact timestamps', () => {
    const { state } = buildVisibleCategories();
    expect(state.visibleChanges.map((record) => record.change.kind)).toEqual([
      'update_created',
      'update_changed',
      'update_completed',
      'update_archived',
      'update_created',
      'update_failed',
      'question_created',
      'question_changed',
      'question_blocking',
      'question_answered',
      'answer_applied',
      'question_created',
      'question_terminal',
      'question_created',
      'question_answered',
      'answer_needs_attention',
      'question_created',
      'question_answered',
      'delivery_failed',
    ]);
    for (const record of state.visibleChanges) {
      expect(record.occurredAt).toMatch(/^2026-08-12T/);
      expect(record.eventId).toMatch(/^evt_/);
    }
    expect(state.visibleChanges[1]?.change).toMatchObject({
      kind: 'update_changed',
      updateKind: 'blocked',
    });
  });

  it('ignores queued delivery, viewed, idempotent duplicates, and clears records on reset', () => {
    const { state, first } = buildVisibleCategories();
    const before = state.visibleChanges.length;
    expect(reduceBoardEvent(state, first)).toMatchObject({ ok: true, idempotent: true, state });
    const viewedAt = time();
    const viewed = event('board.viewed', 'user', 'ui:view-visible-log', viewedAt, {
      cutoffAt: viewedAt,
    });
    const viewedState = apply(state, viewed);
    expect(viewedState.visibleChanges).toHaveLength(before);
    const resetAt = time();
    const resetState = apply(
      viewedState,
      event('board.reset', 'user', 'ui:reset-visible-log', resetAt, {
        resetAt,
        reason: 'Reset test.',
      }),
    );
    expect(resetState.visibleChanges).toEqual([]);
  });

  it('deep-freezes records, retains no event aliases, and does not mutate prior state', () => {
    eventNumber = 0;
    minute = 0;
    const empty = createEmptyBoardState();
    const createdAt = time();
    const next = upsert(UPDATE_1, 'U-1', 1, 'working', createdAt) as Extract<
      BoardEvent,
      { eventType: 'update.upserted' }
    >;
    const result = reduceBoardEvent(empty, next);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.state.visibleChanges[0];
    if (record === undefined) throw new Error('record missing');
    next.payload.fields.attachments as unknown as unknown[];
    (next.payload.fields as { title: string }).title = 'Caller mutation';
    expect(record.change).toMatchObject({ kind: 'update_created', updateKind: 'working' });
    expect(result.state.updates.get(UPDATE_1)?.title).toBe('U-1 working');
    expect(empty.visibleChanges).toEqual([]);
    expect(Object.isFrozen(result.state.visibleChanges)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.change)).toBe(true);
    expect(() => (result.state.visibleChanges as unknown[]).push(record)).toThrow(TypeError);
  });
});
