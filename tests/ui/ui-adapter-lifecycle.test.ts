import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { UPDATE_TOOL_NAME } from '../../src/constants.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import type { SignalBoardRuntime } from '../../src/runtime/types.js';
import type { UpdateToolInput } from '../../src/tools/update-tool.js';
import type { SignalBoardUiAdapter } from '../../src/ui/adapter.js';
import { FakePiHarness } from '../helpers/fake-pi.js';

const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });

interface RegisteredUpdateTool {
  readonly name: string;
  execute(id: string, input: UpdateToolInput): Promise<unknown>;
}

function setup(harness = new FakePiHarness(), injectedRefresh?: () => void) {
  let lifecycle: RuntimeLifecycle | undefined;
  const hookOrder: string[] = [];
  createSignalBoardExtension({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: async () => ({
      config: DEFAULT_CONFIG,
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    now: () => new Date('2026-08-12T10:20:00.000Z'),
    effectiveCommand: () => '/signalboard:2',
    writePrint: () => undefined,
    hooks: {
      refreshLocked() {
        hookOrder.push('injected-refresh');
        injectedRefresh?.();
      },
    },
    captureLifecycle(value) {
      lifecycle = value;
    },
  })(harness.api);
  const tool = (harness.registrations.tools as RegisteredUpdateTool[]).find(
    (candidate) => candidate.name === UPDATE_TOOL_NAME,
  );
  if (!tool || !lifecycle) throw new Error('Expected registered runtime and update tool.');
  return { harness, lifecycle, tool, hookOrder };
}

function surfaceCalls(harness: FakePiHarness, surface: string) {
  return harness.uiCalls.filter((call) => call.surface === surface);
}

function installedLines(harness: FakePiHarness, width = 80): string[] {
  const content = surfaceCalls(harness, 'setWidget').at(-1)?.args[1];
  return typeof content === 'function' ? (content as () => Component)().render(width) : [];
}

function refreshRetainedAdapter(
  adapter: SignalBoardUiAdapter,
  state: SignalBoardRuntime['state'],
): void {
  adapter.refresh({
    state,
    config: DEFAULT_CONFIG,
    currentTime: '2026-08-12T10:20:00.000Z',
    completedWindowCutoff: '2026-08-12T10:10:00.000Z',
    effectiveCommand: '/signalboard:2',
  });
}

describe('runtime-owned UI adapter wiring', () => {
  it('refreshes on start, accepted mutation, and tree replay without recursive queue entry', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const adapter = test.lifecycle.slot.current()?.ui;
    expect(adapter).toBeDefined();
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[1]).toBeUndefined();
    expect(test.hookOrder).toEqual(['injected-refresh']);

    await test.tool.execute('ui-refresh', {
      operation: 'upsert',
      key: 'ranked',
      kind: 'blocked',
      title: 'Synthetic ranked update',
    });
    expect(test.lifecycle.slot.current()?.ui).toBe(adapter);
    expect(installedLines(test.harness).join('\n')).toContain('[BLOCKED] U-1');
    expect(installedLines(test.harness).at(-1)).toBe('Open /signalboard:2');
    expect(surfaceCalls(test.harness, 'setStatus').at(-1)?.args[1]).toBe('Signal: 0Q 1U 1 new');
    expect(test.hookOrder).toEqual(['injected-refresh', 'injected-refresh']);

    test.harness.replaceBranch([]);
    await test.harness.dispatch('session_tree');
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[1]).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setStatus').at(-1)?.args[1]).toBeUndefined();
    expect(test.hookOrder).toEqual(['injected-refresh', 'injected-refresh', 'injected-refresh']);
  });

  it('clears a transient refresh failure and renders again with the same adapter', async () => {
    let failRefresh = false;
    const test = setup(new FakePiHarness(), () => {
      if (failRefresh) throw new Error('PRIVATE transient refresh detail');
    });
    await test.harness.dispatch('session_start');
    await test.tool.execute('before-failure', {
      operation: 'upsert',
      key: 'recoverable',
      kind: 'working',
      title: 'Recoverable fixture',
    });
    const adapter = test.lifecycle.slot.current()?.ui;
    expect(adapter).toBeDefined();
    expect(installedLines(test.harness).join('\n')).toContain('[WORKING] U-1');

    const widgetCallsBeforeFailure = surfaceCalls(test.harness, 'setWidget').length;
    const statusCallsBeforeFailure = surfaceCalls(test.harness, 'setStatus').length;
    failRefresh = true;
    await test.harness.dispatch('session_tree');
    expect(test.lifecycle.slot.current()?.ui).toBe(adapter);
    expect(surfaceCalls(test.harness, 'setWidget')).toHaveLength(widgetCallsBeforeFailure + 1);
    expect(surfaceCalls(test.harness, 'setStatus')).toHaveLength(statusCallsBeforeFailure + 1);
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[1]).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setStatus').at(-1)?.args[1]).toBeUndefined();

    failRefresh = false;
    await test.harness.dispatch('agent_settled');
    expect(test.lifecycle.slot.current()?.ui).toBe(adapter);
    expect(installedLines(test.harness).join('\n')).toContain('[WORKING] U-1');
    expect(surfaceCalls(test.harness, 'setStatus').at(-1)?.args[1]).toBe('Signal: 0Q 1U 1 new');
    const diagnostics = test.lifecycle.slot.current()?.diagnostics.snapshot();
    expect(diagnostics?.counts.SB_UI_UNAVAILABLE).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
  });

  it('clears replacement and shutdown surfaces and installs only one adapter per runtime', async () => {
    const test = setup();
    await test.harness.dispatch('session_start');
    const firstRuntime = test.lifecycle.slot.current();
    await test.tool.execute('before-reload', {
      operation: 'upsert',
      key: 'reload',
      kind: 'working',
      title: 'Reload fixture',
    });

    const widgetCallsBeforeReload = surfaceCalls(test.harness, 'setWidget').length;
    const statusCallsBeforeReload = surfaceCalls(test.harness, 'setStatus').length;
    const firstAdapter = firstRuntime?.ui;
    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const secondRuntime = test.lifecycle.slot.current();
    expect(firstRuntime).toMatchObject({ disposed: true, disposeCount: 1 });
    expect(secondRuntime?.ui).toBeDefined();
    expect(secondRuntime?.ui).not.toBe(firstRuntime?.ui);
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[0]).toBe('pi-signal-board');
    expect(installedLines(test.harness).join('\n')).toContain('[WORKING] U-1');
    expect(surfaceCalls(test.harness, 'setWidget')).toHaveLength(widgetCallsBeforeReload + 2);
    expect(surfaceCalls(test.harness, 'setStatus')).toHaveLength(statusCallsBeforeReload + 2);

    if (!firstAdapter || !firstRuntime) throw new Error('Expected the retained first adapter.');
    const callsAfterReplacement = test.harness.uiCalls.length;
    refreshRetainedAdapter(firstAdapter, firstRuntime.state);
    expect(test.harness.uiCalls).toHaveLength(callsAfterReplacement);

    const secondAdapter = secondRuntime?.ui;
    const widgetCallsBeforeShutdown = surfaceCalls(test.harness, 'setWidget').length;
    const statusCallsBeforeShutdown = surfaceCalls(test.harness, 'setStatus').length;
    await test.harness.dispatch('session_shutdown', {
      type: 'session_shutdown',
      reason: 'quit',
    });
    expect(test.lifecycle.slot.current()).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[1]).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setStatus').at(-1)?.args[1]).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setWidget')).toHaveLength(widgetCallsBeforeShutdown + 1);
    expect(surfaceCalls(test.harness, 'setStatus')).toHaveLength(statusCallsBeforeShutdown + 1);

    if (!secondAdapter || !secondRuntime) throw new Error('Expected the retained second adapter.');
    const callsAfterShutdown = test.harness.uiCalls.length;
    refreshRetainedAdapter(secondAdapter, secondRuntime.state);
    expect(test.harness.uiCalls).toHaveLength(callsAfterShutdown);
  });

  it('uses safe no-op surfaces in noninteractive modes and records no board content', async () => {
    for (const mode of ['rpc', 'json', 'print'] as const) {
      const harness = new FakePiHarness({ mode });
      const test = setup(harness);
      await harness.dispatch('session_start');
      await expect(
        test.tool.execute(`mode-${mode}`, {
          operation: 'upsert',
          key: mode,
          kind: 'working',
          title: 'PRIVATE title from board',
        }),
      ).resolves.toBeDefined();
      if (mode === 'rpc') {
        expect(surfaceCalls(harness, 'setStatus').at(-1)?.args[1]).toBe('Signal: 0Q 1U 1 new');
      } else {
        expect(harness.uiCalls).toEqual([]);
      }
      const diagnostics = test.lifecycle.slot.current()?.diagnostics.snapshot();
      expect(diagnostics?.counts.SB_UI_UNAVAILABLE).toBeUndefined();
      expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE');
    }
  });
});
