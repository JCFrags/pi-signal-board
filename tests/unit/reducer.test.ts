import { describe, expect, it } from 'vitest';

import type { BoardEvent, BoardEventType } from '../../src/domain/events.js';
import {
  createEmptyBoardState,
  type ReduceResult,
  reduceBoardEvent,
} from '../../src/domain/reducer.js';
import type { BoardState, QuestionSpec } from '../../src/domain/types.js';

const UPDATE = 'upd_10000000-0000-4000-8000-000000000001' as const;
const QUESTION = 'qst_20000000-0000-4000-8000-000000000001' as const;
const ANSWER = 'ans_30000000-0000-4000-8000-000000000001' as const;
const BASE_TIME = Date.parse('2026-08-08T20:00:00.000Z');
const PROVIDER_QUALIFIED_COMMAND_ID =
  'tool:call_Z6LPv0kJq22rXsNP67ojPhlg|fc_068d35c2414bddfc016a7c4fb7e8f4819881a1ba59d0364046' as const;

let eventSequence = 0;
function nextEventId(): `evt_${string}` {
  eventSequence += 1;
  return `evt_40000000-0000-4000-8000-${eventSequence.toString().padStart(12, '0')}`;
}
function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}
function envelope<T extends BoardEventType>(
  eventType: T,
  actor: BoardEvent['actor'],
  commandId: BoardEvent['commandId'],
  occurredAt: string,
  payload: Extract<BoardEvent, { eventType: T }>['payload'],
): Extract<BoardEvent, { eventType: T }> {
  return {
    schemaVersion: 1,
    eventId: nextEventId(),
    eventType,
    occurredAt,
    actor,
    commandId,
    payload,
  } as Extract<BoardEvent, { eventType: T }>;
}

const baseSpec: QuestionSpec = {
  question: 'Keep compatibility?',
  reason: 'The old parser remains in use.',
  class: 'reversible',
  response: {
    kind: 'single_or_text',
    options: [
      { id: 'keep', label: 'Keep' },
      { id: 'remove', label: 'Remove' },
    ],
  },
  recommendation: 'Keep it for one release.',
  recommendedOptionIds: ['keep'],
  priority: 'normal',
  blockingPolicy: 'when_agent_settles',
  deliveryMode: 'steer',
  affectedWork: ['Parser'],
  continuingWork: ['Tests'],
  attachments: [],
};

function accepted(state: BoardState, event: BoardEvent): BoardState {
  const result = reduceBoardEvent(state, event);
  expect(result, `${event.eventType} must be accepted`).toMatchObject({
    ok: true,
    idempotent: false,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

function updateCreated(minutes = 0): BoardEvent {
  return envelope('update.upserted', 'agent', `tool:update-${minutes}`, at(minutes), {
    updateId: UPDATE,
    displayId: 'U-1',
    revision: 1,
    createdAt: at(minutes),
    updatedAt: at(minutes),
    fields: { key: 'build', kind: 'working', title: 'Build reducer', attachments: [] },
  });
}
function questionCreated(
  id: `qst_${string}` = QUESTION,
  displayId: `Q-${number}` = 'Q-1',
  minutes = 2,
): BoardEvent {
  return envelope('question.created', 'agent', `tool:question-${displayId}`, at(minutes), {
    questionId: id,
    displayId,
    revision: 1,
    createdAt: at(minutes),
    spec: baseSpec,
  });
}

function buildAllTransitions(): { state: BoardState; events: BoardEvent[] } {
  eventSequence = 0;
  let state = createEmptyBoardState();
  const events: BoardEvent[] = [];
  const apply = (event: BoardEvent): void => {
    events.push(event);
    state = accepted(state, event);
  };
  apply(updateCreated());
  apply(
    envelope('update.archived', 'user', 'ui:archive-1', at(1), {
      updateId: UPDATE,
      expectedRevision: 1,
      revision: 2,
      archivedAt: at(1),
    }),
  );
  apply(questionCreated());
  apply(
    envelope('question.revised', 'agent', 'tool:revise-1', at(3), {
      questionId: QUESTION,
      expectedRevision: 1,
      revision: 2,
      updatedAt: at(3),
      revisionSummary: 'Added current evidence.',
      spec: { ...baseSpec, reason: 'New evidence supports one compatibility release.' },
    }),
  );
  apply(
    envelope('question.escalated', 'system', 'system:escalate:q1:2', at(4), {
      questionId: QUESTION,
      expectedRevision: 2,
      revision: 3,
      escalatedAt: at(4),
    }),
  );
  apply(
    envelope('question.answered', 'user', 'ui:answer-1', at(5), {
      questionId: QUESTION,
      expectedRevision: 3,
      answer: {
        id: ANSWER,
        questionId: QUESTION,
        questionDisplayId: 'Q-1',
        questionRevision: 3,
        source: 'recommendation',
        value: { kind: 'single_or_text', optionId: 'keep' },
        answeredAt: at(5),
      },
    }),
  );
  apply(
    envelope('answer.delivery_failed', 'system', 'system:deliver:a1:1', at(6), {
      answerId: ANSWER,
      questionId: QUESTION,
      attempt: 1,
      at: at(6),
      mode: 'steer',
      errorCode: 'SB_DELIVERY_FAILED',
      errorCategory: 'host_rejected',
    }),
  );
  apply(
    envelope('answer.delivery_queued', 'system', 'system:deliver:a1:2', at(7), {
      answerId: ANSWER,
      questionId: QUESTION,
      attempt: 2,
      at: at(7),
      mode: 'steer',
    }),
  );
  apply(
    envelope('answer.acknowledged', 'agent', 'tool:ack-1', at(8), {
      acknowledgement: {
        answerId: ANSWER,
        questionId: QUESTION,
        outcome: 'applied',
        summary: 'Compatibility was retained.',
        resultingUpdateIds: [UPDATE],
        attachments: [],
        acknowledgedAt: at(8),
      },
    }),
  );

  const q2 = 'qst_20000000-0000-4000-8000-000000000002' as const;
  apply(questionCreated(q2, 'Q-2', 9));
  apply(
    envelope('question.cancelled', 'agent', 'tool:cancel-2', at(10), {
      questionId: q2,
      expectedRevision: 1,
      revision: 2,
      cancelledAt: at(10),
      reason: 'No longer needed.',
    }),
  );
  const q3 = 'qst_20000000-0000-4000-8000-000000000003' as const;
  apply(
    envelope('question.created', 'agent', 'tool:question-Q-3', at(11), {
      questionId: q3,
      displayId: 'Q-3',
      revision: 1,
      createdAt: at(11),
      spec: { ...baseSpec, expiresAt: at(12) },
    }),
  );
  apply(
    envelope('question.staled', 'system', 'system:stale:q3:1', at(13), {
      questionId: q3,
      expectedRevision: 1,
      revision: 2,
      staleAt: at(13),
      reason: 'Expired.',
    }),
  );
  const q4 = 'qst_20000000-0000-4000-8000-000000000004' as const;
  apply(questionCreated(q4, 'Q-4', 14));
  apply(
    envelope('question.dismissed', 'user', 'ui:dismiss-4', at(15), {
      questionId: q4,
      expectedRevision: 1,
      revision: 2,
      dismissedAt: at(15),
    }),
  );
  apply(envelope('board.viewed', 'user', 'ui:view-1', at(17), { cutoffAt: at(16) }));
  apply(
    envelope('board.reset', 'user', 'ui:reset-1', at(18), {
      resetAt: at(18),
      reason: 'Start a new logical board.',
    }),
  );
  return { state, events };
}

describe('SB-010 pure reducer transitions', () => {
  it('accepts all 14 event types and preserves lifecycle detail', () => {
    const { state, events } = buildAllTransitions();
    expect(new Set(events.map((event) => event.eventType)).size).toBe(14);
    expect(state.updates.size).toBe(0);
    expect(state.questions.size).toBe(0);
    expect(state.counters).toEqual({ nextUpdate: 1, nextQuestion: 1, nextDecision: 1 });
    expect(state.resetEventId).toBe(events.at(-1)?.eventId);
    expect(state.commandResults.size).toBe(1);
    expect(state.acceptedEventIds.size).toBe(1);
  });

  it('derives stable decision IDs and required acknowledgement relations', () => {
    const { events } = buildAllTransitions();
    let state = createEmptyBoardState();
    for (const event of events.slice(0, 9)) state = accepted(state, event);
    expect(state.acknowledgements.get(ANSWER)?.decisionDisplayId).toBe('D-1');
    expect(state.counters.nextDecision).toBe(2);
    expect(state.questions.get(QUESTION)).toMatchObject({
      status: 'resolved',
      revisionSummary: 'Added current evidence.',
    });
  });

  it('rejects acknowledgement directly after failed delivery', () => {
    const { events } = buildAllTransitions();
    let state = createEmptyBoardState();
    for (const event of events.slice(0, 7)) state = accepted(state, event);
    expect(state.questions.get(QUESTION)?.status).toBe('delivery_failed');
    const acknowledgement = envelope(
      'answer.acknowledged',
      'agent',
      'tool:ack-after-failure',
      at(7),
      {
        acknowledgement: {
          answerId: ANSWER,
          questionId: QUESTION,
          outcome: 'applied',
          summary: 'Must not apply before a queued retry.',
          resultingUpdateIds: [UPDATE],
          attachments: [],
          acknowledgedAt: at(7),
        },
      },
    );
    expect(reduceBoardEvent(state, acknowledgement)).toMatchObject({
      ok: false,
      code: 'SB_STATE_CONFLICT',
    });
    expect(state.questions.get(QUESTION)?.status).toBe('delivery_failed');
    expect(state.acknowledgements.size).toBe(0);
  });

  it('rejects one invalid state/event pair for every event type without changing state', () => {
    eventSequence = 100;
    const empty = createEmptyBoardState();
    const bad: readonly BoardEvent[] = [
      {
        ...updateCreated(),
        payload: { ...updateCreated().payload, displayId: 'U-2' },
      } as BoardEvent,
      envelope('update.archived', 'user', 'ui:x1', at(1), {
        updateId: UPDATE,
        expectedRevision: 1,
        revision: 2,
        archivedAt: at(1),
      }),
      envelope('question.created', 'agent', 'tool:x2', at(2), {
        questionId: QUESTION,
        displayId: 'Q-1',
        revision: 1,
        createdAt: at(2),
        spec: { ...baseSpec, class: 'authorization' },
      }),
      envelope('question.revised', 'agent', 'tool:x3', at(3), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        updatedAt: at(3),
        revisionSummary: 'Change.',
        spec: baseSpec,
      }),
      envelope('question.cancelled', 'agent', 'tool:x4', at(4), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        cancelledAt: at(4),
        reason: 'Stop.',
      }),
      envelope('question.escalated', 'system', 'system:x5', at(5), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        escalatedAt: at(5),
      }),
      envelope('question.staled', 'system', 'system:x6', at(6), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        staleAt: at(6),
        reason: 'Expired.',
      }),
      envelope('question.dismissed', 'user', 'ui:x7', at(7), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        dismissedAt: at(7),
      }),
      envelope('question.answered', 'user', 'ui:x8', at(8), {
        questionId: QUESTION,
        expectedRevision: 1,
        answer: {
          id: ANSWER,
          questionId: QUESTION,
          questionDisplayId: 'Q-1',
          questionRevision: 1,
          source: 'manual',
          value: { kind: 'single_or_text', optionId: 'keep' },
          answeredAt: at(8),
        },
      }),
      envelope('answer.delivery_queued', 'system', 'system:x9', at(9), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 1,
        at: at(9),
        mode: 'steer',
      }),
      envelope('answer.delivery_failed', 'system', 'system:x10', at(10), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 1,
        at: at(10),
        mode: 'steer',
        errorCode: 'SB_DELIVERY_FAILED',
        errorCategory: 'unknown',
      }),
      envelope('answer.acknowledged', 'agent', 'tool:x11', at(11), {
        acknowledgement: {
          answerId: ANSWER,
          questionId: QUESTION,
          outcome: 'applied',
          summary: 'Done.',
          resultingUpdateIds: [],
          attachments: [],
          acknowledgedAt: at(11),
        },
      }),
      envelope('board.viewed', 'user', 'ui:x12', at(12), { cutoffAt: at(13) }),
      envelope('board.reset', 'user', 'ui:x13', at(13), { resetAt: at(13), reason: '' }),
    ];
    expect(new Set(bad.map((event) => event.eventType)).size).toBe(14);
    for (const event of bad) {
      const before = createEmptyBoardState();
      const result = reduceBoardEvent(empty, event);
      expect(result.ok, event.eventType).toBe(false);
      expect(empty).toEqual(before);
    }
  });

  it('handles exact and conflicting duplicate event and command IDs', () => {
    eventSequence = 0;
    const event = { ...updateCreated(), commandId: PROVIDER_QUALIFIED_COMMAND_ID } as BoardEvent;
    const state = accepted(createEmptyBoardState(), event);
    expect(state.commandResults.has(PROVIDER_QUALIFIED_COMMAND_ID)).toBe(true);
    expect(reduceBoardEvent(state, event)).toMatchObject({
      ok: true,
      state,
      idempotent: true,
      visibleChange: { kind: 'none' },
    });
    const sameCommand = { ...event, eventId: nextEventId() } as BoardEvent;
    expect(reduceBoardEvent(state, sameCommand)).toMatchObject({
      ok: true,
      state,
      idempotent: true,
    });
    const commandConflict = {
      ...sameCommand,
      payload: {
        ...sameCommand.payload,
        fields: {
          ...(sameCommand as Extract<BoardEvent, { eventType: 'update.upserted' }>).payload.fields,
          title: 'Different',
        },
      },
    } as BoardEvent;
    expect(reduceBoardEvent(state, commandConflict)).toMatchObject({
      ok: false,
      code: 'SB_STATE_CONFLICT',
    });
    const eventCollision = {
      ...event,
      commandId: 'tool:other',
      payload: {
        ...(event as Extract<BoardEvent, { eventType: 'update.upserted' }>).payload,
        fields: {
          ...(event as Extract<BoardEvent, { eventType: 'update.upserted' }>).payload.fields,
          title: 'Collision',
        },
      },
    } as BoardEvent;
    expect(reduceBoardEvent(state, eventCollision)).toMatchObject({
      ok: false,
      code: 'SB_STATE_CONFLICT',
    });
  });

  it('classifies invariant, revision, lifecycle, and relationship rejections', () => {
    eventSequence = 500;
    const empty = createEmptyBoardState();
    const createUpdate = updateCreated();
    const updateState = accepted(empty, createUpdate);
    const updateMutation = envelope('update.upserted', 'agent', 'tool:update-mutation', at(1), {
      ...(createUpdate as Extract<BoardEvent, { eventType: 'update.upserted' }>).payload,
      revision: 2,
      updatedAt: at(1),
      fields: { key: 'build', kind: 'completed', title: 'Build reducer', attachments: [] },
      completedAt: at(1),
    });
    expect(accepted(updateState, updateMutation).updates.get(UPDATE)).toMatchObject({
      revision: 2,
      kind: 'completed',
      stage: 'complete',
    });
    const updateCases: BoardEvent[] = [
      { ...createUpdate, commandId: 'ui:wrong-owner', eventId: nextEventId() } as BoardEvent,
      {
        ...createUpdate,
        eventId: nextEventId(),
        commandId: 'tool:bad-update',
        payload: {
          ...(createUpdate as Extract<BoardEvent, { eventType: 'update.upserted' }>).payload,
          revision: 0,
        },
      } as BoardEvent,
      {
        ...updateMutation,
        eventId: nextEventId(),
        commandId: 'tool:bad-revision',
        payload: { ...updateMutation.payload, revision: 4 },
      } as BoardEvent,
      {
        ...updateMutation,
        eventId: nextEventId(),
        commandId: 'tool:no-op',
        payload: {
          ...updateMutation.payload,
          revision: 2,
          fields: (createUpdate as Extract<BoardEvent, { eventType: 'update.upserted' }>).payload
            .fields,
        },
      } as BoardEvent,
      envelope('update.archived', 'user', 'ui:archive-invalid', at(2), {
        updateId: UPDATE,
        expectedRevision: 0,
        revision: 2,
        archivedAt: at(2),
      }),
      envelope('update.archived', 'user', 'ui:archive-revision', at(2), {
        updateId: UPDATE,
        expectedRevision: 2,
        revision: 3,
        archivedAt: at(2),
      }),
    ];
    for (const event of updateCases) expect(reduceBoardEvent(updateState, event).ok).toBe(false);

    const qCreate = questionCreated();
    const questionState = accepted(empty, qCreate);
    const malformedCreate = {
      ...questionCreated('qst_20000000-0000-4000-8000-000000000002', 'Q-1', 3),
      payload: {
        ...(questionCreated() as Extract<BoardEvent, { eventType: 'question.created' }>).payload,
        createdAt: 'bad',
      },
    } as BoardEvent;
    expect(reduceBoardEvent(questionState, malformedCreate).ok).toBe(false);
    expect(
      reduceBoardEvent(questionState, {
        ...qCreate,
        eventId: nextEventId(),
        commandId: 'tool:duplicate-question',
      } as BoardEvent).ok,
    ).toBe(false);
    const revise = envelope('question.revised', 'agent', 'tool:revise-test', at(3), {
      questionId: QUESTION,
      expectedRevision: 1,
      revision: 2,
      updatedAt: at(3),
      revisionSummary: 'Changed.',
      spec: { ...baseSpec, reason: 'Changed reason.' },
    });
    expect(
      reduceBoardEvent(questionState, {
        ...revise,
        payload: { ...revise.payload, spec: { ...baseSpec, class: 'authorization' } },
      }).ok,
    ).toBe(false);
    expect(
      reduceBoardEvent(questionState, {
        ...revise,
        eventId: nextEventId(),
        commandId: 'tool:revise-malformed',
        payload: { ...revise.payload, revisionSummary: '' },
      }).ok,
    ).toBe(false);
    expect(
      reduceBoardEvent(questionState, {
        ...revise,
        eventId: nextEventId(),
        commandId: 'tool:revise-revision',
        payload: { ...revise.payload, revision: 3 },
      }).ok,
    ).toBe(false);
    expect(
      reduceBoardEvent(questionState, {
        ...revise,
        eventId: nextEventId(),
        commandId: 'tool:revise-noop',
        payload: { ...revise.payload, spec: baseSpec },
      }).ok,
    ).toBe(false);

    const terminalCases: BoardEvent[] = [
      envelope('question.cancelled', 'agent', 'tool:cancel-bad', at(4), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 3,
        cancelledAt: at(4),
        reason: 'Stop.',
      }),
      envelope('question.staled', 'system', 'system:stale-no-expiry', at(4), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        staleAt: at(4),
        reason: 'Expired.',
      }),
      envelope('question.dismissed', 'user', 'ui:dismiss-bad', at(4), {
        questionId: QUESTION,
        expectedRevision: 0,
        revision: 2,
        dismissedAt: at(4),
      }),
      envelope('question.escalated', 'system', 'system:escalate-bad', at(4), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 3,
        escalatedAt: at(4),
      }),
      envelope('question.escalated', 'system', 'system:escalate-invalid', at(4), {
        questionId: QUESTION,
        expectedRevision: 0,
        revision: 2,
        escalatedAt: at(4),
      }),
    ];
    for (const event of terminalCases)
      expect(reduceBoardEvent(questionState, event).ok).toBe(false);
    const neverState = accepted(
      empty,
      envelope('question.created', 'agent', 'tool:q-never', at(2), {
        ...(qCreate as Extract<BoardEvent, { eventType: 'question.created' }>).payload,
        spec: { ...baseSpec, blockingPolicy: 'never' },
      }),
    );
    expect(
      reduceBoardEvent(
        neverState,
        envelope('question.escalated', 'system', 'system:never', at(3), {
          questionId: QUESTION,
          expectedRevision: 1,
          revision: 2,
          escalatedAt: at(3),
        }),
      ).ok,
    ).toBe(false);

    const escalated = accepted(
      questionState,
      envelope('question.escalated', 'system', 'system:ok', at(4), {
        questionId: QUESTION,
        expectedRevision: 1,
        revision: 2,
        escalatedAt: at(4),
      }),
    );
    const answerEvent = envelope('question.answered', 'user', 'ui:answer-test', at(5), {
      questionId: QUESTION,
      expectedRevision: 2,
      answer: {
        id: ANSWER,
        questionId: QUESTION,
        questionDisplayId: 'Q-1',
        questionRevision: 2,
        source: 'manual',
        value: { kind: 'single_or_text', optionId: 'keep' },
        answeredAt: at(5),
      },
    });
    expect(
      reduceBoardEvent(escalated, {
        ...answerEvent,
        payload: { ...answerEvent.payload, expectedRevision: 1 },
      }).ok,
    ).toBe(false);
    expect(
      reduceBoardEvent(escalated, {
        ...answerEvent,
        eventId: nextEventId(),
        commandId: 'ui:answer-invalid',
        payload: {
          ...answerEvent.payload,
          answer: { ...answerEvent.payload.answer, value: { kind: 'single_or_text' } },
        },
      } as unknown as BoardEvent).ok,
    ).toBe(false);
    const answered = accepted(escalated, answerEvent);
    const badDeliveries: BoardEvent[] = [
      envelope('answer.delivery_queued', 'system', 'system:deliver-invalid', at(6), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 0,
        at: at(6),
        mode: 'steer',
      }),
      envelope('answer.delivery_failed', 'system', 'system:deliver-code', at(6), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 1,
        at: at(6),
        mode: 'steer',
        errorCode: 'WRONG' as 'SB_DELIVERY_FAILED',
        errorCategory: 'unknown',
      }),
      envelope('answer.delivery_queued', 'system', 'system:deliver-mode', at(6), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 1,
        at: at(6),
        mode: 'nextTurn',
      }),
      envelope('answer.delivery_queued', 'system', 'system:deliver-attempt', at(6), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 2,
        at: at(6),
        mode: 'steer',
      }),
    ];
    for (const event of badDeliveries) expect(reduceBoardEvent(answered, event).ok).toBe(false);
    const delivered = accepted(
      answered,
      envelope('answer.delivery_queued', 'system', 'system:deliver-ok', at(6), {
        answerId: ANSWER,
        questionId: QUESTION,
        attempt: 1,
        at: at(6),
        mode: 'steer',
      }),
    );
    const ack = envelope('answer.acknowledged', 'agent', 'tool:ack-test', at(7), {
      acknowledgement: {
        answerId: ANSWER,
        questionId: QUESTION,
        outcome: 'cannot_apply',
        summary: 'Cannot apply.',
        resultingUpdateIds: [],
        attachments: [],
        acknowledgedAt: at(7),
      },
    });
    expect(
      reduceBoardEvent(delivered, {
        ...ack,
        payload: { acknowledgement: { ...ack.payload.acknowledgement, summary: '' } },
      }).ok,
    ).toBe(false);
    const acknowledged = accepted(delivered, ack);
    expect(acknowledged.questions.get(QUESTION)?.status).toBe('needs_attention');
    expect(
      reduceBoardEvent(acknowledged, {
        ...ack,
        eventId: nextEventId(),
        commandId: 'tool:ack-conflict',
        payload: { acknowledgement: { ...ack.payload.acknowledgement, outcome: 'applied' } },
      }).ok,
    ).toBe(false);
  });

  it('returns a stable failure for cyclic content and unexpected state access', () => {
    const cyclic = updateCreated() as unknown as Record<string, unknown>;
    (cyclic.payload as Record<string, unknown>).cycle = cyclic;
    expect(
      reduceBoardEvent(createEmptyBoardState(), cyclic as unknown as BoardEvent),
    ).toMatchObject({ ok: false, code: 'SB_INVALID_ARGUMENT' });
    const event = updateCreated();
    const broken = {
      ...createEmptyBoardState(),
      acceptedEventIds: new Proxy(new Map(), {
        get() {
          throw new Error('blocked');
        },
      }),
    } as BoardState;
    expect(reduceBoardEvent(broken, event)).toMatchObject({
      ok: false,
      code: 'SB_INVALID_ARGUMENT',
    });
  });

  it('rejects set, delete, and clear on every exposed state map', () => {
    const { events } = buildAllTransitions();
    let populated = createEmptyBoardState();
    for (const event of events.slice(0, 9)) populated = accepted(populated, event);
    const maps: readonly ReadonlyMap<unknown, unknown>[] = [
      populated.updates,
      populated.questions,
      populated.answers,
      populated.acknowledgements,
      populated.commandResults,
      populated.acceptedEventIds,
    ];
    const before = structuredClone({
      updates: new Map(populated.updates),
      questions: new Map(populated.questions),
      answers: new Map(populated.answers),
      acknowledgements: new Map(populated.acknowledgements),
      commandResults: new Map(populated.commandResults),
      acceptedEventIds: new Map(populated.acceptedEventIds),
    });
    for (const readonlyMap of maps) {
      const mutable = readonlyMap as Map<unknown, unknown>;
      expect(() => mutable.set('intruder', 'value')).toThrow(TypeError);
      expect(() => mutable.delete([...readonlyMap.keys()][0])).toThrow(TypeError);
      expect(() => mutable.clear()).toThrow(TypeError);
      expect(() => Map.prototype.set.call(readonlyMap, 'intruder', 'value')).toThrow(TypeError);
      expect(() => Map.prototype.delete.call(readonlyMap, [...readonlyMap.keys()][0])).toThrow(
        TypeError,
      );
      expect(() => Map.prototype.clear.call(readonlyMap)).toThrow(TypeError);
    }
    expect(new Map(populated.updates)).toEqual(before.updates);
    expect(new Map(populated.questions)).toEqual(before.questions);
    expect(new Map(populated.answers)).toEqual(before.answers);
    expect(new Map(populated.acknowledgements)).toEqual(before.acknowledgements);
    expect(new Map(populated.commandResults)).toEqual(before.commandResults);
    expect(new Map(populated.acceptedEventIds)).toEqual(before.acceptedEventIds);
  });

  it('does not mutate or retain mutable event inputs and freezes accepted values', () => {
    eventSequence = 0;
    const event = updateCreated() as Extract<BoardEvent, { eventType: 'update.upserted' }>;
    const attachments = event.payload.fields.attachments as unknown as Array<{
      kind: 'note';
      label: string;
      text: string;
    }>;
    attachments.push({ kind: 'note', label: 'Evidence', text: 'Initial' });
    const result = reduceBoardEvent(createEmptyBoardState(), event);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstAttachment = attachments[0];
    if (firstAttachment === undefined) throw new Error('fixture attachment missing');
    firstAttachment.text = 'Changed by caller';
    attachments.push({ kind: 'note', label: 'Later', text: 'Later' });
    expect(result.state.updates.get(UPDATE)?.attachments).toEqual([
      { kind: 'note', label: 'Evidence', text: 'Initial' },
    ]);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.updates)).toBe(true);
    expect(Object.isFrozen(result.state.updates.get(UPDATE)?.attachments)).toBe(true);
  });

  it('replays deterministically', () => {
    const { events } = buildAllTransitions();
    const replay = (): BoardState =>
      events.reduce((state, event) => accepted(state, event), createEmptyBoardState());
    expect(replay()).toEqual(replay());
  });

  it('never throws for 1,000 deterministic arbitrary events', () => {
    const seed = 0x5b010;
    let value = seed;
    const random = (): number => {
      value = (value * 1_664_525 + 1_013_904_223) >>> 0;
      return value;
    };
    let state = createEmptyBoardState();
    for (let index = 0; index < 1_000; index += 1) {
      const arbitrary =
        random() % 3 === 0
          ? null
          : random() % 3 === 1
            ? { eventType: String(random()) }
            : { schemaVersion: random(), eventType: 'board.reset', payload: { reason: random() } };
      let result: ReduceResult | undefined;
      expect(() => {
        result = reduceBoardEvent(state, arbitrary as unknown as BoardEvent);
      }, `seed=${seed} case=${index}`).not.toThrow();
      if (result?.ok) state = result.state;
    }
  });
});
