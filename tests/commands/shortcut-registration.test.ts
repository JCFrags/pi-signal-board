import type {
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { registerSignalBoardShortcut } from '../../src/commands/shortcut-registration.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { SHORTCUT, SHORTCUT_DESCRIPTION } from '../../src/constants.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import { FakePiHarness } from '../helpers/index.js';

const NOW = '2030-01-02T03:04:05.000Z';
const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });

function register(harness: FakePiHarness, supported = true): void {
  createSignalBoardExtension({
    evaluateCompatibility: () =>
      supported
        ? SUPPORTED
        : evaluateHostCompatibility({ nodeVersion: '22.18.0', piVersion: '0.85.0' }),
    loadConfig: async () => ({
      config: DEFAULT_CONFIG,
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    now: () => new Date(NOW),
    writePrint: () => undefined,
    expiryTimers: harness.timers,
  })(harness.api);
}

function shortcut(harness: FakePiHarness): {
  description: string;
  handler(context: ExtensionContext): Promise<void>;
} {
  const registration = harness.registrations.shortcuts[0];
  if (registration === undefined) throw new Error('Missing shortcut registration.');
  return registration.options as {
    description: string;
    handler(context: ExtensionContext): Promise<void>;
  };
}

function command(harness: FakePiHarness): {
  handler(args: string, context: ExtensionCommandContext): Promise<void>;
} {
  const registration = harness.registrations.commands[0];
  if (registration === undefined) throw new Error('Missing command registration.');
  return registration.options as {
    handler(args: string, context: ExtensionCommandContext): Promise<void>;
  };
}

function noColorTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function capturingContext(harness: FakePiHarness, captures: string[]): ExtensionContext {
  const base = harness.context();
  return {
    ...base,
    ui: {
      ...base.ui,
      custom: async <T>(
        factory: (
          tui: { requestRender(): void },
          theme: Theme,
          keybindings: never,
          done: (value: T) => void,
        ) => Component,
        options?: unknown,
      ): Promise<T | undefined> => {
        expect(options).toBeUndefined();
        let result: T | undefined;
        const component = factory(
          { requestRender: () => undefined },
          noColorTheme(),
          undefined as never,
          (value) => {
            result = value;
          },
        );
        captures.push(component.render(80).join('\n'));
        component.handleInput?.('\u001b');
        return result;
      },
    },
  } as unknown as ExtensionContext;
}

function lastNotice(harness: FakePiHarness): string {
  const call = [...harness.uiCalls].reverse().find((entry) => entry.surface === 'notify');
  return call === undefined ? '' : String(call.args[0]);
}

describe('SB-029 shortcut registration boundary', () => {
  it('registers the exact key and description once and opens through the command path', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const registration = shortcut(harness);
    const shortcutCaptures: string[] = [];
    const commandCaptures: string[] = [];

    await registration.handler(capturingContext(harness, shortcutCaptures));
    await command(harness).handler(
      '',
      capturingContext(harness, commandCaptures) as ExtensionCommandContext,
    );

    expect(harness.registrations.shortcuts).toHaveLength(1);
    expect(harness.registrations.shortcuts[0]?.shortcut).toBe(SHORTCUT);
    expect(registration.description).toBe(SHORTCUT_DESCRIPTION);
    expect(shortcutCaptures).toEqual(commandCaptures);
    expect(shortcutCaptures[0]).toContain('[Inbox 0]');
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('uses the same safe summary fallback without custom TUI support', async () => {
    for (const mode of ['rpc', 'json', 'print'] as const) {
      const harness = new FakePiHarness({ mode });
      register(harness);
      await harness.dispatch('session_start');
      harness.uiCalls.length = 0;
      await shortcut(harness).handler(harness.context());
      expect(lastNotice(harness)).toContain('Signals: 0 actionable questions');
      expect(harness.uiCalls.some((call) => call.surface === 'custom')).toBe(false);
      expect(harness.appendCalls).toHaveLength(0);
    }
  });

  it('falls back to summary when a TUI host has no custom UI method', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const base = harness.context();
    const context = {
      ...base,
      ui: { ...base.ui, custom: undefined },
    } as unknown as ExtensionContext;
    await shortcut(harness).handler(context);
    expect(lastNotice(harness)).toContain('Signals: 0 actionable questions');
    expect(harness.appendCalls).toHaveLength(0);
  });

  it('contains unavailable runtime and component failures without mutation or private text', async () => {
    const unavailable = new FakePiHarness();
    register(unavailable, false);
    await unavailable.dispatch('session_start');
    await shortcut(unavailable).handler(unavailable.context());
    expect(lastNotice(unavailable)).toContain('SB_UNSUPPORTED_HOST');

    const failed = new FakePiHarness();
    register(failed);
    await failed.dispatch('session_start');
    const base = failed.context();
    const context = {
      ...base,
      ui: {
        ...base.ui,
        custom: async () => {
          throw new Error('SYNTHETIC_PRIVATE_SHORTCUT_COMPONENT');
        },
      },
    } as ExtensionContext;
    await expect(shortcut(failed).handler(context)).resolves.toBeUndefined();
    expect(lastNotice(failed)).toBe(
      'Signals interactive UI failed (SB_UI_UNAVAILABLE). No state changed.',
    );
    expect(lastNotice(failed)).not.toContain('SYNTHETIC_PRIVATE_SHORTCUT_COMPONENT');
    expect(failed.appendCalls).toHaveLength(0);
    expect(failed.sendCalls).toHaveLength(0);
  });

  it('contains an unexpected shared-handler failure at the shortcut boundary', async () => {
    const harness = new FakePiHarness();
    const failures: string[] = [];
    registerSignalBoardShortcut(harness.api, {
      openBoard: async () => {
        throw new Error('SYNTHETIC_PRIVATE_HANDLER_FAILURE');
      },
      onFailure: () => failures.push('SB_INTERNAL'),
    });
    await expect(shortcut(harness).handler(harness.context())).resolves.toBeUndefined();
    expect(failures).toEqual(['SB_INTERNAL']);
    expect(JSON.stringify(failures)).not.toContain('SYNTHETIC_PRIVATE_HANDLER_FAILURE');
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('contains registration conflict, retains the command, and reports one content-free warning', async () => {
    const harness = new FakePiHarness();
    harness.failNextShortcutRegistration(new Error('SYNTHETIC_PRIVATE_BINDING_OWNER'));
    register(harness);
    expect(harness.registrations.shortcuts).toHaveLength(0);
    expect(harness.registrations.commands).toHaveLength(2);

    await harness.dispatch('session_start');
    await harness.dispatch('session_tree');
    await command(harness).handler('doctor', harness.context() as ExtensionCommandContext);
    const doctor = lastNotice(harness);
    expect(doctor).toContain('Shortcut: Ctrl+Shift+B (unavailable)');
    expect(doctor).toContain('SB_UI_UNAVAILABLE=1');
    expect(doctor).not.toContain('SYNTHETIC_PRIVATE_BINDING_OWNER');

    await command(harness).handler('', harness.context() as ExtensionCommandContext);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('does not duplicate or retain live components across reload, tree replacement, and dispose', async () => {
    const harness = new FakePiHarness();
    register(harness);
    const registration = shortcut(harness);
    await harness.dispatch('session_start');
    for (let run = 0; run < 20; run += 1) {
      await registration.handler(capturingContext(harness, []));
    }
    await harness.dispatch('session_tree');
    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    expect(harness.registrations.shortcuts).toHaveLength(1);
    await harness.dispatch('session_shutdown');
    await registration.handler(harness.context());
    expect(lastNotice(harness)).toContain('SB_NOT_INITIALIZED');
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });
});
