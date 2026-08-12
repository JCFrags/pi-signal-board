import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { UPDATE_TOOL_NAME } from '../../src/constants.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import type { UpdateToolInput } from '../../src/tools/update-tool.js';
import { FakePiHarness } from '../helpers/fake-pi.js';

const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });

interface RegisteredUpdateTool {
  readonly name: string;
  execute(id: string, input: UpdateToolInput): Promise<unknown>;
}

function setup(harness = new FakePiHarness()) {
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

    await test.harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    const secondRuntime = test.lifecycle.slot.current();
    expect(firstRuntime).toMatchObject({ disposed: true, disposeCount: 1 });
    expect(secondRuntime?.ui).toBeDefined();
    expect(secondRuntime?.ui).not.toBe(firstRuntime?.ui);
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[0]).toBe('pi-signal-board');
    expect(installedLines(test.harness).join('\n')).toContain('[WORKING] U-1');

    await test.harness.dispatch('session_shutdown', {
      type: 'session_shutdown',
      reason: 'quit',
    });
    expect(test.lifecycle.slot.current()).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setWidget').at(-1)?.args[1]).toBeUndefined();
    expect(surfaceCalls(test.harness, 'setStatus').at(-1)?.args[1]).toBeUndefined();
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
