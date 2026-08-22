import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type {
  QuestionCreatedEvent,
  QuestionEscalatedEvent,
  QuestionRevisedEvent,
} from '../../src/domain/events.js';
import type { EventId, IdGenerator, QuestionId } from '../../src/domain/ids.js';
import { createEmptyBoardState, reduceBoardEvent } from '../../src/domain/reducer.js';
import type { BoardState, QuestionItem, QuestionStatus } from '../../src/domain/types.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import { replayBranch } from '../../src/persistence/replay.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { QuestionEscalationService } from '../../src/services/question-escalation-service.js';
import { createDeferred } from '../helpers/deferred.js';
import { FakePiHarness, makeCustomEntry } from '../helpers/fake-pi.js';

const AT = '2026-08-12T12:00:00.000Z';

type AppendBehavior = 'ok' | 'failure' | 'throw';

class EscalationIds implements Pick<IdGenerator, 'event'> {
  calls = 0;
  throws = false;

  event(): EventId {
    if (this.throws) throw new Error('PRIVATE ID text');
    this.calls += 1;
    return `evt_90000000-0000-4000-8000-${this.calls.toString().padStart(12, '0')}`;
  }
}

function created(sequence: number, policy: QuestionItem['blockingPolicy']): QuestionCreatedEvent {
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
        question: `PRIVATE question ${sequence}`,
        reason: `PRIVATE reason ${sequence}`,
        class: 'preference',
        response: {
          kind: 'single',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
        recommendedOptionIds: [],
        priority: 'normal',
        blockingPolicy: policy,
        deliveryMode: 'steer',
        affectedWork: [],
        continuingWork: [],
        attachments: [],
      },
    },
  };
}

function apply(state: BoardState, event: QuestionCreatedEvent | QuestionRevisedEvent): BoardState {
  const reduced = reduceBoardEvent(state, event);
  if (!reduced.ok) throw new Error(`Fixture reducer rejected ${event.eventType}.`);
  return reduced.state;
}

function initialState(policies: readonly QuestionItem['blockingPolicy'][]): BoardState {
  return policies.reduce(
    (state, policy, index) => apply(state, created(index + 1, policy)),
    createEmptyBoardState(),
  );
}

function serviceHarness(
  options: { state?: BoardState; notifyEnabled?: boolean; recordDiagnostic?: boolean } = {},
) {
  let state = options.state ?? initialState(['when_agent_settles']);
  const queue = new MutationQueue();
  const ids = new EscalationIds();
  const events: QuestionEscalatedEvent[] = [];
  const notifications: Array<{ message: string; severity: string }> = [];
  const diagnostics: Array<{ area: string; at: string }> = [];
  const refreshes: BoardState[] = [];
  let appendBehavior: AppendBehavior = 'ok';
  let appendGate: ReturnType<typeof createDeferred<void>> | undefined;
  let notifyThrows = false;
  let refreshThrows = false;
  let clockThrows = false;
  let diagnosticThrows = false;
  let stateReadCount = 0;
  let stateReadHook: ((count: number) => void) | undefined;
  const forbiddenCalls = { messages: 0, defaults: 0, answers: 0, turns: 0 };

  const service = new QuestionEscalationService({
    queue,
    readState: () => {
      stateReadCount += 1;
      stateReadHook?.(stateReadCount);
      return state;
    },
    swapState: (next) => {
      state = next;
    },
    append: async (event) => {
      await appendGate?.promise;
      if (appendBehavior === 'throw') throw new Error('PRIVATE append text');
      if (appendBehavior === 'failure') return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      events.push(event);
      return succeed(undefined);
    },
    refresh: (next) => {
      if (refreshThrows) throw new Error('PRIVATE UI text');
      refreshes.push(next);
    },
    notify: (message, severity) => {
      if (notifyThrows) throw new Error('PRIVATE notification text');
      notifications.push({ message, severity });
    },
    ...(options.recordDiagnostic === false
      ? {}
      : {
          recordPostDurableFailure: (area: 'notification' | 'ui', at: string) => {
            if (diagnosticThrows) throw new Error('PRIVATE diagnostic text');
            diagnostics.push({ area, at });
          },
        }),
    clock: {
      now: () => {
        if (clockThrows) throw new Error('PRIVATE clock text');
        return new Date(AT);
      },
    },
    ids,
    config: {
      notifications: {
        ...DEFAULT_CONFIG.notifications,
        questionEscalated: options.notifyEnabled ?? true,
      },
    },
  });

  return {
    service,
    queue,
    ids,
    events,
    notifications,
    diagnostics,
    refreshes,
    forbiddenCalls,
    state: () => state,
    setState(next: BoardState) {
      state = next;
    },
    setAppendBehavior(value: AppendBehavior) {
      appendBehavior = value;
    },
    setAppendGate(value: ReturnType<typeof createDeferred<void>> | undefined) {
      appendGate = value;
    },
    setNotifyThrows(value: boolean) {
      notifyThrows = value;
    },
    setRefreshThrows(value: boolean) {
      refreshThrows = value;
    },
    setClockThrows(value: boolean) {
      clockThrows = value;
    },
    setDiagnosticThrows(value: boolean) {
      diagnosticThrows = value;
    },
    setStateReadHook(value: ((count: number) => void) | undefined) {
      stateReadHook = value;
    },
  };
}

function replaceQuestion(
  state: BoardState,
  sequence: number,
  patch: Partial<QuestionItem>,
): BoardState {
  const id = `qst_10000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}` as QuestionId;
  const current = state.questions.get(id);
  if (current === undefined) throw new Error('Missing fixture question.');
  return { ...state, questions: new Map(state.questions).set(id, { ...current, ...patch }) };
}

function statuses(state: BoardState): QuestionStatus[] {
  return [...state.questions.values()].map((question) => question.status);
}

async function settle(harness: ReturnType<typeof serviceHarness>) {
  return harness.service.escalateConditionalQuestions();
}

describe('question escalation service', () => {
  it('FR-080 escalates each pending conditional question once in display order', async () => {
    const state = initialState(['when_agent_settles', 'never', 'when_agent_settles']);
    const harness = serviceHarness({ state });

    const first = await settle(harness);
    const repeat = await settle(harness);

    expect(first).toMatchObject({
      ok: true,
      value: { events: [{ eventType: 'question.escalated' }, { eventType: 'question.escalated' }] },
    });
    expect(repeat).toEqual({ ok: true, value: { events: [] } });
    expect(harness.events.map((event) => event.payload.questionId)).toEqual([
      created(1, 'when_agent_settles').payload.questionId,
      created(3, 'when_agent_settles').payload.questionId,
    ]);
    expect(statuses(harness.state())).toEqual(['blocking', 'pending', 'blocking']);
    expect(harness.notifications).toEqual([
      { message: 'Agent Board escalated Q-1 to blocking.', severity: 'warning' },
      { message: 'Agent Board escalated Q-3 to blocking.', severity: 'warning' },
    ]);
    expect(harness.refreshes).toHaveLength(2);
    expect(harness.forbiddenCalls).toEqual({ messages: 0, defaults: 0, answers: 0, turns: 0 });
  });

  it.each([
    ['blocking', {}],
    ['answered', { answerId: 'ans_10000000-0000-4000-8000-000000000001' }],
    ['delivery_queued', { answerId: 'ans_10000000-0000-4000-8000-000000000001' }],
    ['delivery_failed', { answerId: 'ans_10000000-0000-4000-8000-000000000001' }],
    ['needs_attention', { answerId: 'ans_10000000-0000-4000-8000-000000000001' }],
    ['resolved', { answerId: 'ans_10000000-0000-4000-8000-000000000001' }],
    ['stale', {}],
    ['cancelled', {}],
    ['dismissed', {}],
  ] as const)('skips non-pending status %s', async (status, patch) => {
    const state = replaceQuestion(initialState(['when_agent_settles']), 1, { status, ...patch });
    const harness = serviceHarness({ state });

    expect(await settle(harness)).toEqual({ ok: true, value: { events: [] } });
    expect(harness.events).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
  });

  it('skips a pending question that already has an answer binding', async () => {
    const state = replaceQuestion(initialState(['when_agent_settles']), 1, {
      answerId: 'ans_10000000-0000-4000-8000-000000000001',
    });
    const harness = serviceHarness({ state });
    expect(await settle(harness)).toEqual({ ok: true, value: { events: [] } });
  });

  it('uses exact system identity and escalates a later current revision', async () => {
    const base = initialState(['when_agent_settles']);
    const current = [...base.questions.values()][0];
    if (current === undefined) throw new Error('Missing fixture question.');
    const revised: QuestionRevisedEvent = {
      schemaVersion: 1,
      eventId: 'evt_20000000-0000-4000-8000-000000000001',
      eventType: 'question.revised',
      occurredAt: '2026-08-12T11:00:00.000Z',
      actor: 'agent',
      commandId: 'tool:revise-1',
      payload: {
        questionId: current.id,
        expectedRevision: 1,
        revision: 2,
        updatedAt: '2026-08-12T11:00:00.000Z',
        revisionSummary: 'Changed the safe choice.',
        spec: {
          ...created(1, 'when_agent_settles').payload.spec,
          question: 'PRIVATE revised question',
        },
      },
    };
    const harness = serviceHarness({ state: apply(base, revised) });

    await settle(harness);

    expect(harness.events[0]).toMatchObject({
      commandId: `system:escalate:${current.id}:2`,
      payload: { expectedRevision: 2, revision: 3 },
    });
  });

  it('re-reads and skips a candidate removed before its transition', async () => {
    const harness = serviceHarness();
    harness.setStateReadHook((count) => {
      if (count !== 2) return;
      const next = new Map(harness.state().questions);
      next.clear();
      harness.setState({ ...harness.state(), questions: next });
    });

    expect(await settle(harness)).toEqual({ ok: true, value: { events: [] } });
    expect(harness.events).toHaveLength(0);
  });

  it('serializes concurrent settled callbacks without duplicate append or notification', async () => {
    const harness = serviceHarness();
    const gate = createDeferred<void>('append');
    harness.setAppendGate(gate);

    const first = settle(harness);
    const second = settle(harness);
    await Promise.resolve();
    expect(harness.events).toHaveLength(0);
    gate.resolve();
    await Promise.all([first, second]);

    expect(harness.events).toHaveLength(1);
    expect(harness.notifications).toHaveLength(1);
  });

  it.each(['failure', 'throw'] as const)(
    'keeps state retryable and reserves event identity after append %s',
    async (behavior) => {
      const harness = serviceHarness();
      harness.setAppendBehavior(behavior);
      const failed = await settle(harness);
      expect(failed).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
      expect(statuses(harness.state())).toEqual(['pending']);
      expect(harness.notifications).toHaveLength(0);
      expect(harness.refreshes).toHaveLength(0);
      expect(harness.ids.calls).toBe(1);

      harness.setAppendBehavior('ok');
      expect(await settle(harness)).toMatchObject({ ok: true, value: { events: [{}] } });
      expect(harness.ids.calls).toBe(1);
      expect(harness.events).toHaveLength(1);
    },
  );

  it('contains notification and refresh failures after durability without retry effects', async () => {
    const harness = serviceHarness();
    harness.setNotifyThrows(true);
    harness.setRefreshThrows(true);

    expect(await settle(harness)).toMatchObject({ ok: true, value: { events: [{}] } });
    expect(statuses(harness.state())).toEqual(['blocking']);
    expect(harness.diagnostics).toEqual([
      { area: 'notification', at: AT },
      { area: 'ui', at: AT },
    ]);
    expect(await settle(harness)).toEqual({ ok: true, value: { events: [] } });
    expect(harness.events).toHaveLength(1);
    expect(JSON.stringify(harness.diagnostics)).not.toContain('PRIVATE');
  });

  it('uses ID order when malformed display IDs reach the defensive service boundary', async () => {
    let state = initialState(['when_agent_settles', 'when_agent_settles']);
    state = replaceQuestion(state, 1, { displayId: 'Q-NaN' as QuestionItem['displayId'] });
    state = replaceQuestion(state, 2, { displayId: 'Q-NaN' as QuestionItem['displayId'] });
    state = { ...state, questions: new Map([...state.questions].reverse()) };
    const harness = serviceHarness({ state, notifyEnabled: false });

    await settle(harness);

    expect(harness.events.map((event) => event.payload.questionId)).toEqual([
      created(1, 'when_agent_settles').payload.questionId,
      created(2, 'when_agent_settles').payload.questionId,
    ]);
  });

  it('returns content-free internal failures for invalid time, clock, and ID boundaries', async () => {
    const invalidTime = serviceHarness();
    expect(
      await invalidTime.service.escalateConditionalQuestionsLocked('PRIVATE time'),
    ).toMatchObject({
      ok: false,
      error: { code: 'SB_INTERNAL' },
    });
    expect(
      await invalidTime.service.escalateConditionalQuestionsLocked('2026-99-12T12:00:00.000Z'),
    ).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
    expect(
      await invalidTime.service.escalateConditionalQuestionsLocked('2026-08-12T24:00:00.000Z'),
    ).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });

    const clock = serviceHarness();
    clock.setClockThrows(true);
    expect(await settle(clock)).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });

    const ids = serviceHarness();
    ids.ids.throws = true;
    const result = await settle(ids);
    expect(result).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('contains diagnostic failure after durability', async () => {
    const harness = serviceHarness();
    harness.setNotifyThrows(true);
    harness.setDiagnosticThrows(true);
    expect(await settle(harness)).toMatchObject({ ok: true, value: { events: [{}] } });
    expect(harness.events).toHaveLength(1);

    const withoutSink = serviceHarness({ recordDiagnostic: false });
    withoutSink.setNotifyThrows(true);
    expect(await settle(withoutSink)).toMatchObject({ ok: true, value: { events: [{}] } });
  });

  it('honors disabled escalation notifications while still refreshing', async () => {
    const harness = serviceHarness({ notifyEnabled: false });
    await settle(harness);
    expect(harness.events).toHaveLength(1);
    expect(harness.notifications).toHaveLength(0);
    expect(harness.refreshes).toHaveLength(1);
  });

  it('is replay-idempotent from the newly durable event', async () => {
    const first = serviceHarness();
    await settle(first);
    const replayed = reduceBoardEvent(
      initialState(['when_agent_settles']),
      first.events[0] as QuestionEscalatedEvent,
    );
    if (!replayed.ok) throw new Error('Escalation replay fixture failed.');
    const restored = serviceHarness({ state: replayed.state });

    expect(await settle(restored)).toEqual({ ok: true, value: { events: [] } });
    expect(restored.ids.calls).toBe(0);
  });

  it('re-reads state after expiry-first replacement and does not expose private content', async () => {
    const harness = serviceHarness();
    harness.setState(
      replaceQuestion(harness.state(), 1, { status: 'stale', staleReason: 'Expired.' }),
    );

    const result = await harness.service.escalateConditionalQuestionsLocked(AT);

    expect(result).toEqual({ ok: true, value: { events: [] } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('wires the accepted agent_settled hook with durable replay and one warning', async () => {
    const harness = new FakePiHarness({ now: AT });
    harness.replaceBranch([
      makeCustomEntry({ id: 'question1', data: created(1, 'when_agent_settles') }),
    ]);
    let lifecycle: RuntimeLifecycle | undefined;
    createSignalBoardExtension({
      evaluateCompatibility: () =>
        evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }),
      loadConfig: async () => ({
        config: DEFAULT_CONFIG,
        sources: { global: 'absent', project: 'absent' },
        warnings: [],
      }),
      replay: replayBranch,
      now: () => new Date(AT),
      writePrint: () => undefined,
      captureLifecycle: (value) => {
        lifecycle = value;
      },
    })(harness.api);

    await harness.dispatch('session_start');
    await harness.dispatch('agent_settled');
    await harness.dispatch('agent_settled');

    expect(harness.appendCalls).toHaveLength(1);
    expect((harness.appendCalls[0]?.data as QuestionEscalatedEvent).eventType).toBe(
      'question.escalated',
    );
    expect(lifecycle?.slot.current()?.state.questions.values().next().value?.status).toBe(
      'blocking',
    );
    expect(harness.uiCalls.filter((call) => call.surface === 'notify')).toHaveLength(1);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('rejects a stale service after session runtime replacement without append', async () => {
    const harness = new FakePiHarness({ now: AT });
    harness.replaceBranch([
      makeCustomEntry({ id: 'question1', data: created(1, 'when_agent_settles') }),
    ]);
    let lifecycle: RuntimeLifecycle | undefined;
    createSignalBoardExtension({
      evaluateCompatibility: () =>
        evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }),
      loadConfig: async () => ({
        config: DEFAULT_CONFIG,
        sources: { global: 'absent', project: 'absent' },
        warnings: [],
      }),
      replay: replayBranch,
      now: () => new Date(AT),
      writePrint: () => undefined,
      captureLifecycle: (value) => {
        lifecycle = value;
      },
    })(harness.api);
    await harness.dispatch('session_start');
    const staleService = lifecycle?.slot.current()?.questionEscalationService;
    if (staleService === undefined) throw new Error('Expected the escalation service.');

    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const result = await staleService.escalateConditionalQuestions();

    expect(result).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
    expect(harness.appendCalls).toHaveLength(0);
  });

  it('runs injected expiry evaluation before the accepted escalation hook', async () => {
    const harness = new FakePiHarness({ now: AT });
    harness.replaceBranch([
      makeCustomEntry({ id: 'question1', data: created(1, 'when_agent_settles') }),
    ]);
    let expiryCalls = 0;
    createSignalBoardExtension({
      evaluateCompatibility: () =>
        evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }),
      loadConfig: async () => ({
        config: DEFAULT_CONFIG,
        sources: { global: 'absent', project: 'absent' },
        warnings: [],
      }),
      replay: replayBranch,
      now: () => new Date(AT),
      writePrint: () => undefined,
      hooks: {
        evaluateExpiryLocked(runtime) {
          expiryCalls += 1;
          if (expiryCalls === 1) return;
          runtime.state = replaceQuestion(runtime.state, 1, {
            status: 'stale',
            staleReason: 'Expired.',
          });
        },
      },
    })(harness.api);

    await harness.dispatch('session_start');
    await harness.dispatch('agent_settled');

    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.uiCalls.filter((call) => call.surface === 'notify')).toHaveLength(0);
  });
});
