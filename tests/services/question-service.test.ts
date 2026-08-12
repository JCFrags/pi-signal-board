import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { EffectiveConfig } from '../../src/config/types.js';
import type { Clock } from '../../src/domain/clock.js';
import { FixedClock } from '../../src/domain/clock.js';
import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type {
  QuestionCancelledEvent,
  QuestionCreatedEvent,
  QuestionDismissedEvent,
  QuestionRevisedEvent,
} from '../../src/domain/events.js';
import type { EventId, IdGenerator, QuestionId } from '../../src/domain/ids.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import type { QuestionItem, QuestionStatus } from '../../src/domain/types.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { TurnQuestionRateCounter } from '../../src/services/question-rate-counter.js';
import {
  type CancelQuestionCommand,
  type CreateQuestionCommand,
  QuestionService,
  type ReviseQuestionCommand,
} from '../../src/services/question-service.js';
import { createDeferred } from '../helpers/deferred.js';

type QuestionEvent =
  | QuestionCreatedEvent
  | QuestionRevisedEvent
  | QuestionCancelledEvent
  | QuestionDismissedEvent;

class ServiceIds implements Pick<IdGenerator, 'event' | 'question'> {
  eventCalls = 0;
  questionCalls = 0;
  throwEvent = false;
  throwQuestion = false;

  event(): EventId {
    if (this.throwEvent) throw new Error('private event ID detail');
    this.eventCalls += 1;
    return `evt_00000000-0000-4000-8000-${this.eventCalls.toString(16).padStart(12, '0')}`;
  }

  question(): QuestionId {
    if (this.throwQuestion) throw new Error('private question ID detail');
    this.questionCalls += 1;
    return `qst_00000000-0000-4000-8000-${this.questionCalls.toString(16).padStart(12, '0')}`;
  }
}

class ThrowClock implements Clock {
  now(): Date {
    throw new Error('private clock detail');
  }
}

class MutableClock implements Clock {
  constructor(private value: string) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: string): void {
    this.value = value;
  }
}

function config(
  maxActionableQuestions = 20,
  maxQuestionMutationsPerTurn = 5,
  questionDefaults: Partial<EffectiveConfig['questions']> = {},
): EffectiveConfig {
  return {
    ...DEFAULT_CONFIG,
    limits: {
      ...DEFAULT_CONFIG.limits,
      maxActionableQuestions,
      maxQuestionMutationsPerTurn,
    },
    questions: { ...DEFAULT_CONFIG.questions, ...questionDefaults },
  };
}

function harness(
  options: {
    readonly capacity?: number;
    readonly rate?: number;
    readonly clock?: Clock;
    readonly appendGate?: ReturnType<typeof createDeferred<void>>;
    readonly questionDefaults?: Partial<EffectiveConfig['questions']>;
  } = {},
) {
  let state = createEmptyBoardState();
  const events: QuestionEvent[] = [];
  const ids = new ServiceIds();
  const rateCounter = new TurnQuestionRateCounter();
  let appendBehavior: 'ok' | 'throw' | 'failure' = 'ok';
  let refreshBehavior: 'ok' | 'throw' = 'ok';
  let appendCount = 0;
  const service = new QuestionService({
    queue: new MutationQueue(),
    readState: () => state,
    swapState: (next) => {
      state = next;
    },
    append: async (event) => {
      appendCount += 1;
      if (options.appendGate !== undefined && appendCount === 1) {
        await options.appendGate.promise;
      }
      if (appendBehavior === 'throw') throw new Error('private append detail');
      if (appendBehavior === 'failure') return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      events.push(event);
      return succeed(undefined);
    },
    refresh: () => {
      if (refreshBehavior === 'throw') throw new Error('private refresh detail');
    },
    clock: options.clock ?? new FixedClock('2026-08-12T10:00:00.000Z'),
    ids,
    cwd: '/work/project',
    config: config(options.capacity, options.rate, options.questionDefaults),
    rateCounter,
  });
  return {
    service,
    events,
    ids,
    rateCounter,
    state: () => state,
    replaceQuestion(item: QuestionItem) {
      state = { ...state, questions: new Map(state.questions).set(item.id, item) };
    },
    setAppend(value: typeof appendBehavior) {
      appendBehavior = value;
    },
    setRefresh(value: typeof refreshBehavior) {
      refreshBehavior = value;
    },
  };
}

function create(
  commandId: string,
  overrides: Partial<CreateQuestionCommand> = {},
): CreateQuestionCommand {
  return {
    commandId: `tool:${commandId}`,
    question: 'Which local format should the widget use?',
    reason: 'Independent tests can continue while this preference is pending.',
    class: 'preference',
    response: {
      kind: 'single',
      options: [
        { id: 'compact', label: 'Compact' },
        { id: 'detailed', label: 'Detailed' },
      ],
    },
    ...overrides,
  } as CreateQuestionCommand;
}

function revise(
  commandId: string,
  item: QuestionItem,
  overrides: Partial<ReviseQuestionCommand> = {},
): ReviseQuestionCommand {
  return {
    commandId: `tool:${commandId}`,
    id: item.id,
    expectedRevision: item.revision,
    revisionSummary: 'Added focused evidence.',
    question: 'Which revised local format should the widget use?',
    reason: 'More evidence is now available while independent tests continue.',
    class: 'preference',
    response: {
      kind: 'single',
      options: [
        { id: 'compact', label: 'Compact' },
        { id: 'detailed', label: 'Detailed' },
      ],
    },
    recommendedOptionIds: [],
    priority: 'high',
    blockingPolicy: 'never',
    deliveryMode: 'nextTurn',
    affectedWork: [],
    continuingWork: ['Independent tests'],
    attachments: [],
    ...overrides,
  } as ReviseQuestionCommand;
}

function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected synthetic success.');
  return result.value;
}

function code(result: {
  readonly ok: boolean;
  readonly error?: { readonly code: string };
}): string {
  expect(result.ok).toBe(false);
  return result.error?.code ?? 'missing';
}

function withStatus(item: QuestionItem, status: QuestionStatus): QuestionItem {
  return {
    ...item,
    status,
    ...(status === 'answered' || status === 'delivery_queued' || status === 'delivery_failed'
      ? { answerId: 'ans_00000000-0000-4000-8000-000000000001' as const }
      : {}),
  };
}

describe('QuestionService', () => {
  it('creates with configured defaults and an exact complete event', async () => {
    const test = harness({
      questionDefaults: { defaultBlockingPolicy: 'never', defaultDeliveryMode: 'nextTurn' },
    });
    const result = value(await test.service.createQuestion(create('create|host-byte')));

    expect(result).toMatchObject({
      noOp: false,
      item: { displayId: 'Q-1', revision: 1, status: 'pending' },
    });
    expect(result.item).toMatchObject({
      priority: 'normal',
      blockingPolicy: 'never',
      deliveryMode: 'nextTurn',
      recommendedOptionIds: [],
      affectedWork: [],
      continuingWork: [],
      attachments: [],
    });
    expect(test.events).toEqual([
      {
        schemaVersion: 1,
        eventId: 'evt_00000000-0000-4000-8000-000000000001',
        eventType: 'question.created',
        occurredAt: '2026-08-12T10:00:00.000Z',
        actor: 'agent',
        commandId: 'tool:create|host-byte',
        payload: {
          questionId: 'qst_00000000-0000-4000-8000-000000000001',
          displayId: 'Q-1',
          revision: 1,
          createdAt: '2026-08-12T10:00:00.000Z',
          spec: (result.event as QuestionCreatedEvent).payload.spec,
        },
      },
    ]);
  });

  it('fully replaces a pending question by display ID and sanitizes its summary', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('first'))).item;
    const result = value(
      await test.service.reviseQuestion(
        revise('revise', created, {
          id: created.displayId,
          revisionSummary: '\u001b[31m  New   evidence \u001b[0m',
          response: { kind: 'text' },
          recommendedOptionIds: [],
          recommendedText: 'Use a narrow line.',
          affectedWork: ['Widget layout'],
          attachments: [{ kind: 'note', label: ' note ', text: 'one\r\ntwo' }],
        }),
      ),
    );

    expect(result.item).toMatchObject({
      id: created.id,
      displayId: created.displayId,
      createdAt: created.createdAt,
      revision: 2,
      revisionSummary: 'New evidence',
      response: { kind: 'text', options: [] },
      recommendedText: 'Use a narrow line.',
      priority: 'high',
      affectedWork: ['Widget layout'],
      attachments: [{ kind: 'note', label: 'note', text: 'one\ntwo' }],
    });
    expect(result.item).not.toHaveProperty('recommendation');
    expect(result.event).toMatchObject({
      eventType: 'question.revised',
      payload: { expectedRevision: 1, revision: 2, revisionSummary: 'New evidence' },
    });
  });

  it('cancels by internal ID, sanitizes reason, increments revision, and sends nothing by construction', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('first'))).item;
    const result = value(
      await test.service.cancelQuestion({
        commandId: 'tool:cancel',
        id: created.id,
        expectedRevision: 1,
        reason: '\u001b[31m  No   longer needed \u001b[0m',
      }),
    );
    expect(result.item).toMatchObject({
      status: 'cancelled',
      revision: 2,
      cancelReason: 'No longer needed',
      cancelledAt: '2026-08-12T10:00:00.000Z',
    });
    expect(result.item).not.toHaveProperty('answerId');
    expect(result.event).toMatchObject({
      eventType: 'question.cancelled',
      payload: { reason: 'No longer needed', expectedRevision: 1, revision: 2 },
    });
  });

  it('revises and cancels blocking unanswered questions', async () => {
    const reviseTest = harness();
    const pending = value(
      await reviseTest.service.createQuestion(create('blocking-revise-create')),
    ).item;
    reviseTest.replaceQuestion(withStatus(pending, 'blocking'));
    const revised = value(
      await reviseTest.service.reviseQuestion(
        revise('blocking-revise', withStatus(pending, 'blocking')),
      ),
    ).item;
    expect(revised).toMatchObject({ status: 'blocking', revision: 2 });

    const cancelTest = harness();
    const other = value(
      await cancelTest.service.createQuestion(create('blocking-cancel-create')),
    ).item;
    cancelTest.replaceQuestion(withStatus(other, 'blocking'));
    const cancelled = value(
      await cancelTest.service.cancelQuestion({
        commandId: 'tool:blocking-cancel',
        id: other.displayId,
        expectedRevision: 1,
        reason: 'Evidence removed the need.',
      }),
    ).item;
    expect(cancelled).toMatchObject({ status: 'cancelled', revision: 2 });
  });

  it('rejects authorization and each normative unsafe action class before allocation or append', async () => {
    const cases = [
      { class: 'authorization', question: 'May I continue?' },
      { question: 'Should I delete the data?' },
      { question: 'Should I deploy to production?' },
      { question: 'Should I publish this release?' },
      { question: 'Should I purchase this service?' },
      { question: 'Should I reveal the secret token?' },
      { question: 'Should I grant admin access?' },
      { question: 'Should I perform this irreversible action?' },
    ] as const;
    for (const [index, unsafe] of cases.entries()) {
      const test = harness();
      const result = await test.service.createQuestion(
        create(`unsafe-${index}`, unsafe as Partial<CreateQuestionCommand>),
      );
      expect(code(result)).toBe('SB_UNSAFE_QUESTION');
      expect(test.events).toHaveLength(0);
      expect(test.ids).toMatchObject({ eventCalls: 0, questionCalls: 0 });
      expect(test.rateCounter.committed).toBe(0);
    }
  });

  it('runs the unsafe guard for complete revisions before allocation or append', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('safe-create'))).item;
    for (const [index, override] of [
      { class: 'authorization' as const },
      { question: 'Should I deploy this to production?' },
    ].entries()) {
      const result = await test.service.reviseQuestion(
        revise(`unsafe-revise-${index}`, created, override),
      );
      expect(code(result)).toBe('SB_UNSAFE_QUESTION');
    }
    expect(test.events).toHaveLength(1);
    expect(test.ids.eventCalls).toBe(1);
    expect(test.rateCounter.committed).toBe(1);
  });

  it('checks current revision before every lifecycle conflict', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('first'))).item;
    test.replaceQuestion(withStatus({ ...created, revision: 2 }, 'answered'));
    expect(code(await test.service.reviseQuestion(revise('stale-revise', created)))).toBe(
      'SB_REVISION_MISMATCH',
    );
    expect(
      code(
        await test.service.cancelQuestion({
          commandId: 'tool:stale-cancel',
          id: created.id,
          expectedRevision: 1,
          reason: 'No longer needed',
        }),
      ),
    ).toBe('SB_REVISION_MISMATCH');
  });

  it('rejects answered and every non-answerable terminal status', async () => {
    for (const status of [
      'answered',
      'delivery_queued',
      'delivery_failed',
      'needs_attention',
      'resolved',
      'stale',
      'cancelled',
      'dismissed',
    ] as const) {
      const test = harness();
      const created = value(await test.service.createQuestion(create(`first-${status}`))).item;
      test.replaceQuestion(withStatus(created, status));
      const result = await test.service.cancelQuestion({
        commandId: `tool:cancel-${status}`,
        id: created.id,
        expectedRevision: 1,
        reason: 'No longer needed',
      });
      expect(code(result)).toBe('SB_STATE_CONFLICT');
      expect(test.events).toHaveLength(1);
    }
  });

  it('rejects a semantic no-op revise and missing or malformed lookups', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('first'))).item;
    const noOp = revise('no-op', created, {
      question: created.question,
      reason: created.reason,
      class: created.class,
      response: created.response,
      recommendedOptionIds: created.recommendedOptionIds,
      priority: created.priority,
      blockingPolicy: created.blockingPolicy,
      deliveryMode: created.deliveryMode,
      affectedWork: created.affectedWork,
      continuingWork: created.continuingWork,
      attachments: created.attachments,
    });
    expect(code(await test.service.reviseQuestion(noOp))).toBe('SB_STATE_CONFLICT');
    expect(
      code(
        await test.service.cancelQuestion({
          commandId: 'tool:bad-id',
          id: 'Q-0',
          expectedRevision: 1,
          reason: 'Reason',
        }),
      ),
    ).toBe('SB_INVALID_ARGUMENT');
    expect(
      code(
        await test.service.cancelQuestion({
          commandId: 'tool:missing',
          id: 'Q-99',
          expectedRevision: 1,
          reason: 'Reason',
        }),
      ),
    ).toBe('SB_NOT_FOUND');
  });

  it('uses the full actionable selector for capacity and permits terminal-state replacement capacity', async () => {
    for (const status of ['pending', 'blocking', 'delivery_failed', 'needs_attention'] as const) {
      const test = harness({ capacity: 1 });
      const first = value(await test.service.createQuestion(create(`first-${status}`))).item;
      test.replaceQuestion(withStatus(first, status));
      expect(code(await test.service.createQuestion(create(`second-${status}`)))).toBe(
        'SB_LIMIT_EXCEEDED',
      );
    }
    for (const status of ['answered', 'resolved', 'stale', 'cancelled', 'dismissed'] as const) {
      const test = harness({ capacity: 1 });
      const first = value(await test.service.createQuestion(create(`first-${status}`))).item;
      test.replaceQuestion(withStatus(first, status));
      expect(
        value(await test.service.createQuestion(create(`second-${status}`))).item.displayId,
      ).toBe('Q-2');
    }
  });

  it('permits revise and cancel at capacity', async () => {
    const reviseTest = harness({ capacity: 1 });
    const first = value(await reviseTest.service.createQuestion(create('first'))).item;
    expect(
      value(await reviseTest.service.reviseQuestion(revise('revise', first))).item.revision,
    ).toBe(2);

    const cancelTest = harness({ capacity: 1 });
    const second = value(await cancelTest.service.createQuestion(create('second'))).item;
    expect(
      value(
        await cancelTest.service.cancelQuestion({
          commandId: 'tool:cancel',
          id: second.id,
          expectedRevision: 1,
          reason: 'Done',
        }),
      ).item.status,
    ).toBe('cancelled');
  });

  it('commits only accepted question rates and resets explicitly', async () => {
    const test = harness({ rate: 2 });
    const first = value(await test.service.createQuestion(create('one'))).item;
    await test.service.reviseQuestion(revise('two', first));
    expect(code(await test.service.createQuestion(create('three')))).toBe('SB_LIMIT_EXCEEDED');
    expect(test.rateCounter.committed).toBe(2);
    test.rateCounter.reset();
    expect(value(await test.service.createQuestion(create('after-reset'))).item.displayId).toBe(
      'Q-2',
    );
    expect(test.rateCounter.committed).toBe(1);
  });

  it('returns exact create retries after expiry passes and rejects changed or cross-operation command IDs', async () => {
    const clock = new MutableClock('2026-08-12T10:00:00.000Z');
    const test = harness({ clock });
    const input = create('historical', { expiresAt: '2026-08-12T10:00:01.000Z' });
    const first = value(await test.service.createQuestion(input));
    clock.set('2026-08-12T10:00:02.000Z');
    const retry = value(await test.service.createQuestion(input));
    expect(retry).toEqual({ ...first, noOp: true });
    const cancelled = value(
      await test.service.cancelQuestion({
        commandId: 'tool:cancel-after-create',
        id: first.item.id,
        expectedRevision: 1,
        reason: 'No longer needed',
      }),
    ).item;
    const terminalRetry = value(await test.service.createQuestion(input));
    expect(terminalRetry.event).toEqual(first.event);
    expect(terminalRetry.item).toEqual(cancelled);
    expect(terminalRetry.item.status).toBe('cancelled');
    expect(test.events).toHaveLength(2);
    expect(test.rateCounter.committed).toBe(2);
    expect(code(await test.service.createQuestion({ ...input, question: 'Changed?' }))).toBe(
      'SB_STATE_CONFLICT',
    );
    expect(
      code(
        await test.service.cancelQuestion({
          commandId: input.commandId,
          id: first.item.id,
          expectedRevision: 1,
          reason: 'Done',
        }),
      ),
    ).toBe('SB_STATE_CONFLICT');
  });

  it('returns exact revise retry evidence after expiry and a later revision', async () => {
    const clock = new MutableClock('2026-08-12T10:00:00.000Z');
    const test = harness({ clock });
    const created = value(await test.service.createQuestion(create('create'))).item;
    const command = revise('revision-one', created, { expiresAt: '2026-08-12T10:00:01.000Z' });
    const first = value(await test.service.reviseQuestion(command));
    const later = value(
      await test.service.reviseQuestion(
        revise('revision-two', first.item, {
          question: 'Which final local format should the widget use?',
        }),
      ),
    ).item;
    expect(later.revision).toBe(3);
    clock.set('2026-08-12T10:00:02.000Z');
    const retry = value(await test.service.reviseQuestion(command));
    expect(retry.event).toEqual(first.event);
    expect(retry.item).toEqual(later);
    expect(retry.noOp).toBe(true);

    const cancelled = value(
      await test.service.cancelQuestion({
        commandId: 'tool:later-cancel',
        id: later.id,
        expectedRevision: later.revision,
        reason: 'No longer needed',
      }),
    ).item;
    const terminalRetry = value(await test.service.reviseQuestion(command));
    expect(terminalRetry.event).toEqual(first.event);
    expect(terminalRetry.item).toEqual(cancelled);
    expect(terminalRetry.item.status).toBe('cancelled');
    expect(test.events).toHaveLength(4);
    expect(code(await test.service.reviseQuestion({ ...command, reason: 'Changed reason' }))).toBe(
      'SB_STATE_CONFLICT',
    );
  });

  it('returns exact cancel retries and rejects changed cancel semantics', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('create'))).item;
    const command: CancelQuestionCommand = {
      commandId: 'tool:cancel',
      id: created.displayId,
      expectedRevision: 1,
      reason: ' No longer needed ',
    };
    const first = value(await test.service.cancelQuestion(command));
    const retry = value(await test.service.cancelQuestion({ ...command, id: created.id }));
    expect(retry).toEqual({ ...first, noOp: true });
    expect(code(await test.service.cancelQuestion({ ...command, reason: 'Changed' }))).toBe(
      'SB_STATE_CONFLICT',
    );
  });

  it('preserves reserved IDs across append throw and failure results', async () => {
    for (const behavior of ['throw', 'failure'] as const) {
      const test = harness();
      test.setAppend(behavior);
      expect(code(await test.service.createQuestion(create('retry')))).toBe(
        'SB_PERSISTENCE_FAILED',
      );
      expect(test.state().questions.size).toBe(0);
      expect(test.rateCounter.committed).toBe(0);
      test.setAppend('ok');
      const accepted = value(await test.service.createQuestion(create('retry')));
      expect(accepted.item.id).toBe('qst_00000000-0000-4000-8000-000000000001');
      expect(accepted.event.eventId).toBe('evt_00000000-0000-4000-8000-000000000001');
      expect(test.ids).toMatchObject({ eventCalls: 1, questionCalls: 1 });
    }
  });

  it('keeps durable state and rate after refresh failure and retries without append', async () => {
    const test = harness();
    const command = create('refresh');
    test.setRefresh('throw');
    expect(code(await test.service.createQuestion(command))).toBe('SB_UI_UNAVAILABLE');
    expect(test.state().questions.size).toBe(1);
    expect(test.events).toHaveLength(1);
    expect(test.rateCounter.committed).toBe(1);
    test.setRefresh('ok');
    expect(value(await test.service.createQuestion(command)).noOp).toBe(true);
    expect(test.events).toHaveLength(1);
  });

  it('converts thrown clock and ID failures to stable content-free errors', async () => {
    const clockTest = harness({ clock: new ThrowClock() });
    const clockResult = await clockTest.service.createQuestion(create('clock'));
    expect(code(clockResult)).toBe('SB_INTERNAL');
    expect(JSON.stringify(clockResult)).not.toMatch(/private|stack/iu);

    const eventTest = harness();
    eventTest.ids.throwEvent = true;
    expect(code(await eventTest.service.createQuestion(create('event-id')))).toBe('SB_INTERNAL');
    expect(eventTest.events).toHaveLength(0);

    const questionTest = harness();
    questionTest.ids.throwQuestion = true;
    expect(code(await questionTest.service.createQuestion(create('question-id')))).toBe(
      'SB_INTERNAL',
    );
    expect(questionTest.events).toHaveLength(0);
  });

  it('retains no caller aliases and returns deeply immutable item and event results', async () => {
    const options = [
      { id: 'one' as const, label: 'One' },
      { id: 'two' as const, label: 'Two' },
    ];
    const attachments = [{ kind: 'note' as const, label: 'Note', text: 'Text' }];
    const test = harness();
    const result = value(
      await test.service.createQuestion(
        create('immutable', { response: { kind: 'single', options }, attachments }),
      ),
    );
    options[0] = { id: 'one', label: 'Changed' };
    attachments[0] = { kind: 'note', label: 'Changed', text: 'Changed' };
    expect(result.item.response.options?.[0]).toEqual({ id: 'one', label: 'One' });
    expect(result.item.attachments[0]).toEqual({ kind: 'note', label: 'Note', text: 'Text' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.item)).toBe(true);
    expect(Object.isFrozen(result.event.payload)).toBe(true);
    expect(() => {
      (result.item.attachments as unknown as { kind: string }[])[0] = { kind: 'command' };
    }).toThrow(TypeError);
  });

  it('serializes FIFO parallel creates and same-question revisions without lost state', async () => {
    const gate = createDeferred<void>('append');
    const test = harness({ appendGate: gate });
    const one = test.service.createQuestion(create('one', { question: 'First format?' }));
    const two = test.service.createQuestion(create('two', { question: 'Second format?' }));
    await Promise.resolve();
    expect(test.events).toHaveLength(0);
    gate.resolve();
    const created = (await Promise.all([one, two])).map(value);
    expect(created.map((result) => result.item.displayId)).toEqual(['Q-1', 'Q-2']);

    const base = created[0]?.item as QuestionItem;
    const firstRevise = test.service.reviseQuestion(revise('revise-one', base));
    const secondRevise = test.service.reviseQuestion(
      revise('revise-two', base, { question: 'A concurrent stale revision?' }),
    );
    expect(value(await firstRevise).item.revision).toBe(2);
    expect(code(await secondRevise)).toBe('SB_REVISION_MISMATCH');
    expect(test.state().questions.get(base.id)?.revision).toBe(2);
  });

  it('rejects invalid summaries, reasons, revisions, and command IDs before append', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('create'))).item;
    const cases = [
      test.service.reviseQuestion(revise('empty-summary', created, { revisionSummary: '   ' })),
      test.service.cancelQuestion({
        commandId: 'tool:empty-reason',
        id: created.id,
        expectedRevision: 1,
        reason: '   ',
      }),
      test.service.cancelQuestion({
        commandId: 'tool:bad-revision',
        id: created.id,
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        reason: 'Reason',
      }),
      test.service.cancelQuestion({
        commandId: 'ui:not-agent' as `tool:${string}`,
        id: created.id,
        expectedRevision: 1,
        reason: 'Reason',
      }),
    ];
    for (const result of await Promise.all(cases)) expect(code(result)).toBe('SB_INVALID_ARGUMENT');
    expect(test.events).toHaveLength(1);
    expect(test.rateCounter.committed).toBe(1);
  });

  it('dismisses through the user boundary with exact revision and caller timestamp', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('dismiss-create'))).item;
    const result = value(
      await test.service.dismissQuestion({
        commandId: 'ui:00000000-0000-4000-8000-000000000034',
        id: created.id,
        expectedRevision: 1,
        dismissedAt: '2026-08-12T11:00:00.000Z',
        reason: 'user_dismissed',
        source: 'board',
      }),
    );

    expect(result.item).toMatchObject({
      id: created.id,
      status: 'dismissed',
      revision: 2,
      dismissedAt: '2026-08-12T11:00:00.000Z',
    });
    expect(result.event).toEqual({
      schemaVersion: 1,
      eventId: 'evt_00000000-0000-4000-8000-000000000002',
      eventType: 'question.dismissed',
      occurredAt: '2026-08-12T11:00:00.000Z',
      actor: 'user',
      commandId: 'ui:00000000-0000-4000-8000-000000000034',
      payload: {
        questionId: created.id,
        expectedRevision: 1,
        revision: 2,
        dismissedAt: '2026-08-12T11:00:00.000Z',
      },
    });
    expect(test.rateCounter.committed).toBe(1);
  });

  it('keeps dismissal retryable after stale revision, invalid state, and persistence failure', async () => {
    const test = harness();
    const created = value(await test.service.createQuestion(create('dismiss-errors'))).item;
    const base = {
      commandId: 'ui:00000000-0000-4000-8000-000000000035' as const,
      id: created.id,
      expectedRevision: 1,
      dismissedAt: '2026-08-12T11:00:00.000Z',
      reason: 'user_dismissed' as const,
      source: 'board' as const,
    };
    expect(code(await test.service.dismissQuestion({ ...base, expectedRevision: 2 }))).toBe(
      'SB_REVISION_MISMATCH',
    );
    test.replaceQuestion(withStatus(created, 'stale'));
    expect(code(await test.service.dismissQuestion(base))).toBe('SB_STATE_CONFLICT');
    test.replaceQuestion(created);
    test.setAppend('failure');
    expect(code(await test.service.dismissQuestion(base))).toBe('SB_PERSISTENCE_FAILED');
    expect(test.state().questions.get(created.id)?.status).toBe('pending');
    expect(test.events).toHaveLength(1);
  });
});
