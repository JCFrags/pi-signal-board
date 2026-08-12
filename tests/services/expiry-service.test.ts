import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type { QuestionCreatedEvent, QuestionStaledEvent } from '../../src/domain/events.js';
import type { EventId, IdGenerator, QuestionId } from '../../src/domain/ids.js';
import { createEmptyBoardState, reduceBoardEvent } from '../../src/domain/reducer.js';
import type { BoardState, QuestionStatus } from '../../src/domain/types.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import {
  EXPIRY_REASON,
  ExpiryService,
  type ExpiryTimerAdapter,
  MAX_TIMER_DELAY_MS,
} from '../../src/services/expiry-service.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { createDeferred } from '../helpers/deferred.js';
import { FakeClock, type FakeTimerHandle, FakeTimers } from '../helpers/deterministic.js';
import { FakePiHarness, makeCustomEntry } from '../helpers/fake-pi.js';

const NOW = '2026-08-12T12:00:00.000Z';
const BEFORE = '2026-08-12T11:59:59.999Z';
const AFTER = '2026-08-12T12:00:00.001Z';

type AppendBehavior = 'ok' | 'failure' | 'throw';

class EventIds implements Pick<IdGenerator, 'event'> {
  calls = 0;
  event(): EventId {
    this.calls += 1;
    return `evt_90000000-0000-4000-8000-${this.calls.toString().padStart(12, '0')}`;
  }
}

function questionEvent(sequence: number, expiresAt: string | undefined): QuestionCreatedEvent {
  const suffix = sequence.toString().padStart(12, '0');
  return {
    schemaVersion: 1,
    eventId: `evt_10000000-0000-4000-8000-${suffix}`,
    eventType: 'question.created',
    occurredAt: '2026-08-12T10:00:00.000Z',
    actor: 'agent',
    commandId: `tool:create-${sequence}`,
    payload: {
      questionId: `qst_10000000-0000-4000-8000-${suffix}`,
      displayId: `Q-${sequence}`,
      revision: 1,
      createdAt: '2026-08-12T10:00:00.000Z',
      spec: {
        question: `Question ${sequence}`,
        reason: 'Independent work can continue.',
        class: 'preference',
        response: {
          kind: 'single',
          options: [
            { id: 'first', label: 'First' },
            { id: 'second', label: 'Second' },
          ],
        },
        recommendedOptionIds: ['first'],
        priority: 'normal',
        blockingPolicy: 'never',
        deliveryMode: 'steer',
        affectedWork: [],
        continuingWork: [],
        attachments: [],
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    },
  };
}

function withQuestions(expiries: readonly (string | undefined)[]): BoardState {
  let state = createEmptyBoardState();
  for (const [index, expiry] of expiries.entries()) {
    const reduced = reduceBoardEvent(state, questionEvent(index + 1, expiry));
    if (!reduced.ok) throw new Error(`Question fixture rejected: ${reduced.code}`);
    state = reduced.state;
  }
  return state;
}

function setStatus(state: BoardState, sequence: number, status: QuestionStatus): BoardState {
  const id = `qst_10000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}` as QuestionId;
  const item = state.questions.get(id);
  if (!item) throw new Error('Missing fixture question.');
  return {
    ...state,
    questions: new Map(state.questions).set(id, { ...item, status }),
  };
}

function harness(
  initial: BoardState,
  options: {
    readonly clock?: FakeClock;
    readonly timers?: FakeTimers;
    readonly appendGate?: ReturnType<typeof createDeferred<void>>;
  } = {},
) {
  let state = initial;
  let appendBehavior: AppendBehavior = 'ok';
  const appended: QuestionStaledEvent[] = [];
  const refreshes: BoardState[] = [];
  const clock = options.clock ?? new FakeClock(NOW);
  const timers = options.timers ?? new FakeTimers(clock);
  const ids = new EventIds();
  const diagnostics: Array<{ code: string; category: string }> = [];
  let appendCalls = 0;
  const queue = new MutationQueue();
  const service = new ExpiryService({
    queue,
    readState: () => state,
    swapState: (next) => {
      state = next;
    },
    append: async (event) => {
      appendCalls += 1;
      if (options.appendGate && appendCalls === 1) await options.appendGate.promise;
      if (appendBehavior === 'throw') throw new Error('PRIVATE append failure');
      if (appendBehavior === 'failure') return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      appended.push(event);
      return succeed(undefined);
    },
    refresh: (next) => {
      refreshes.push(next);
    },
    clock,
    ids,
    timers: {
      setTimeout: (callback, delayMs) => timers.setTimeout(callback, delayMs),
      clearTimeout: (handle) => timers.clearTimeout(handle as FakeTimerHandle),
      unref: (handle) => timers.unref(handle as FakeTimerHandle),
    },
    recordDiagnostic(record) {
      diagnostics.push(record);
    },
  });
  return {
    service,
    queue,
    clock,
    timers,
    ids,
    appended,
    refreshes,
    diagnostics,
    state: () => state,
    replaceState(next: BoardState) {
      state = next;
    },
    setAppend(value: AppendBehavior) {
      appendBehavior = value;
    },
  };
}

function statuses(state: BoardState): QuestionStatus[] {
  return [...state.questions.values()].map((question) => question.status);
}

describe('expiry service', () => {
  it('uses an inclusive equality boundary and skips a future expiry', async () => {
    const subject = harness(withQuestions([NOW, AFTER]));
    const result = await subject.service.evaluateExpiry(new Date(NOW));

    expect(result).toMatchObject({ transitioned: 1, failed: 0 });
    expect(statuses(subject.state())).toEqual(['stale', 'pending']);
    expect(subject.appended[0]).toMatchObject({
      actor: 'system',
      commandId: 'system:stale:qst_10000000-0000-4000-8000-000000000001:1',
      occurredAt: NOW,
      payload: {
        expectedRevision: 1,
        revision: 2,
        staleAt: NOW,
        reason: EXPIRY_REASON,
      },
    });
  });

  it('handles just-before and just-after evaluation without ambient time', async () => {
    const subject = harness(withQuestions([NOW]));
    expect(await subject.service.evaluateExpiry(new Date(BEFORE))).toMatchObject({
      transitioned: 0,
    });
    expect(await subject.service.evaluateExpiry(new Date(AFTER))).toMatchObject({
      transitioned: 1,
    });
  });

  it.each(['pending', 'blocking'] as const)('stales unanswered %s questions', async (status) => {
    const subject = harness(setStatus(withQuestions([BEFORE]), 1, status));
    await subject.service.evaluateExpiry(new Date(NOW));
    expect(statuses(subject.state())).toEqual(['stale']);
  });

  it.each([
    'answered',
    'delivery_queued',
    'delivery_failed',
    'needs_attention',
    'resolved',
    'stale',
    'cancelled',
    'dismissed',
  ] as const)('skips excluded status %s', async (status) => {
    const subject = harness(setStatus(withQuestions([BEFORE]), 1, status));
    await subject.service.evaluateExpiry(new Date(NOW));
    expect(subject.appended).toHaveLength(0);
  });

  it('orders equal expiries by stable question ID', async () => {
    const initial = withQuestions([BEFORE, BEFORE, BEFORE]);
    const subject = harness({ ...initial, questions: new Map([...initial.questions].reverse()) });
    await subject.service.evaluateExpiry(new Date(NOW));
    expect(subject.appended.map((event) => event.payload.questionId)).toEqual(
      [...initial.questions.keys()].sort(),
    );
  });

  it('serializes concurrent and repeated calls to append once per revision', async () => {
    const gate = createDeferred<void>('append');
    const subject = harness(withQuestions([BEFORE]), { appendGate: gate });
    const first = subject.service.evaluateExpiry(new Date(NOW));
    const second = subject.service.evaluateExpiry(new Date(NOW));
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);
    await subject.service.evaluateExpiry(new Date(NOW));
    expect(subject.appended).toHaveLength(1);
  });

  it('re-reads queued state after a revision race and does not corrupt later candidates', async () => {
    const subject = harness(withQuestions([BEFORE, BEFORE]));
    const first = [...subject.state().questions.values()][0];
    if (!first) throw new Error('Missing race fixture.');
    const changed = {
      ...first,
      revision: 2,
      expiresAt: AFTER,
      lastCommandId: 'tool:revised-race' as const,
    };
    const queuedChange = subject.queue.run(() => {
      subject.replaceState({
        ...subject.state(),
        questions: new Map(subject.state().questions).set(first.id, changed),
      });
    });
    const evaluation = subject.service.evaluateExpiry(new Date(NOW));
    await Promise.all([queuedChange, evaluation]);
    expect(statuses(subject.state())).toEqual(['pending', 'stale']);
    expect(subject.appended).toHaveLength(1);
  });

  it.each(['failure', 'throw'] as const)(
    'keeps state hidden and deterministic identity retryable after append %s',
    async (behavior) => {
      const subject = harness(withQuestions([BEFORE]));
      subject.setAppend(behavior);
      expect(await subject.service.evaluateExpiry(new Date(NOW))).toMatchObject({ failed: 1 });
      expect(statuses(subject.state())).toEqual(['pending']);
      const firstId = subject.ids.calls;
      subject.setAppend('ok');
      expect(await subject.service.evaluateExpiry(new Date(NOW))).toMatchObject({
        transitioned: 1,
      });
      expect(subject.ids.calls).toBe(firstId);
      expect(subject.appended).toHaveLength(1);
    },
  );

  it('is replay-idempotent and never applies a retained temporary default', async () => {
    const initial = withQuestions([BEFORE]);
    const question = [...initial.questions.values()][0];
    if (!question) throw new Error('Missing temporary-default fixture.');
    const withDefault: BoardState = {
      ...initial,
      questions: new Map(initial.questions).set(question.id, {
        ...question,
        class: 'reversible',
        temporaryDefault: { optionIds: ['first'], disclosure: 'Temporary local choice.' },
      }),
    };
    const subject = harness(withDefault);
    await subject.service.evaluateExpiry(new Date(NOW));
    const replayed = subject.state();
    const next = harness(replayed);
    await next.service.evaluateExpiry(new Date(NOW));
    expect(next.appended).toHaveLength(0);
    expect(replayed.answers.size).toBe(0);
    expect([...replayed.questions.values()][0]?.temporaryDefault).toEqual({
      optionIds: ['first'],
      disclosure: 'Temporary local choice.',
    });
    expect([...replayed.questions.values()][0]?.answerId).toBeUndefined();
  });

  it('refreshes only after durable state is exposed and contains refresh errors', async () => {
    let state = withQuestions([BEFORE]);
    const service = new ExpiryService({
      queue: new MutationQueue(),
      readState: () => state,
      swapState: (next) => {
        state = next;
      },
      append: async () => succeed(undefined),
      refresh: (next) => {
        expect(state).toBe(next);
        throw new Error('PRIVATE UI failure');
      },
      clock: new FakeClock(NOW),
      ids: new EventIds(),
      timers: inertTimers(),
      recordDiagnostic: () => undefined,
    });
    await expect(service.evaluateExpiry(new Date(NOW))).resolves.toMatchObject({ transitioned: 1 });
  });

  it('arms the nearest future expiry, unreferences it, and fires then re-arms', async () => {
    const clock = new FakeClock(NOW);
    const timers = new FakeTimers(clock);
    const subject = harness(
      withQuestions(['2026-08-12T12:00:02.000Z', '2026-08-12T12:00:01.000Z', undefined]),
      { clock, timers },
    );
    const callbacks: string[] = [];
    subject.service.armNearestTimerLocked(async () => {
      callbacks.push('fire');
      await subject.service.evaluateExpiryLocked(clock.now());
      subject.service.armNearestTimerLocked(async () => undefined);
    });
    expect(timers.calls.slice(0, 2)).toEqual([
      { operation: 'set', id: 1, delayMs: 1000 },
      { operation: 'unref', id: 1 },
    ]);
    await timers.advanceBy(1000);
    expect(callbacks).toEqual(['fire']);
    expect(statuses(subject.state())).toEqual(['pending', 'stale', 'pending']);
    expect(timers.pending()).toHaveLength(1);
  });

  it('chunks long delays at 2^31-1 milliseconds and re-arms the remainder', async () => {
    const clock = new FakeClock(NOW);
    const timers = new FakeTimers(clock);
    const subject = harness(
      withQuestions([new Date(clock.now().getTime() + MAX_TIMER_DELAY_MS + 50).toISOString()]),
      { clock, timers },
    );
    const arm = (): void => {
      subject.service.armNearestTimerLocked(async () => arm());
    };
    arm();
    expect(timers.calls[0]).toEqual({ operation: 'set', id: 1, delayMs: MAX_TIMER_DELAY_MS });
    await timers.advanceBy(MAX_TIMER_DELAY_MS);
    expect(timers.pending()).toEqual([{ id: 2, dueAt: clock.now().getTime() + 50, unrefed: true }]);
  });

  it('selects timers only from future answerable questions', () => {
    let initial = withQuestions(['2026-08-12T12:00:00.100Z', '2026-08-12T12:00:00.200Z', BEFORE]);
    initial = setStatus(initial, 1, 'cancelled');
    const subject = harness(initial);
    subject.service.armNearestTimerLocked(async () => undefined);
    expect(subject.timers.calls[0]).toEqual({ operation: 'set', id: 1, delayMs: 200 });
  });

  it('clears timers, rejects stale callbacks, and contains timer exceptions', async () => {
    const callbacks: Array<() => void | Promise<void>> = [];
    const cleared: unknown[] = [];
    const timerAdapter: ExpiryTimerAdapter = {
      setTimeout(callback) {
        callbacks.push(callback);
        return { unref: () => undefined };
      },
      clearTimeout(handle) {
        cleared.push(handle);
      },
    };
    const subject = harness(withQuestions([AFTER]));
    const replacement = new ExpiryService({
      queue: new MutationQueue(),
      readState: subject.state,
      swapState: subject.replaceState,
      append: async () => succeed(undefined),
      refresh: () => undefined,
      clock: subject.clock,
      ids: new EventIds(),
      timers: timerAdapter,
      recordDiagnostic: (record) => subject.diagnostics.push(record),
    });
    replacement.armNearestTimerLocked(async () => {
      throw new Error('PRIVATE timer failure');
    });
    replacement.clearTimerLocked();
    await callbacks[0]?.();
    expect(cleared).toHaveLength(1);
    expect(subject.diagnostics).toHaveLength(0);

    replacement.armNearestTimerLocked(async () => {
      throw new Error('PRIVATE timer failure');
    });
    await callbacks[1]?.();
    expect(subject.diagnostics).toEqual([{ code: 'SB_INTERNAL', category: 'unexpected' }]);
    expect(JSON.stringify(subject.diagnostics)).not.toContain('PRIVATE');
  });

  it('records and cleans up timer adapter errors without board content', () => {
    const subject = harness(withQuestions([AFTER]));
    const service = new ExpiryService({
      queue: new MutationQueue(),
      readState: subject.state,
      swapState: subject.replaceState,
      append: async () => succeed(undefined),
      refresh: () => undefined,
      clock: subject.clock,
      ids: new EventIds(),
      timers: {
        setTimeout() {
          throw new Error('PRIVATE Question 1');
        },
        clearTimeout() {
          throw new Error('PRIVATE cleanup');
        },
      },
      recordDiagnostic: (record) => subject.diagnostics.push(record),
    });
    expect(service.armNearestTimerLocked(async () => undefined)).toBeUndefined();
    service.clearTimerLocked();
    expect(subject.diagnostics).toEqual([{ code: 'SB_INTERNAL', category: 'unexpected' }]);
  });

  it('evaluates expiry during session start before timer ownership', async () => {
    const runtime = runtimeHarness([BEFORE]);
    await runtime.pi.dispatch('session_start');
    expect(statuses(runtime.lifecycle.slot.current()?.state ?? createEmptyBoardState())).toEqual([
      'stale',
    ]);
    expect(
      runtime.pi.appendCalls.map((call) => (call.data as QuestionStaledEvent).eventType),
    ).toEqual(['question.staled']);
    expect(runtime.timers.pending()).toHaveLength(0);
  });

  it('evaluates before agent-settled escalation and exposes a board-open boundary', async () => {
    const order: string[] = [];
    const runtime = runtimeHarness([AFTER], {
      hooks: {
        escalateConditionalQuestionsLocked(current) {
          order.push([...current.state.questions.values()][0]?.status ?? 'missing');
        },
      },
    });
    await runtime.pi.dispatch('session_start');
    runtime.clock.set('2026-08-12T12:00:00.002Z');
    await runtime.pi.dispatch('agent_settled');
    expect(order).toEqual(['stale']);

    const board = runtimeHarness([NOW]);
    board.clock.set(BEFORE);
    await board.pi.dispatch('session_start');
    board.clock.set(NOW);
    await expect(board.lifecycle.evaluateBoardOpen()).resolves.toMatchObject({
      ok: true,
      value: { transitioned: 1 },
    });
  });

  it('re-arms after a question mutation, fires, and cleans up on tree and shutdown', async () => {
    const runtime = runtimeHarness([]);
    await runtime.pi.dispatch('session_start');
    const service = runtime.lifecycle.slot.current()?.questionService;
    if (!service) throw new Error('Expected the runtime question service.');
    const result = await service.createQuestion({
      commandId: 'tool:mutation-expiry',
      question: 'Which local mode?',
      reason: 'Independent work can continue.',
      class: 'preference',
      response: {
        kind: 'single',
        options: [
          { id: 'first', label: 'First' },
          { id: 'second', label: 'Second' },
        ],
      },
      expiresAt: AFTER,
    });
    expect(result.ok).toBe(true);
    expect(runtime.timers.pending()).toMatchObject([{ unrefed: true }]);
    await runtime.timers.advanceBy(1);
    expect(statuses(runtime.lifecycle.slot.current()?.state ?? createEmptyBoardState())).toEqual([
      'stale',
    ]);
    expect(runtime.timers.pending()).toHaveLength(0);

    runtime.pi.replaceBranch([]);
    await runtime.pi.dispatch('session_tree');
    expect(runtime.timers.pending()).toHaveLength(0);
    await runtime.pi.dispatch('session_shutdown');
    expect(runtime.timers.pending()).toHaveLength(0);
  });
});

function runtimeHarness(
  expiries: readonly string[],
  options: { readonly hooks?: import('../../src/runtime/types.js').RuntimeLifecycleHooks } = {},
) {
  const clock = new FakeClock(NOW);
  const timers = new FakeTimers(clock);
  const pi = new FakePiHarness();
  let parentId: string | null = null;
  const entries = expiries.map((expiry, index) => {
    const entry = makeCustomEntry({
      id: `question-entry-${index + 1}`,
      parentId,
      data: questionEvent(index + 1, expiry),
    });
    parentId = entry.id;
    return entry;
  });
  pi.replaceBranch(entries);
  let lifecycle: RuntimeLifecycle | undefined;
  createSignalBoardExtension({
    evaluateCompatibility: () =>
      evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }),
    loadConfig: async () => ({
      config: DEFAULT_CONFIG,
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    now: () => clock.now(),
    replay: (entries) => {
      let state = createEmptyBoardState();
      for (const entry of entries) {
        if (entry.type !== 'custom') continue;
        const reduced = reduceBoardEvent(state, entry.data as QuestionCreatedEvent);
        if (reduced.ok) state = reduced.state;
      }
      return { state, acceptedEvents: state.replay.acceptedEvents, skippedEvents: 0, warnings: [] };
    },
    writePrint: () => undefined,
    hooks: options.hooks ?? {},
    expiryTimers: {
      setTimeout: (callback, delayMs) => timers.setTimeout(callback, delayMs),
      clearTimeout: (handle) => timers.clearTimeout(handle as FakeTimerHandle),
      unref: (handle) => timers.unref(handle as FakeTimerHandle),
    },
    captureLifecycle(value) {
      lifecycle = value;
    },
  })(pi.api);
  if (!lifecycle) throw new Error('Expected lifecycle capture.');
  return { pi, lifecycle, clock, timers };
}

function inertTimers(): ExpiryTimerAdapter {
  return {
    setTimeout: () => ({}),
    clearTimeout: () => undefined,
  };
}
