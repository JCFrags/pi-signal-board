import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { type ConfigLoadContext, loadConfiguration } from '../../src/config/loader.js';
import type { ConfigLoadResult } from '../../src/config/types.js';
import type { UpdateUpsertedEvent } from '../../src/domain/events.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import { replayBranch } from '../../src/persistence/replay.js';
import type { RuntimeLifecycleHooks, SignalBoardRuntime } from '../../src/runtime/types.js';
import { createDeferred } from '../helpers/deferred.js';
import type { FakeTimerHandle } from '../helpers/deterministic.js';
import { FakePiHarness, makeCustomEntry } from '../helpers/fake-pi.js';

const AT = '2026-08-08T20:00:00.000Z';
const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });

function config(enabled = true): ConfigLoadResult {
  return {
    config: Object.freeze({ ...DEFAULT_CONFIG, enabled }),
    sources: { global: 'absent', project: 'absent' },
    warnings: [],
  };
}

function event(
  sequence: number,
  title: string,
  updateId: `upd_${string}`,
  displayId: `U-${number}` = 'U-1',
): UpdateUpsertedEvent {
  return {
    schemaVersion: 1,
    eventId: `evt_40000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    eventType: 'update.upserted',
    occurredAt: AT,
    actor: 'agent',
    commandId: `tool:runtime-${sequence}`,
    payload: {
      updateId,
      displayId,
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
      fields: { kind: 'working', title, attachments: [] },
    },
  };
}

function entry(id: string, parentId: string | null, value: UpdateUpsertedEvent): SessionEntry {
  return makeCustomEntry({ id, parentId, data: value });
}

function register(
  harness: FakePiHarness,
  input: {
    hooks?: RuntimeLifecycleHooks;
    loadConfig?: (context: ConfigLoadContext) => Promise<ConfigLoadResult>;
    replay?: typeof replayBranch;
  } = {},
): RuntimeLifecycle {
  let lifecycle: RuntimeLifecycle | undefined;
  createSignalBoardExtension({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: input.loadConfig ?? (async () => config()),
    replay: input.replay ?? replayBranch,
    now: () => new Date(AT),
    writePrint: () => undefined,
    hooks: input.hooks ?? {},
    captureLifecycle: (value) => {
      lifecycle = value;
    },
  })(harness.api);
  if (!lifecycle) throw new Error('Expected the lifecycle capture.');
  return lifecycle;
}

function timerHooks(harness: FakePiHarness, refreshes: number[]): RuntimeLifecycleHooks {
  return {
    refreshLocked(runtime) {
      refreshes.push(runtime.generation);
      runtime.context.ui.setWidget('pi-signal-board', [`generation:${runtime.generation}`]);
      runtime.context.ui.setStatus('pi-signal-board', `generation:${runtime.generation}`);
    },
    armTimerLocked(_runtime, callback) {
      return harness.timers.setTimeout(callback, 100);
    },
    clearTimer(handle) {
      harness.timers.clearTimeout(handle as FakeTimerHandle);
    },
  };
}

function titles(runtime: SignalBoardRuntime | undefined): string[] {
  return runtime === undefined ? [] : [...runtime.state.updates.values()].map((item) => item.title);
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runtime lifecycle', () => {
  it('registers static surfaces once and repeated starts dispose one old generation', async () => {
    const harness = new FakePiHarness();
    const refreshes: number[] = [];
    const lifecycle = register(harness, { hooks: timerHooks(harness, refreshes) });

    await harness.dispatch('session_start');
    const first = lifecycle.slot.current();
    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });

    expect(first).toMatchObject({ disposed: true, disposeCount: 1 });
    expect(lifecycle.slot.current()).toMatchObject({ generation: 2, disposed: false });
    expect(harness.timers.pending()).toHaveLength(1);
    expect(refreshes).toEqual([1, 2]);
    expect(harness.registrationCount('tools')).toBe(3);
    expect(harness.registrationCount('commands')).toBe(1);
    expect(harness.registrationCount('shortcuts')).toBe(1);
    expect(harness.registrationCount('entryRenderers')).toBe(0);
    expect(harness.registrationCount('messageRenderers')).toBe(1);
    expect(harness.handlerCount('session_start')).toBe(2);
    expect(harness.handlerCount('session_tree')).toBe(1);
    expect(harness.handlerCount('session_shutdown')).toBe(2);
    expect(harness.handlerCount('tool_result')).toBe(1);
  });

  it('runs injected locked startup hooks in expiry, recovery, refresh, timer order', async () => {
    const harness = new FakePiHarness();
    const order: string[] = [];
    register(harness, {
      hooks: {
        evaluateExpiryLocked() {
          order.push('expiry');
        },
        recoverDeliveryLocked() {
          order.push('recovery');
        },
        refreshLocked() {
          order.push('refresh');
        },
        armTimerLocked() {
          order.push('timer');
          return undefined;
        },
      },
    });

    await harness.dispatch('session_start');
    expect(order).toEqual(['expiry', 'recovery', 'refresh', 'timer']);
  });

  it('keeps malformed-between-valid replay healthy, usable, and warned once', async () => {
    const harness = new FakePiHarness();
    const first = entry(
      'valid001',
      null,
      event(1, 'Before malformed', 'upd_10000000-0000-4000-8000-000000000001'),
    );
    const malformed = makeCustomEntry({
      id: 'bad00001',
      parentId: first.id,
      data: { schemaVersion: 1, privateText: 'PRIVATE malformed content' },
    });
    const later = entry(
      'valid002',
      malformed.id,
      event(2, 'After malformed', 'upd_10000000-0000-4000-8000-000000000002', 'U-2'),
    );
    harness.replaceBranch([first, malformed, later]);
    const lifecycle = register(harness);

    await harness.dispatch('session_start');

    expect(lifecycle.slot.current()?.status).toBe('healthy');
    expect(titles(lifecycle.slot.current())).toEqual(['Before malformed', 'After malformed']);
    expect(await lifecycle.runHealthy((runtime) => runtime.state.updates.size)).toEqual({
      ok: true,
      value: 2,
    });
    expect(harness.uiCalls.filter((call) => call.surface === 'notify')).toHaveLength(1);
    const doctor = lifecycle.doctorSnapshot(harness.context());
    expect(doctor.status).toBe('healthy');
    expect(doctor.diagnostics.replay).toEqual({ accepted: 2, skipped: 1 });
    expect(JSON.stringify(doctor)).not.toContain('PRIVATE');
  });

  it('keeps rejected config defaults healthy, usable, and warned once', async () => {
    const harness = new FakePiHarness();
    const lifecycle = register(harness, {
      loadConfig: async () => ({
        config: DEFAULT_CONFIG,
        sources: { global: 'rejected', project: 'absent' },
        warnings: [{ source: 'global', reason: 'invalid_schema' }],
      }),
    });

    await harness.dispatch('session_start');

    expect(lifecycle.slot.current()?.status).toBe('healthy');
    expect(lifecycle.slot.current()?.config.config).toBe(DEFAULT_CONFIG);
    expect(await lifecycle.runHealthy(() => 'usable')).toEqual({ ok: true, value: 'usable' });
    expect(harness.uiCalls.filter((call) => call.surface === 'notify')).toHaveLength(1);
    const doctor = lifecycle.doctorSnapshot(harness.context());
    expect(doctor.status).toBe('healthy');
    expect(doctor.diagnostics.counts.SB_CONFIG_INVALID).toBe(1);
  });

  it('runs turn and settled locked hooks in required order', async () => {
    const harness = new FakePiHarness();
    const order: string[] = [];
    register(harness, {
      hooks: {
        resetTurnRateCountersLocked() {
          order.push('rate-reset');
        },
        evaluateExpiryLocked() {
          order.push('expiry');
        },
        escalateConditionalQuestionsLocked() {
          order.push('escalation');
        },
        refreshLocked() {
          order.push('refresh');
        },
      },
    });
    await harness.dispatch('session_start');
    order.length = 0;

    await harness.dispatch('turn_start');
    await harness.dispatch('agent_settled');

    expect(order).toEqual(['rate-reset', 'expiry', 'escalation', 'refresh']);
  });

  it('serializes turn hooks with public operations on the shared queue', async () => {
    const harness = new FakePiHarness();
    const barrier = createDeferred<void>('rate-reset');
    const order: string[] = [];
    const lifecycle = register(harness, {
      hooks: {
        async resetTurnRateCountersLocked() {
          order.push('reset:start');
          await barrier.promise;
          order.push('reset:end');
        },
      },
    });
    await harness.dispatch('session_start');

    const turn = harness.dispatch('turn_start');
    const live = lifecycle.runHealthy(() => {
      order.push('live');
    });
    await microtasks();
    expect(order).toEqual(['reset:start']);
    barrier.resolve();
    await Promise.all([turn, live]);
    expect(order).toEqual(['reset:start', 'reset:end', 'live']);
  });

  it('serializes settled hooks with public operations on the shared queue', async () => {
    const harness = new FakePiHarness();
    const barrier = createDeferred<void>('settled-expiry');
    const order: string[] = [];
    let expiryCalls = 0;
    const lifecycle = register(harness, {
      hooks: {
        async evaluateExpiryLocked() {
          expiryCalls += 1;
          if (expiryCalls === 1) return;
          order.push('expiry:start');
          await barrier.promise;
          order.push('expiry:end');
        },
        escalateConditionalQuestionsLocked() {
          order.push('escalation');
        },
        refreshLocked() {
          order.push('refresh');
        },
      },
    });
    await harness.dispatch('session_start');
    order.length = 0;

    const settled = harness.dispatch('agent_settled');
    const live = lifecycle.runHealthy(() => {
      order.push('live');
    });
    await microtasks();
    expect(order).toEqual(['expiry:start']);
    barrier.resolve();
    await Promise.all([settled, live]);
    expect(order).toEqual(['expiry:start', 'expiry:end', 'escalation', 'refresh', 'live']);
  });

  it('makes turn and settled hooks no-ops for disabled and degraded runtimes', async () => {
    let calls = 0;
    const hooks: RuntimeLifecycleHooks = {
      resetTurnRateCountersLocked() {
        calls += 1;
      },
      evaluateExpiryLocked() {
        calls += 1;
      },
      escalateConditionalQuestionsLocked() {
        calls += 1;
      },
      refreshLocked() {
        calls += 1;
      },
    };
    const disabledHarness = new FakePiHarness();
    register(disabledHarness, { hooks, loadConfig: async () => config(false) });
    await disabledHarness.dispatch('session_start');
    await disabledHarness.dispatch('turn_start');
    await disabledHarness.dispatch('agent_settled');

    const degradedHarness = new FakePiHarness();
    register(degradedHarness, {
      hooks,
      replay() {
        throw new Error('degraded replay');
      },
    });
    await degradedHarness.dispatch('session_start');
    await degradedHarness.dispatch('turn_start');
    await degradedHarness.dispatch('agent_settled');
    expect(calls).toBe(0);
  });

  it('contains turn and settled hook throws with content-free evidence and final refresh', async () => {
    const harness = new FakePiHarness();
    const order: string[] = [];
    let expiryCalls = 0;
    const lifecycle = register(harness, {
      hooks: {
        resetTurnRateCountersLocked() {
          throw new Error('PRIVATE reset stack');
        },
        evaluateExpiryLocked() {
          expiryCalls += 1;
          if (expiryCalls === 1) return;
          order.push('expiry');
          throw new Error('PRIVATE settled stack');
        },
        escalateConditionalQuestionsLocked() {
          order.push('escalation');
        },
        refreshLocked() {
          order.push('refresh');
        },
      },
    });
    await harness.dispatch('session_start');
    order.length = 0;

    await expect(harness.dispatch('turn_start')).resolves.toBeDefined();
    await expect(harness.dispatch('agent_settled')).resolves.toBeDefined();

    expect(order).toEqual(['expiry', 'refresh']);
    expect(lifecycle.slot.current()?.status).toBe('healthy');
    const doctor = lifecycle.doctorSnapshot(harness.context());
    expect(doctor.diagnostics.counts.SB_INTERNAL).toBe(2);
    expect(JSON.stringify(doctor)).not.toContain('PRIVATE');
  });

  it('replays complete alternate branches and atomically replaces all prior state', async () => {
    const harness = new FakePiHarness();
    const root = makeCustomEntry({ id: 'root0001', customType: 'other', data: {} });
    const left = entry(
      'left0001',
      root.id,
      event(1, 'Left only', 'upd_10000000-0000-4000-8000-000000000001'),
    );
    const right = entry(
      'right001',
      root.id,
      event(2, 'Right only', 'upd_10000000-0000-4000-8000-000000000002'),
    );
    harness.replaceTree([root, left, right], left.id);
    const lifecycle = register(harness);
    await harness.dispatch('session_start');
    expect(titles(lifecycle.slot.current())).toEqual(['Left only']);

    harness.selectLeaf(right.id);
    await harness.dispatch('session_tree');
    expect(titles(lifecycle.slot.current())).toEqual(['Right only']);
    expect(harness.entriesReads).toBe(0);
  });

  it('contains session-tree timer arm failure and preserves replayed usable state', async () => {
    const harness = new FakePiHarness();
    const root = makeCustomEntry({ id: 'root0001', customType: 'other', data: {} });
    const left = entry(
      'left0001',
      root.id,
      event(1, 'Left only', 'upd_10000000-0000-4000-8000-000000000001'),
    );
    const right = entry(
      'right001',
      root.id,
      event(2, 'Right only', 'upd_10000000-0000-4000-8000-000000000002'),
    );
    harness.replaceTree([root, left, right], left.id);
    let armCount = 0;
    const lifecycle = register(harness, {
      hooks: {
        armTimerLocked() {
          armCount += 1;
          if (armCount === 2) throw new Error('PRIVATE tree timer stack');
          return { id: armCount };
        },
        clearTimer() {},
      },
    });
    await harness.dispatch('session_start');
    harness.selectLeaf(right.id);

    await expect(harness.dispatch('session_tree')).resolves.toBeDefined();

    expect(titles(lifecycle.slot.current())).toEqual(['Right only']);
    expect(lifecycle.slot.current()?.status).toBe('healthy');
    expect(lifecycle.slot.current()?.timer).toBeUndefined();
    expect(lifecycle.doctorSnapshot(harness.context()).diagnostics.counts.SB_INTERNAL).toBe(1);
  });

  it('serializes a live operation against branch replay through the shared queue', async () => {
    const harness = new FakePiHarness();
    const root = entry(
      'root0001',
      null,
      event(1, 'Branch', 'upd_10000000-0000-4000-8000-000000000001'),
    );
    harness.replaceBranch([root]);
    const lifecycle = register(harness);
    await harness.dispatch('session_start');
    const barrier = createDeferred<void>('live-operation');
    const live = lifecycle.runHealthy(async () => {
      await barrier.promise;
      return 'done';
    });
    const readsBeforeTree = harness.branchReads;
    const tree = harness.dispatch('session_tree');

    await microtasks();
    expect(harness.branchReads).toBe(readsBeforeTree);
    barrier.resolve();
    await expect(live).resolves.toEqual({ ok: true, value: 'done' });
    await tree;
    expect(harness.branchReads).toBe(readsBeforeTree + 1);
  });

  it('contains replay failure and leaves doctor-available degraded empty state', async () => {
    const harness = new FakePiHarness();
    const lifecycle = register(harness, {
      replay() {
        throw new Error('PRIVATE replay content and stack');
      },
    });

    await expect(harness.dispatch('session_start')).resolves.toBeDefined();
    expect(lifecycle.slot.current()).toMatchObject({ status: 'degraded' });
    expect(titles(lifecycle.slot.current())).toEqual([]);
    const doctor = lifecycle.doctorSnapshot(harness.context());
    expect(doctor.status).toBe('degraded');
    expect(JSON.stringify(doctor)).not.toContain('PRIVATE');
    await expect(lifecycle.runHealthy(() => undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SB_INTERNAL' },
    });
  });

  it('contains config adapter failure with content-free degraded evidence', async () => {
    const harness = new FakePiHarness();
    const lifecycle = register(harness, {
      loadConfig: async () => {
        throw new Error('PRIVATE config document and path');
      },
    });

    await expect(harness.dispatch('session_start')).resolves.toBeDefined();
    expect(lifecycle.slot.current()?.status).toBe('degraded');
    const doctor = lifecycle.doctorSnapshot(harness.context());
    expect(doctor.diagnostics.counts.SB_INTERNAL).toBe(1);
    expect(JSON.stringify(doctor)).not.toContain('PRIVATE');
  });

  it('returns stable disabled, unsupported, and uninitialized access errors', async () => {
    const disabledHarness = new FakePiHarness();
    const disabled = register(disabledHarness, { loadConfig: async () => config(false) });
    expect(await disabled.runHealthy(() => undefined)).toMatchObject({
      ok: false,
      error: { code: 'SB_NOT_INITIALIZED' },
    });
    await disabledHarness.dispatch('session_start');
    expect(await disabled.runHealthy(() => undefined)).toMatchObject({
      ok: false,
      error: { code: 'SB_DISABLED' },
    });

    const unsupportedHarness = new FakePiHarness();
    let unsupported: RuntimeLifecycle | undefined;
    createSignalBoardExtension({
      evaluateCompatibility: () =>
        evaluateHostCompatibility({ nodeVersion: '22.18.0', piVersion: '0.85.0' }),
      loadConfig: async () => config(),
      replay: replayBranch,
      now: () => new Date(AT),
      writePrint: () => undefined,
      hooks: {},
      captureLifecycle: (value) => {
        unsupported = value;
      },
    })(unsupportedHarness.api);
    await unsupportedHarness.dispatch('session_start');
    expect(await unsupported?.runHealthy(() => undefined)).toMatchObject({
      ok: false,
      error: { code: 'SB_UNSUPPORTED_HOST' },
    });
  });

  it('checks project trust before the fixed project config read boundary', async () => {
    const harness = new FakePiHarness({ trusted: false });
    const reads: string[] = [];
    register(harness, {
      loadConfig: async (context) =>
        loadConfiguration(context, {
          async readUtf8Capped(path) {
            reads.push(path);
            if (path.startsWith(harness.cwd)) throw new Error('forbidden project read');
            return { kind: 'absent' };
          },
        }),
    });

    await harness.dispatch('session_start');
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toContain(harness.cwd);
  });

  it.each([
    [true, 'persistent'],
    [false, 'ephemeral'],
  ] as const)(
    'creates a bounded %s identity without retaining a session path',
    async (persistent, kind) => {
      const harness = new FakePiHarness({ persistent });
      const lifecycle = register(harness);
      await harness.dispatch('session_start');
      const identity = lifecycle.slot.current()?.identity;
      expect(identity).toMatchObject({ persistence: kind });
      expect(identity?.token).toMatch(/^[a-f0-9]{12}$/u);
      expect(JSON.stringify(identity)).not.toContain('/sessions/');
    },
  );

  it('clears before replacement and contains independent surface cleanup failures', async () => {
    const harness = new FakePiHarness();
    const order: string[] = [];
    const hooks: RuntimeLifecycleHooks = {
      refreshLocked(runtime) {
        order.push(`refresh:${runtime.generation}`);
      },
      armTimerLocked(runtime) {
        order.push(`arm:${runtime.generation}`);
        return { generation: runtime.generation };
      },
      clearTimer(handle) {
        order.push(`clear:${String((handle as { generation: number }).generation)}`);
      },
    };
    register(harness, { hooks });
    await harness.dispatch('session_start');
    harness.failNextUi('setWidget');
    harness.failNextUi('setStatus');
    await expect(
      harness.dispatch('session_start', { type: 'session_start', reason: 'reload' }),
    ).resolves.toBeDefined();
    expect(order).toEqual(['refresh:1', 'arm:1', 'clear:1', 'refresh:2', 'arm:2']);
  });

  it('shutdown is terminal, clears timer and surfaces, and removes only its generation', async () => {
    const harness = new FakePiHarness();
    const lifecycle = register(harness, { hooks: timerHooks(harness, []) });
    await harness.dispatch('session_start');
    const runtime = lifecycle.slot.current();
    await harness.dispatch('session_shutdown', { type: 'session_shutdown', reason: 'reload' });

    expect(runtime).toMatchObject({ disposed: true, disposeCount: 1, timer: undefined });
    expect(lifecycle.slot.current()).toBeUndefined();
    expect(harness.timers.pending()).toHaveLength(0);
    expect(harness.uiCalls.slice(-2).map((call) => call.surface)).toEqual([
      'setWidget',
      'setStatus',
    ]);
    expect(await lifecycle.runHealthy(() => undefined)).toMatchObject({
      ok: false,
      error: { code: 'SB_NOT_INITIALIZED' },
    });
  });

  it('makes stale timer callbacks no-ops after runtime replacement', async () => {
    const harness = new FakePiHarness();
    const callbacks: Array<() => Promise<void>> = [];
    let timerRuns = 0;
    const lifecycle = register(harness, {
      hooks: {
        armTimerLocked(_runtime, callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimer() {},
        onTimerLocked() {
          timerRuns += 1;
        },
      },
    });
    await harness.dispatch('session_start');
    const stale = callbacks[0];
    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    await stale?.();
    expect(timerRuns).toBe(0);
    expect(lifecycle.slot.current()?.generation).toBe(2);
  });

  it('uses getBranch only and leaks no timer or UI state across repeated tree and start cycles', async () => {
    const harness = new FakePiHarness();
    harness.forbidGetEntries();
    const lifecycle = register(harness, { hooks: timerHooks(harness, []) });
    await harness.dispatch('session_start');
    await harness.dispatch('session_tree');
    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });

    expect(harness.entriesReads).toBe(0);
    expect(harness.branchReads).toBe(3);
    expect(harness.timers.pending()).toHaveLength(1);
    expect(lifecycle.slot.current()).toMatchObject({ generation: 2, disposed: false });
    expect(harness.uiCalls.filter((call) => call.surface === 'setWidget').at(-1)?.args[1]).toEqual([
      'generation:2',
    ]);
  });
});
