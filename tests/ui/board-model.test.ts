import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { EffectiveConfig } from '../../src/config/types.js';
import type { AnswerId, QuestionId, UpdateId } from '../../src/domain/ids.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
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
import { type BoardTab, boardModelFailure, buildBoardViewModel } from '../../src/ui/board/model.js';

const OPENED_AT = '2026-08-12T12:30:00.000Z';
const timestamp = (minute: number): string =>
  `2026-08-12T12:${minute.toString().padStart(2, '0')}:00.000Z`;
const updateId = (value: number): UpdateId =>
  `upd_61000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const questionId = (value: number): QuestionId =>
  `qst_62000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const answerId = (value: number): AnswerId =>
  `ans_63000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function update(
  sequence: number,
  kind: UpdateKind,
  minute: number,
  overrides: Partial<UpdateItem> = {},
): UpdateItem {
  return {
    id: updateId(sequence),
    displayId: `U-${sequence}`,
    revision: sequence,
    kind,
    title: `Update ${sequence}`,
    detail: `Detail ${sequence}`,
    stage: kind === 'completed' ? 'complete' : 'testing',
    progress: { current: sequence, total: 20, unit: 'tests' },
    attachments: [{ kind: 'file', label: 'Source', path: `src/${sequence}.ts` }],
    createdAt: timestamp(1),
    updatedAt: timestamp(minute),
    ...(kind === 'completed' || kind === 'failed' ? { completedAt: timestamp(minute) } : {}),
    archived: false,
    lastEventId: `evt_64000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    lastCommandId: `tool:update-${sequence}`,
    ...overrides,
  } as UpdateItem;
}

function question(
  sequence: number,
  status: QuestionStatus,
  minute: number,
  overrides: Partial<QuestionItem> = {},
): QuestionItem {
  return {
    id: questionId(sequence),
    displayId: `Q-${sequence}`,
    revision: sequence,
    question: `Question ${sequence}?`,
    reason: `Reason ${sequence}.`,
    class: 'reversible',
    response: {
      kind: 'single',
      options: [
        { id: 'first', label: 'First', description: 'First option.' },
        { id: 'second', label: 'Second' },
      ],
    },
    recommendation: 'Use first.',
    recommendedOptionIds: ['first'],
    temporaryDefault: { optionIds: ['second'], disclosure: 'Keep second while waiting.' },
    priority: 'normal',
    blockingPolicy: 'when_agent_settles',
    deliveryMode: 'nextTurn',
    affectedWork: [`Affected ${sequence}`],
    continuingWork: [`Continuing ${sequence}`],
    attachments: [{ kind: 'note', label: 'Evidence', text: `Note ${sequence}` }],
    status,
    createdAt: timestamp(minute),
    updatedAt: timestamp(minute),
    lastEventId: `evt_65000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    lastCommandId: `tool:question-${sequence}`,
    ...overrides,
  } as QuestionItem;
}

function answer(sequence: number, status: AnswerRecord['deliveryStatus']): AnswerRecord {
  return {
    id: answerId(sequence),
    questionId: questionId(sequence),
    questionDisplayId: `Q-${sequence}`,
    questionRevision: sequence,
    source: 'manual',
    value: { kind: 'single', optionId: 'first' },
    answeredAt: timestamp(20),
    deliveryStatus: status,
    deliveryAttempts: [
      { attempt: 1, at: timestamp(21), mode: 'nextTurn', outcome: 'queued' },
      ...(status === 'failed'
        ? [
            {
              attempt: 2,
              at: timestamp(22),
              mode: 'nextTurn' as const,
              outcome: 'failed' as const,
              errorCode: 'SB_DELIVERY_FAILED',
              errorCategory: 'host_rejected' as const,
            },
          ]
        : []),
    ],
    lastEventId: `evt_66000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
  };
}

function acknowledgement(
  sequence: number,
  outcome: AnswerAcknowledgement['outcome'],
  decisionDisplayId?: `D-${number}`,
): AnswerAcknowledgement {
  return {
    answerId: answerId(sequence),
    questionId: questionId(sequence),
    outcome,
    summary: `Acknowledgement ${sequence}.`,
    resultingUpdateIds: [updateId(1)],
    attachments: [{ kind: 'test_run', label: 'Tests', reference: `run-${sequence}` }],
    acknowledgedAt: timestamp(25 + (sequence % 5)),
    eventId: `evt_67000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    commandId: `tool:ack-${sequence}`,
    ...(decisionDisplayId === undefined ? {} : { decisionDisplayId }),
  };
}

function effectiveConfig(
  historyLimit = DEFAULT_CONFIG.limits.visibleHistoryLimit,
  completedMinutes = 10,
): EffectiveConfig {
  return {
    ...DEFAULT_CONFIG,
    widget: { ...DEFAULT_CONFIG.widget, showCompletedForMinutes: completedMinutes },
    limits: { ...DEFAULT_CONFIG.limits, visibleHistoryLimit: historyLimit },
    ui: { ...DEFAULT_CONFIG.ui },
  };
}

function stateWith(overrides: Partial<BoardState>): BoardState {
  return { ...createEmptyBoardState(), ...overrides };
}

function completeState(): BoardState {
  const updates = [
    update(1, 'working', 28),
    update(2, 'finding', 27),
    update(3, 'warning', 26),
    update(4, 'blocked', 25),
    update(5, 'completed', 24),
    update(6, 'failed', 10),
    update(7, 'working', 8, {
      archived: true,
      archivedAt: timestamp(29),
      updatedAt: timestamp(29),
    }),
  ];
  const questions = [
    question(1, 'pending', 1),
    question(2, 'blocking', 2),
    question(3, 'answered', 3, { answerId: answerId(3) }),
    question(4, 'delivery_queued', 4, { answerId: answerId(4) }),
    question(5, 'delivery_failed', 5, { answerId: answerId(5) }),
    question(6, 'needs_attention', 6, { answerId: answerId(6) }),
    question(7, 'resolved', 7, {
      answerId: answerId(7),
      resolvedAt: timestamp(27),
      updatedAt: timestamp(27),
    }),
    question(8, 'resolved', 8, {
      answerId: answerId(8),
      resolvedAt: timestamp(28),
      updatedAt: timestamp(28),
    }),
    question(9, 'stale', 9, {
      expiresAt: timestamp(15),
      staleAt: timestamp(23),
      updatedAt: timestamp(23),
      staleReason: 'The original expiry passed. No default was selected.',
    }),
    question(10, 'cancelled', 10, {
      cancelledAt: timestamp(22),
      updatedAt: timestamp(22),
      cancelReason: 'No longer needed.',
    }),
    question(11, 'dismissed', 11, {
      dismissedAt: timestamp(21),
      updatedAt: timestamp(21),
    }),
  ];
  const answers = [
    answer(3, 'recorded'),
    answer(4, 'queued'),
    answer(5, 'failed'),
    answer(6, 'acknowledged'),
    answer(7, 'acknowledged'),
    answer(8, 'acknowledged'),
  ];
  const acknowledgements = [
    acknowledgement(6, 'cannot_apply'),
    acknowledgement(7, 'applied', 'D-1'),
    acknowledgement(8, 'superseded', 'D-2'),
  ];
  return stateWith({
    updates: new Map(updates.map((item) => [item.id, item])),
    questions: new Map(questions.map((item) => [item.id, item])),
    answers: new Map(answers.map((item) => [item.id, item])),
    acknowledgements: new Map(acknowledgements.map((item) => [item.answerId, item])),
  });
}

describe('SB-026 board view model', () => {
  it('builds the normative empty snapshot and fixed unavailable states', () => {
    const model = buildBoardViewModel(
      createEmptyBoardState(),
      undefined,
      OPENED_AT,
      effectiveConfig(),
    );
    expect(model).toMatchObject({
      availability: { kind: 'ready' },
      initialTab: 'inbox',
      activeTab: 'inbox',
      tabCounts: { inbox: 0, updates: 0, decisions: 0, history: 0 },
      catchUp: { visible: false, total: 0, label: 'No changes since last viewed.' },
    });
    expect(model.tabs.inbox.empty).toEqual({
      title: 'No questions need attention.',
      detail: 'Agent questions that can wait without stopping independent work appear here.',
    });
    expect(model.tabs.updates.empty.title).toBe('No active updates.');
    expect(model.tabs.decisions.empty.title).toBe('No applied decisions in this branch.');
    expect(model.tabs.history.empty.title).toBe('No archived or terminal items in this branch.');
    expect(
      buildBoardViewModel(createEmptyBoardState(), undefined, OPENED_AT, {
        ...effectiveConfig(),
        enabled: false,
      }).availability,
    ).toEqual({
      kind: 'unavailable',
      code: 'SB_CONFIG_DISABLED',
      message: 'Signals is disabled by configuration.',
    });
    expect(boardModelFailure('ui_unavailable')).toEqual({
      kind: 'unavailable',
      code: 'SB_UI_UNAVAILABLE',
      message: 'Signals interactive UI is unavailable.',
    });
    expect(boardModelFailure('internal_error')).toEqual({
      kind: 'error',
      code: 'SB_INTERNAL',
      message: 'Signals could not build a safe view.',
    });
  });

  it('uses Inbox, Updates, Decisions, then empty Inbox initial-tab precedence', () => {
    const all = completeState();
    const noInbox = stateWith({
      ...all,
      questions: new Map(
        [...all.questions].filter(([, item]) =>
          ['resolved', 'stale', 'cancelled', 'dismissed'].includes(item.status),
        ),
      ),
    });
    const noUpdates = stateWith({ ...noInbox, updates: new Map() });
    const empty = createEmptyBoardState();
    expect(buildBoardViewModel(all, undefined, OPENED_AT, effectiveConfig()).initialTab).toBe(
      'inbox',
    );
    expect(buildBoardViewModel(noInbox, undefined, OPENED_AT, effectiveConfig()).initialTab).toBe(
      'updates',
    );
    expect(buildBoardViewModel(noUpdates, undefined, OPENED_AT, effectiveConfig()).initialTab).toBe(
      'decisions',
    );
    expect(buildBoardViewModel(empty, undefined, OPENED_AT, effectiveConfig()).initialTab).toBe(
      'inbox',
    );
    expect(buildBoardViewModel(all, 'history', OPENED_AT, effectiveConfig())).toMatchObject({
      initialTab: 'inbox',
      activeTab: 'history',
    });
  });

  it('projects every Inbox category and preserves action, delivery, and acknowledgement distinctions', () => {
    const model = buildBoardViewModel(completeState(), undefined, OPENED_AT, effectiveConfig());
    expect(
      model.tabs.inbox.rows.map((row) => [row.displayId, row.statusLabel, row.category]),
    ).toEqual([
      ['Q-5', 'DELIVERY FAILED', 'delivery_failed'],
      ['Q-6', 'NEEDS ATTENTION', 'needs_attention'],
      ['Q-2', 'BLOCKED', 'blocking'],
      ['Q-1', 'PENDING', 'normal_pending'],
      ['Q-3', 'SENT', 'sent'],
      ['Q-4', 'SENT', 'sent'],
    ]);
    expect(model.tabs.inbox.rows.map((row) => row.userAnswerable)).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(model.tabs.inbox.rows[0]).toMatchObject({
      retryableDelivery: true,
      awaitingAcknowledgement: false,
      selected: true,
    });
    const failed = model.tabs.inbox.detail?.projection;
    expect(failed).toMatchObject({
      item: {
        revision: 5,
        reason: 'Reason 5.',
        recommendation: 'Use first.',
        affectedWork: ['Affected 5'],
        continuingWork: ['Continuing 5'],
        attachments: [{ kind: 'note', label: 'Evidence' }],
      },
      answer: {
        id: expect.stringMatching(/^ans_/u),
        deliveryStatus: 'failed',
        deliveryAttempts: [{ outcome: 'queued' }, { outcome: 'failed' }],
      },
      latestDeliveryAttempt: {
        attempt: 2,
        errorCode: 'SB_DELIVERY_FAILED',
        errorCategory: 'host_rejected',
      },
    });
    const attention = buildBoardViewModel(completeState(), 'inbox', OPENED_AT, effectiveConfig(), {
      inbox: questionId(6),
    }).tabs.inbox.detail?.projection;
    expect(attention).toMatchObject({
      attentionState: 'needs_attention',
      acknowledgement: {
        outcome: 'cannot_apply',
        summary: 'Acknowledgement 6.',
        resultingUpdateIds: [updateId(1)],
        attachments: [{ kind: 'test_run', reference: 'run-6' }],
      },
    });
  });

  it('shows active and recent terminal updates, while History retains old and archived updates', () => {
    const model = buildBoardViewModel(completeState(), undefined, OPENED_AT, effectiveConfig());
    expect(
      model.tabs.updates.rows.map((row) => [row.displayId, row.statusLabel, row.recentTerminal]),
    ).toEqual([
      ['U-1', 'WORKING', false],
      ['U-2', 'FOUND', false],
      ['U-3', 'WARNING', false],
      ['U-4', 'BLOCKED', false],
      ['U-5', 'DONE', true],
    ]);
    expect(model.tabs.updates.rows.some((row) => row.displayId === 'U-6')).toBe(false);
    expect(model.tabs.updates.rows.some((row) => row.displayId === 'U-7')).toBe(false);
    expect(model.tabs.updates.detail).toMatchObject({
      entityType: 'update',
      item: {
        id: updateId(1),
        revision: 1,
        detail: 'Detail 1',
        stage: 'testing',
        progress: { current: 1, total: 20, unit: 'tests' },
        attachments: [{ kind: 'file', path: 'src/1.ts' }],
      },
    });
    expect(model.tabs.history.rows.map((row) => [row.displayId, row.statusLabel])).toEqual(
      expect.arrayContaining([
        ['U-5', 'DONE'],
        ['U-6', 'FAILED'],
        ['U-7', 'ARCHIVED'],
      ]),
    );
  });

  it('derives applied and superseded Decisions with complete metadata and all terminal History kinds', () => {
    const model = buildBoardViewModel(completeState(), undefined, OPENED_AT, effectiveConfig());
    expect(model.tabCounts).toEqual({ inbox: 6, updates: 5, decisions: 2, history: 8 });
    expect(model.tabs.decisions.rows.map((row) => [row.displayId, row.statusLabel])).toEqual([
      ['D-2', 'SUPERSEDED'],
      ['D-1', 'APPLIED'],
    ]);
    expect(model.tabs.decisions.detail?.decision).toMatchObject({
      id: 'D-2',
      questionId: questionId(8),
      answerId: answerId(8),
      questionRevision: 8,
      answer: { kind: 'single', optionId: 'first' },
      actor: 'user',
      reason: 'Reason 8.',
      recommendation: 'Use first.',
      acknowledgement: {
        summary: 'Acknowledgement 8.',
        resultingUpdateIds: [updateId(1)],
      },
      decidedAt: timestamp(28),
      resolvedAt: timestamp(28),
    });
    expect(new Set(model.tabs.history.rows.map((row) => row.terminalKind))).toEqual(
      new Set(['archived', 'completed', 'failed', 'cancelled', 'dismissed', 'stale', 'resolved']),
    );
    const stale = buildBoardViewModel(completeState(), 'history', OPENED_AT, effectiveConfig(), {
      history: `question:${questionId(9)}`,
    }).tabs.history.detail;
    expect(stale).toMatchObject({
      entityType: 'question',
      terminalKind: 'stale',
      projection: {
        item: { status: 'stale', expiresAt: timestamp(15) },
        stale: {
          reason: 'The original expiry passed. No default was selected.',
          originalExpiry: timestamp(15),
          staleAt: timestamp(23),
        },
      },
    });
  });

  it.each([
    [0, 0, 8, true],
    [1, 1, 7, true],
    [500, 8, 0, false],
    [50, 8, 0, false],
  ] as const)(
    'applies history limit %i with exact visible and omitted counts',
    (limit, visible, omitted, truncated) => {
      const history = buildBoardViewModel(
        completeState(),
        undefined,
        OPENED_AT,
        effectiveConfig(limit),
      ).tabs.history;
      expect(history).toMatchObject({
        count: 8,
        visibleCount: visible,
        omittedCount: omitted,
        truncated,
      });
      expect(history.truncationNotice).toBe(
        truncated
          ? `Showing ${visible} of 8 history items. ${omitted} omitted by the configured history limit.`
          : undefined,
      );
    },
  );

  it('uses strict catch-up boundaries, accepted coalescing, stable IDs, and does not mark viewed', () => {
    const records: VisibleChangeRecord[] = [
      visible(1, 10, { kind: 'update_created', itemId: updateId(1), updateKind: 'working' }),
      visible(2, 11, { kind: 'update_changed', itemId: updateId(1), updateKind: 'warning' }),
      visible(3, 12, { kind: 'update_changed', itemId: updateId(1), updateKind: 'blocked' }),
      visible(4, 13, { kind: 'update_completed', itemId: updateId(1), updateKind: 'completed' }),
      visible(5, 14, { kind: 'question_created', itemId: questionId(1) }),
      visible(6, 15, { kind: 'delivery_failed', itemId: questionId(1) }),
      visible(7, 16, { kind: 'answer_applied', itemId: questionId(7) }),
      visible(8, 31, { kind: 'answer_needs_attention', itemId: questionId(6) }),
      visible(9, 30, { kind: 'update_changed', itemId: updateId(2), updateKind: 'finding' }),
    ];
    const state = { ...completeState(), lastViewedAt: timestamp(10), visibleChanges: records };
    const before = state.lastViewedAt;
    const catchUp = buildBoardViewModel(state, undefined, timestamp(30), effectiveConfig()).catchUp;
    expect(catchUp).toMatchObject({
      visible: true,
      total: 4,
      label: 'Since last viewed: 4 changes.',
      counts: {
        delivery_attention: 1,
        blocked_failed: 1,
        question: 0,
        completed_applied: 1,
        update: 1,
      },
    });
    expect(catchUp.items.map((item) => [item.entityId, item.category, item.occurredAt])).toEqual([
      [questionId(1), 'delivery_attention', timestamp(15)],
      [updateId(1), 'blocked_failed', timestamp(12)],
      [questionId(7), 'completed_applied', timestamp(16)],
      [updateId(2), 'update', timestamp(30)],
    ]);
    expect(catchUp.items[0]).toMatchObject({ displayId: 'Q-1', title: 'Question 1?' });
    expect(state.lastViewedAt).toBe(before);
  });

  it('supports selected, unselected, and explicitly missing selection without unsafe fallback', () => {
    const selected = buildBoardViewModel(completeState(), undefined, OPENED_AT, effectiveConfig(), {
      updates: updateId(3),
    });
    expect(selected.tabs.updates.selectedId).toBe(updateId(3));
    expect(
      selected.tabs.updates.rows.filter((row) => row.selected).map((row) => row.displayId),
    ).toEqual(['U-3']);
    expect(selected.tabs.updates.detail?.item.id).toBe(updateId(3));

    const missing = buildBoardViewModel(completeState(), undefined, OPENED_AT, effectiveConfig(), {
      updates: updateId(99),
      inbox: questionId(99),
      decisions: 'D-99',
      history: 'question:missing',
    });
    for (const tab of ['updates', 'inbox', 'decisions', 'history'] as const) {
      expect(missing.tabs[tab].selectedId).toBeUndefined();
      expect(missing.tabs[tab].detail).toBeUndefined();
      expect(missing.tabs[tab].rows.every((row) => !row.selected)).toBe(true);
    }
  });

  it('defends optional metadata and includes changes whose source item is unavailable', () => {
    const malformed = update(20, 'completed', 20, {
      completedAt: undefined,
      detail: undefined,
    } as unknown as Partial<UpdateItem>);
    const terminal = question(20, 'stale', 20, {
      staleAt: undefined,
      expiresAt: undefined,
      staleReason: undefined,
    } as unknown as Partial<QuestionItem>);
    const state = stateWith({
      updates: new Map([[malformed.id, malformed]]),
      questions: new Map([[terminal.id, terminal]]),
      visibleChanges: [visible(20, 20, { kind: 'question_terminal', itemId: questionId(99) })],
    });
    const model = buildBoardViewModel(state, undefined, OPENED_AT, effectiveConfig());
    expect(model.tabs.history.rows.map((row) => row.displayId)).toEqual(['Q-20', 'U-20']);
    expect(model.tabs.history.detail).toMatchObject({
      entityType: 'question',
      projection: { stale: {} },
    });
    expect(model.catchUp.items[0]).toEqual({
      entityType: 'question',
      entityId: questionId(99),
      occurredAt: timestamp(20),
      eventId: expect.stringMatching(/^evt_/u),
      category: 'question',
      changeKind: 'question_terminal',
    });
  });

  it('exposes complete immutable per-row detail lookup without changing selected detail semantics', () => {
    const model = buildBoardViewModel(completeState(), undefined, OPENED_AT, effectiveConfig());
    expect(Object.keys(model.tabs.inbox.detailsById)).toHaveLength(model.tabs.inbox.rows.length);
    expect(Object.keys(model.tabs.updates.detailsById)).toHaveLength(
      model.tabs.updates.rows.length,
    );
    expect(Object.keys(model.tabs.decisions.detailsById)).toHaveLength(
      model.tabs.decisions.rows.length,
    );
    expect(Object.keys(model.tabs.history.detailsById)).toHaveLength(
      model.tabs.history.rows.length,
    );
    expect(model.tabs.inbox.detail).toStrictEqual(
      model.tabs.inbox.detailsById[model.tabs.inbox.selectedId as string],
    );
    expect(model.tabs.inbox.detailsById[questionId(1)]?.projection.item.question).toBe(
      'Question 1?',
    );
    expect(Object.isFrozen(model.tabs.inbox.detailsById)).toBe(true);
    expect(Object.isFrozen(model.tabs.inbox.detailsById[questionId(1)]?.projection.item)).toBe(
      true,
    );
  });

  it('retains no nested state or configuration aliases and blocks caller mutation', () => {
    const state = completeState();
    const config = effectiveConfig(1);
    const model = buildBoardViewModel(state, undefined, OPENED_AT, config);
    const sourceQuestion = state.questions.get(questionId(5));
    const sourceDecisionAnswer = state.answers.get(answerId(8));
    expect(model.tabs.inbox.detail?.projection.item).not.toBe(sourceQuestion);
    expect(model.tabs.decisions.detail?.decision.answer).not.toBe(sourceDecisionAnswer?.value);
    expect(model.tabs.inbox.detail?.projection.item.response.options).not.toBe(
      sourceQuestion?.response.options,
    );
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.tabs.inbox.rows)).toBe(true);
    expect(Object.isFrozen(model.tabs.inbox.detail?.projection.item.attachments[0])).toBe(true);
    expect(Object.isFrozen(model.metadata)).toBe(true);
    expect(() => (model.tabs.inbox.rows as unknown[]).push({})).toThrow(TypeError);
    expect(() =>
      (model.tabs.inbox.detail?.projection.item.affectedWork as string[]).push('mutation'),
    ).toThrow(TypeError);
    expect(() =>
      (model.tabs.decisions.detail?.decision.acknowledgement.attachments as unknown[]).pop(),
    ).toThrow(TypeError);
    expect(() => {
      (model.metadata as { historyLimit: number }).historyLimit = 99;
    }).toThrow(TypeError);
  });

  it('uses internal IDs as final stable tie-breakers for rows and History', () => {
    const firstUpdate = update(30, 'working', 20, { displayId: 'U-30' });
    const secondUpdate = update(31, 'working', 20, { displayId: 'U-30' });
    const firstQuestion = question(30, 'dismissed', 20, {
      displayId: 'Q-30',
      dismissedAt: timestamp(20),
    });
    const secondQuestion = question(31, 'dismissed', 20, {
      displayId: 'Q-30',
      dismissedAt: timestamp(20),
    });
    const state = stateWith({
      updates: new Map([
        [secondUpdate.id, secondUpdate],
        [firstUpdate.id, firstUpdate],
      ]),
      questions: new Map([
        [secondQuestion.id, secondQuestion],
        [firstQuestion.id, firstQuestion],
      ]),
    });
    const model = buildBoardViewModel(state, undefined, OPENED_AT, effectiveConfig());
    expect(model.tabs.updates.rows.map((row) => row.entityId)).toEqual([
      firstUpdate.id,
      secondUpdate.id,
    ]);
    expect(model.tabs.history.rows.map((row) => row.entityId)).toEqual([
      firstQuestion.id,
      secondQuestion.id,
    ]);
  });

  it('is replay-equivalent with stable tie-breakers across fixed-seed insertion permutations', () => {
    const seed = 0x5b026;
    let randomState = seed;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    const source = completeState();
    const expected = buildBoardViewModel(source, undefined, OPENED_AT, effectiveConfig());
    try {
      for (let run = 0; run < 100; run += 1) {
        const updates = shuffle([...source.updates], random);
        const questions = shuffle([...source.questions], random);
        const answers = shuffle([...source.answers], random);
        const acknowledgements = shuffle([...source.acknowledgements], random);
        const replayed = stateWith({
          updates: new Map(updates),
          questions: new Map(questions),
          answers: new Map(answers),
          acknowledgements: new Map(acknowledgements),
        });
        expect(buildBoardViewModel(replayed, undefined, OPENED_AT, effectiveConfig())).toEqual(
          expected,
        );
      }
    } catch (error) {
      console.error(`board-model property seed=${seed} state=${randomState}`);
      throw error;
    }
  });
});

function visible(
  sequence: number,
  minute: number,
  change: VisibleChangeRecord['change'],
): VisibleChangeRecord {
  return {
    eventId: `evt_68000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    occurredAt: timestamp(minute),
    change,
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap] as T, values[index] as T];
  }
  return values;
}

const _allTabsCompile: readonly BoardTab[] = ['inbox', 'updates', 'decisions', 'history'];
void _allTabsCompile;
