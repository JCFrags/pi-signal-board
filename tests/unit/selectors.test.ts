import { describe, expect, it } from 'vitest';

import type { AnswerId, QuestionId, UpdateId } from '../../src/domain/ids.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import {
  selectActionableQuestions,
  selectActiveUpdates,
  selectBoardCounts,
  selectCatchUp,
  selectDecisions,
  selectHistory,
  selectInboxQuestions,
  selectSummary,
  selectUnreadChanges,
  selectWidgetCandidates,
} from '../../src/domain/selectors.js';
import type {
  AnswerAcknowledgement,
  AnswerRecord,
  BoardState,
  QuestionItem,
  QuestionStatus,
  UpdateItem,
  UpdateKind,
  VisibleChangeRecord,
} from '../../src/domain/types.js';

const T = (minute: number): string => `2026-08-12T10:${minute.toString().padStart(2, '0')}:00.000Z`;
const updateId = (value: number): UpdateId =>
  `upd_10000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const questionId = (value: number): QuestionId =>
  `qst_20000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const answerId = (value: number): AnswerId =>
  `ans_30000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function update(
  sequence: number,
  kind: UpdateKind,
  minute: number,
  extra: { [Key in keyof UpdateItem]?: UpdateItem[Key] | undefined } = {},
): UpdateItem {
  return {
    id: updateId(sequence),
    displayId: `U-${sequence}`,
    revision: 1,
    kind,
    title: `Update ${sequence}`,
    attachments: [],
    createdAt: T(0),
    updatedAt: T(minute),
    ...(kind === 'completed' || kind === 'failed' ? { completedAt: T(minute) } : {}),
    archived: false,
    lastEventId: `evt_40000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    lastCommandId: `tool:update-${sequence}`,
    ...extra,
  } as UpdateItem;
}

function question(
  sequence: number,
  status: QuestionStatus,
  minute: number,
  extra: { [Key in keyof QuestionItem]?: QuestionItem[Key] | undefined } = {},
): QuestionItem {
  const id = questionId(sequence);
  return {
    id,
    displayId: `Q-${sequence}`,
    revision: 1,
    question: `Question ${sequence}?`,
    reason: `Reason ${sequence}.`,
    class: 'reversible',
    response: {
      kind: 'single',
      options: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
    },
    recommendation: `Recommendation ${sequence}.`,
    recommendedOptionIds: ['one'],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    status,
    createdAt: T(sequence),
    updatedAt: T(minute),
    lastEventId: `evt_50000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    lastCommandId: `tool:question-${sequence}`,
    ...extra,
  } as QuestionItem;
}

function answer(sequence: number, questionValue: QuestionItem): AnswerRecord {
  return {
    id: answerId(sequence),
    questionId: questionValue.id,
    questionDisplayId: questionValue.displayId,
    questionRevision: questionValue.revision,
    source: 'manual',
    value: { kind: 'single', optionId: 'one' },
    answeredAt: T(20 + sequence),
    deliveryStatus: 'acknowledged',
    deliveryAttempts: [{ attempt: 1, at: T(21 + sequence), mode: 'steer', outcome: 'queued' }],
    lastEventId: `evt_60000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
  };
}

function acknowledgement(
  sequence: number,
  questionValue: QuestionItem,
  outcome: AnswerAcknowledgement['outcome'],
  decisionId?: `D-${number}`,
): AnswerAcknowledgement {
  return {
    answerId: answerId(sequence),
    questionId: questionValue.id,
    outcome,
    summary: `Acknowledgement ${sequence}.`,
    resultingUpdateIds: [],
    attachments: [],
    acknowledgedAt: T(30 + sequence),
    eventId: `evt_70000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    commandId: `tool:ack-${sequence}`,
    ...(decisionId === undefined ? {} : { decisionDisplayId: decisionId }),
  };
}

function stateWith(overrides: Partial<BoardState>): BoardState {
  return { ...createEmptyBoardState(), ...overrides };
}

function fixtureState(): BoardState {
  const updates = [
    update(1, 'blocked', 9),
    update(2, 'failed', 8),
    update(3, 'warning', 7),
    update(4, 'working', 6),
    update(5, 'finding', 5),
    update(6, 'completed', 4),
    update(7, 'completed', 3, { archived: true, archivedAt: T(10), updatedAt: T(10) }),
  ];
  const appliedQuestion = question(7, 'resolved', 37, {
    answerId: answerId(7),
    resolvedAt: T(37),
  });
  const supersededQuestion = question(8, 'resolved', 38, {
    answerId: answerId(8),
    resolvedAt: T(38),
  });
  const duplicateQuestion = question(9, 'resolved', 39, {
    answerId: answerId(9),
    resolvedAt: T(39),
  });
  const questions = [
    question(1, 'delivery_failed', 9, { answerId: answerId(1) }),
    question(2, 'needs_attention', 8, { answerId: answerId(2) }),
    question(3, 'blocking', 7),
    question(4, 'pending', 6, { priority: 'high' }),
    question(5, 'pending', 5),
    question(6, 'delivery_queued', 4, { answerId: answerId(6) }),
    appliedQuestion,
    supersededQuestion,
    duplicateQuestion,
    question(10, 'cancelled', 40, { cancelledAt: T(40) }),
    question(11, 'dismissed', 41, { dismissedAt: T(41) }),
    question(12, 'stale', 42, { staleAt: T(42) }),
  ];
  const answers = [
    answer(7, appliedQuestion),
    answer(8, supersededQuestion),
    answer(9, duplicateQuestion),
  ];
  const acknowledgements = [
    acknowledgement(7, appliedQuestion, 'applied', 'D-1'),
    acknowledgement(8, supersededQuestion, 'superseded', 'D-2'),
    acknowledgement(9, duplicateQuestion, 'duplicate'),
  ];
  return stateWith({
    updates: new Map(updates.map((item) => [item.id, item])),
    questions: new Map(questions.map((item) => [item.id, item])),
    answers: new Map(answers.map((item) => [item.id, item])),
    acknowledgements: new Map(acknowledgements.map((item) => [item.answerId, item])),
  });
}

describe('SB-011 selectors and projections', () => {
  it('selects active updates and actionable or Inbox questions in stable order', () => {
    const state = fixtureState();
    expect(selectActiveUpdates(state).map((item) => item.displayId)).toEqual([
      'U-1',
      'U-3',
      'U-4',
      'U-5',
    ]);
    expect(selectActionableQuestions(state).map((item) => item.displayId)).toEqual([
      'Q-1',
      'Q-2',
      'Q-3',
      'Q-4',
      'Q-5',
    ]);
    expect(selectInboxQuestions(state).map((item) => item.displayId)).toEqual([
      'Q-1',
      'Q-2',
      'Q-3',
      'Q-4',
      'Q-5',
      'Q-6',
    ]);
  });

  it('ranks every widget group with total deterministic ties and a completion cutoff', () => {
    const state = fixtureState();
    expect(
      selectWidgetCandidates(state, T(4)).map((candidate) => candidate.item.displayId),
    ).toEqual(['Q-1', 'Q-2', 'Q-3', 'Q-4', 'U-1', 'U-2', 'U-3', 'U-4', 'U-5', 'Q-5', 'U-6']);
    expect(selectWidgetCandidates(state, T(5)).some((item) => item.item.displayId === 'U-6')).toBe(
      false,
    );
  });

  it('projects newest-first bounded history for every required terminal status', () => {
    const history = selectHistory(fixtureState(), 5);
    expect(history).toMatchObject({ total: 9, truncated: true });
    expect(history.items.map((entry) => entry.item.displayId)).toEqual([
      'Q-12',
      'Q-11',
      'Q-10',
      'Q-9',
      'Q-8',
    ]);
    expect(selectHistory(fixtureState(), 0).items).toEqual([]);
  });

  it('uses replay-safe timestamp fallbacks and total ID ties for defensive projections', () => {
    const tiedPending = [
      question(20, 'pending', 20, { displayId: 'Q-20', createdAt: T(20) }),
      question(21, 'pending', 20, { displayId: 'Q-20', createdAt: T(20) }),
      question(22, 'answered', 22, { answerId: answerId(22) }),
    ];
    const fallbackHistory = [
      update(20, 'completed', 20, { completedAt: undefined }),
      update(21, 'working', 21, { archived: true, archivedAt: undefined }),
    ];
    const terminalQuestions = [
      question(23, 'cancelled', 23),
      question(24, 'dismissed', 24),
      question(25, 'stale', 25),
      question(26, 'resolved', 26),
    ];
    const state = stateWith({
      updates: new Map(fallbackHistory.map((item) => [item.id, item])),
      questions: new Map([...tiedPending, ...terminalQuestions].map((item) => [item.id, item])),
    });
    expect(selectInboxQuestions(state).map((item) => item.id)).toEqual([
      questionId(20),
      questionId(21),
      questionId(22),
    ]);
    expect(selectHistory(state).items.map((entry) => entry.terminalAt)).toEqual([
      T(26),
      T(25),
      T(24),
      T(23),
      T(21),
      T(20),
    ]);
  });

  it('derives only complete applied and superseded decisions with exact FR-130 fields', () => {
    const decisions = selectDecisions(fixtureState());
    expect(decisions.map((decision) => decision.id)).toEqual(['D-2', 'D-1']);
    expect(decisions[0]).toMatchObject({
      actor: 'user',
      question: 'Question 8?',
      reason: 'Reason 8.',
      recommendation: 'Recommendation 8.',
      answer: { kind: 'single', optionId: 'one' },
      acknowledgement: { outcome: 'superseded', summary: 'Acknowledgement 8.' },
      decidedAt: T(38),
      resolvedAt: T(38),
    });
    const partial = fixtureState();
    const applied = partial.questions.get(questionId(7));
    if (applied === undefined) throw new Error('applied question fixture missing');
    const incompleteAck = acknowledgement(7, applied, 'applied');
    expect(
      selectDecisions(
        stateWith({
          ...partial,
          acknowledgements: new Map([[incompleteAck.answerId, incompleteAck]]),
        }),
      ),
    ).toEqual([]);
    for (const outcome of ['duplicate', 'partially_applied', 'cannot_apply'] as const) {
      const excluded = acknowledgement(7, applied, outcome, 'D-99');
      expect(
        selectDecisions(
          stateWith({
            ...partial,
            acknowledgements: new Map([[excluded.answerId, excluded]]),
          }),
        ),
        outcome,
      ).toEqual([]);
    }
  });

  it('returns concise counts and a bounded summary without marking viewed', () => {
    const state = fixtureState();
    const summary = selectSummary(state, 3, T(59));
    expect(summary.items).toHaveLength(3);
    expect(summary).toMatchObject({ totalItems: 9, omittedItems: 6 });
    expect(summary.counts).toMatchObject({
      activeUpdates: 4,
      actionableQuestions: 5,
      inboxQuestions: 6,
      decisions: 2,
      history: 9,
      unread: 0,
    });
    expect(state.lastViewedAt).toBeUndefined();
    expect(selectBoardCounts(state)).toMatchObject({ unread: 0 });
  });

  it('applies strict cutoff boundaries, precedence, coalescing, and later-event exclusion', () => {
    const records: VisibleChangeRecord[] = [
      record(1, T(10), { kind: 'update_created', itemId: updateId(1), updateKind: 'working' }),
      record(2, T(11), { kind: 'update_changed', itemId: updateId(1), updateKind: 'working' }),
      record(3, T(12), { kind: 'update_changed', itemId: updateId(1), updateKind: 'blocked' }),
      record(4, T(13), { kind: 'update_completed', itemId: updateId(1), updateKind: 'completed' }),
      record(5, T(11), { kind: 'question_created', itemId: questionId(1) }),
      record(6, T(12), { kind: 'delivery_failed', itemId: questionId(1) }),
      record(7, T(14), { kind: 'answer_applied', itemId: questionId(2) }),
      record(8, T(15), { kind: 'answer_needs_attention', itemId: questionId(3) }),
    ];
    const state = stateWith({ lastViewedAt: T(10), visibleChanges: records });
    const catchUp = selectCatchUp(state, T(14));
    expect(catchUp.items.map((item) => [item.itemId, item.category, item.occurredAt])).toEqual([
      [questionId(1), 'delivery_attention', T(12)],
      [updateId(1), 'blocked_failed', T(12)],
      [questionId(2), 'completed_applied', T(14)],
    ]);
    expect(catchUp.counts).toEqual({
      delivery_attention: 1,
      blocked_failed: 1,
      question: 0,
      completed_applied: 1,
      update: 0,
    });
    expect(selectUnreadChanges(state, T(14))).toEqual(catchUp.items);
    expect(selectUnreadChanges(state, T(15))[0]).toMatchObject({
      itemId: questionId(3),
      category: 'delivery_attention',
    });
  });

  it('uses newest change and event ID as stable ties within one precedence', () => {
    const state = stateWith({
      visibleChanges: [
        record(2, T(11), { kind: 'question_changed', itemId: questionId(1) }),
        record(1, T(11), { kind: 'question_created', itemId: questionId(1) }),
        record(3, T(12), { kind: 'update_changed', itemId: updateId(2), updateKind: 'warning' }),
        record(4, T(13), { kind: 'update_changed', itemId: updateId(2), updateKind: 'finding' }),
      ],
    });
    const unread = selectUnreadChanges(state, T(20));
    expect(unread).toMatchObject([
      { eventId: expect.stringContaining('000000000001'), category: 'question' },
      { eventId: expect.stringContaining('000000000004'), category: 'update' },
    ]);
  });

  it('returns equal frozen copies and does not expose or mutate input aliases', () => {
    const state = fixtureState();
    const before = structuredClone({
      updates: [...state.updates],
      questions: [...state.questions],
    });
    const first = selectSummary(state, 10);
    const second = selectSummary(state, 10);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.items)).toBe(true);
    expect(first.items[0]?.item).not.toBe(
      first.items[0]?.entityType === 'question'
        ? state.questions.get(first.items[0].item.id as QuestionId)
        : state.updates.get(first.items[0]?.item.id as UpdateId),
    );
    expect(() => (first.items as unknown[]).push(first.items[0])).toThrow(TypeError);
    expect({ updates: [...state.updates], questions: [...state.questions] }).toEqual(before);
  });

  it('handles a large deterministic fixture without insertion-order dependence', () => {
    const values = Array.from({ length: 2_000 }, (_, index) =>
      update(index + 1, index % 5 === 0 ? 'blocked' : 'working', index % 59),
    );
    const forward = stateWith({ updates: new Map(values.map((item) => [item.id, item])) });
    const reverse = stateWith({
      updates: new Map([...values].reverse().map((item) => [item.id, item])),
    });
    expect(selectActiveUpdates(forward)).toEqual(selectActiveUpdates(reverse));
    expect(selectWidgetCandidates(forward, T(59))).toEqual(selectWidgetCandidates(reverse, T(59)));
  });
});

function record(
  sequence: number,
  occurredAt: string,
  change: VisibleChangeRecord['change'],
): VisibleChangeRecord {
  return {
    eventId: `evt_80000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    occurredAt,
    change,
  };
}
