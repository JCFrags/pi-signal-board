import { describe, expect, it, vi } from 'vitest';

import {
  BoardActionCoordinator,
  type BoardActionRuntimeCapture,
  type BoardMutationIntent,
  captureBoardAction,
} from '../../src/commands/board-action-coordinator.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import type { BoardState, QuestionItem, UpdateItem } from '../../src/domain/types.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import type { SignalBoardRuntime } from '../../src/runtime/types.js';
import { createDiagnostics } from '../../src/services/diagnostics.js';
import { createDeferred, FakePiHarness } from '../helpers/index.js';

const QUESTION_ID = 'qst_35000000-0000-4000-8000-000000000001' as const;
const UPDATE_ID = 'upd_35000000-0000-4000-8000-000000000001' as const;
const ANSWER_ID = 'ans_35000000-0000-4000-8000-000000000001' as const;
const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });

function question(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    id: QUESTION_ID,
    displayId: 'Q-35',
    revision: 3,
    status: 'pending',
    question: 'Synthetic private question',
    reason: 'Synthetic private reason',
    class: 'preference',
    response: {
      kind: 'single',
      options: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
    },
    recommendedOptionIds: ['one'],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'nextTurn',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    createdAt: '2026-08-12T14:00:00.000Z',
    updatedAt: '2026-08-12T14:00:00.000Z',
    lastEventId: 'evt_35000000-0000-4000-8000-000000000001',
    lastCommandId: 'tool:create-35',
    ...overrides,
  } as QuestionItem;
}

function update(overrides: Partial<UpdateItem> = {}): UpdateItem {
  return {
    id: UPDATE_ID,
    displayId: 'U-35',
    revision: 4,
    kind: 'completed',
    title: 'Synthetic private update',
    stage: 'complete',
    attachments: [],
    createdAt: '2026-08-12T14:00:00.000Z',
    updatedAt: '2026-08-12T14:10:00.000Z',
    completedAt: '2026-08-12T14:10:00.000Z',
    archived: false,
    lastEventId: 'evt_35000000-0000-4000-8000-000000000002',
    lastCommandId: 'tool:update-35',
    ...overrides,
  } as UpdateItem;
}

function state(itemQuestion = question(), itemUpdate = update()): BoardState {
  return {
    ...createEmptyBoardState(),
    questions: new Map([[itemQuestion.id, itemQuestion]]),
    updates: new Map([[itemUpdate.id, itemUpdate]]),
  };
}

function fixture() {
  const harness = new FakePiHarness();
  const lifecycle = new RuntimeLifecycle({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: async () => ({
      config: DEFAULT_CONFIG,
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    replay: () => ({
      state: createEmptyBoardState(),
      acceptedEvents: 0,
      skippedEvents: 0,
      warnings: [],
    }),
    now: () => new Date('2026-08-12T14:35:00.000Z'),
    hooks: {},
  });
  const runtime: SignalBoardRuntime = {
    generation: 35,
    identity: { persistence: 'persistent', token: 'session-token' },
    treeRevision: 7,
    context: harness.context(),
    queue: lifecycle.queue,
    compatibility: SUPPORTED,
    config: {
      config: DEFAULT_CONFIG,
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    },
    diagnostics: createDiagnostics(),
    state: state(),
    status: 'healthy',
    timer: undefined,
    disposed: false,
    disposeCount: 0,
    notifications: new Set(),
  };
  lifecycle.slot.replaceLocked(runtime);
  const guard: BoardActionRuntimeCapture = {
    generation: runtime.generation,
    identityToken: runtime.identity.token,
    treeRevision: runtime.treeRevision,
  };
  return { harness, lifecycle, runtime, guard, coordinator: new BoardActionCoordinator(lifecycle) };
}

function action(intent: BoardMutationIntent) {
  if (intent === 'archive_update') {
    return { type: intent, entityId: UPDATE_ID, expectedRevision: 4 } as const;
  }
  if (intent === 'retry_delivery') {
    return {
      type: intent,
      entityId: QUESTION_ID,
      expectedRevision: 3,
      answerId: ANSWER_ID,
    } as const;
  }
  return { type: intent, entityId: QUESTION_ID, expectedRevision: 3 } as const;
}

describe('SB-035 shared board action writer boundary', () => {
  it.each(['answer', 'accept_recommendation', 'dismiss', 'archive_update'] as const)(
    'executes one unchanged %s intent exactly once',
    async (intent) => {
      const { coordinator, guard } = fixture();
      const service = vi.fn(async () => succeed('accepted'));
      const result = await coordinator.run(captureBoardAction(guard, action(intent)), service);
      expect(result).toEqual({ ok: true, value: 'accepted' });
      expect(service).toHaveBeenCalledOnce();
    },
  );

  it.each(['single', 'multiple', 'text', 'single_or_text', 'multiple_or_text'] as const)(
    'keeps the captured revision for %s answer mode',
    async (kind) => {
      const { coordinator, guard, runtime, harness } = fixture();
      runtime.state = state(
        question({
          response:
            kind === 'text'
              ? { kind, options: [] }
              : {
                  kind,
                  options: [
                    { id: 'one', label: 'One' },
                    { id: 'two', label: 'Two' },
                  ],
                },
        }),
      );
      const capture = captureBoardAction(guard, action('answer'));
      runtime.state = state(question({ revision: 4 }));
      const service = vi.fn(async () => succeed(undefined));
      expect(await coordinator.run(capture, service)).toMatchObject({
        ok: false,
        error: { code: 'SB_REVISION_MISMATCH' },
      });
      expect(capture.expectedRevision).toBe(3);
      expect(service).not.toHaveBeenCalled();
      expect(harness.appendCalls).toHaveLength(0);
      expect(harness.sendCalls).toHaveLength(0);
    },
  );

  it.each(['answer', 'accept_recommendation', 'dismiss'] as const)(
    'rejects a revised question before %s service dispatch',
    async (intent) => {
      const { coordinator, guard, runtime } = fixture();
      const capture = captureBoardAction(guard, action(intent));
      runtime.state = state(question({ revision: 4 }));
      const service = vi.fn(async () => succeed(undefined));
      expect(await coordinator.run(capture, service)).toMatchObject({
        ok: false,
        error: { code: 'SB_REVISION_MISMATCH' },
      });
      expect(service).not.toHaveBeenCalled();
    },
  );

  it('executes unchanged retry only for the captured answer identity', async () => {
    const { coordinator, guard, runtime } = fixture();
    runtime.state = state(question({ status: 'delivery_failed', answerId: ANSWER_ID }));
    const service = vi.fn(async () => succeed('retried'));
    expect(
      await coordinator.run(captureBoardAction(guard, action('retry_delivery')), service),
    ).toEqual({ ok: true, value: 'retried' });
    expect(service).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'revision change',
      'SB_REVISION_MISMATCH',
      (runtime: SignalBoardRuntime) => {
        runtime.state = state(question({ revision: 4 }));
      },
    ],
    [
      'entity removal',
      'SB_NOT_FOUND',
      (runtime: SignalBoardRuntime) => {
        runtime.state = { ...runtime.state, questions: new Map() };
      },
    ],
    [
      'state transition',
      'SB_STATE_CONFLICT',
      (runtime: SignalBoardRuntime) => {
        runtime.state = state(question({ status: 'cancelled' }));
      },
    ],
    [
      'tree replacement',
      'SB_STATE_CONFLICT',
      (runtime: SignalBoardRuntime) => {
        runtime.treeRevision += 1;
      },
    ],
    [
      'session switch',
      'SB_STATE_CONFLICT',
      (runtime: SignalBoardRuntime) => {
        Object.defineProperty(runtime, 'identity', {
          value: { ...runtime.identity, token: 'other-session' },
        });
      },
    ],
    [
      'shutdown',
      'SB_STATE_CONFLICT',
      (runtime: SignalBoardRuntime) => {
        runtime.disposed = true;
        runtime.status = 'degraded';
      },
    ],
    [
      'compatibility loss',
      'SB_STATE_CONFLICT',
      (runtime: SignalBoardRuntime) => {
        runtime.status = 'unsupported';
      },
    ],
  ] as const)('rejects %s before a service call', async (_label, code, change) => {
    const { coordinator, guard, runtime, harness } = fixture();
    const capture = captureBoardAction(guard, action('answer'));
    change(runtime);
    const service = vi.fn(async () => succeed('must-not-run'));
    const result = await coordinator.run(capture, service);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(service).not.toHaveBeenCalled();
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
    expect(capture.expectedRevision).toBe(3);
  });

  it('rejects archive state and revision changes through the same boundary', async () => {
    const { coordinator, guard, runtime } = fixture();
    const capture = captureBoardAction(guard, action('archive_update'));
    const service = vi.fn(async () => succeed(undefined));

    runtime.state = state(question(), update({ revision: 5 }));
    expect(await coordinator.run(capture, service)).toMatchObject({
      ok: false,
      error: { code: 'SB_REVISION_MISMATCH' },
    });
    runtime.state = state(question(), update({ kind: 'working', revision: 4 }));
    expect(await coordinator.run(capture, service)).toMatchObject({
      ok: false,
      error: { code: 'SB_STATE_CONFLICT' },
    });
    expect(service).not.toHaveBeenCalled();
  });

  it('rejects a retry capture without an immutable answer identity', () => {
    const { guard } = fixture();
    expect(() =>
      captureBoardAction(guard, {
        type: 'retry_delivery',
        entityId: QUESTION_ID,
        expectedRevision: 3,
      }),
    ).toThrow('Retry action has no answer identity.');
  });

  it('preflights future service intents and contains thrown service errors', async () => {
    const { coordinator, guard } = fixture();
    const capture = captureBoardAction(guard, action('answer'));
    expect(await coordinator.preflight(capture)).toEqual({ ok: true, value: undefined });
    expect(
      await coordinator.run(capture, () => {
        throw new Error('synthetic private service content');
      }),
    ).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
  });

  it('returns a persistence failure unchanged and does not retry', async () => {
    const { coordinator, guard, harness } = fixture();
    const service = vi.fn(async () => fail(signalBoardError('SB_PERSISTENCE_FAILED')));
    const result = await coordinator.run(captureBoardAction(guard, action('dismiss')), service);
    expect(result).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(service).toHaveBeenCalledOnce();
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('serializes replacement after preflight without retrying the accepted service', async () => {
    const { coordinator, guard, lifecycle, runtime } = fixture();
    const entered = createDeferred<void>('service-entered');
    const release = createDeferred<void>('service-release');
    const service = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return succeed('durable');
    });

    const mutation = coordinator.run(captureBoardAction(guard, action('dismiss')), service);
    await entered.promise;
    const replacement = lifecycle.queue.run(() => {
      runtime.treeRevision += 1;
    });
    expect(runtime.treeRevision).toBe(7);
    release.resolve();
    expect(await mutation).toEqual({ ok: true, value: 'durable' });
    await replacement;
    expect(runtime.treeRevision).toBe(8);
    expect(service).toHaveBeenCalledOnce();
  });

  it('runs fixed-seed repeated race cycles without timers or retained callbacks', async () => {
    const seed = 0x5b035;
    let randomState = seed;
    const next = () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState;
    };
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      for (let run = 0; run < 500; run += 1) {
        const { coordinator, guard, runtime } = fixture();
        const changed = (next() & 1) === 1;
        if (changed) runtime.state = state(question({ revision: 4 }));
        const service = vi.fn(async () => succeed(run));
        const result = await coordinator.run(
          captureBoardAction(guard, action(run % 2 === 0 ? 'answer' : 'dismiss')),
          service,
        );
        expect(result.ok, `seed=${seed} case=${run}`).toBe(!changed);
        expect(service, `seed=${seed} case=${run}`).toHaveBeenCalledTimes(changed ? 0 : 1);
      }
    } catch (error) {
      console.error(`board-action-coordinator property seed=${seed} state=${randomState}`);
      throw error;
    } finally {
      expect(timer).not.toHaveBeenCalled();
      timer.mockRestore();
    }
  });
});
