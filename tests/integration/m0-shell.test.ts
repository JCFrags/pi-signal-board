import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { type FixedConfigReader, loadConfiguration } from '../../src/config/loader.js';
import type { ConfigLoadResult } from '../../src/config/types.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import { FakePiHarness } from '../helpers/index.js';

const SUPPORTED = evaluateHostCompatibility({
  nodeVersion: '22.19.0',
  piVersion: '0.84.1',
});

function configResult(
  input: {
    enabled?: boolean;
    global?: 'absent' | 'applied' | 'rejected';
    project?: 'absent' | 'applied' | 'rejected' | 'not_read_untrusted';
    warning?: boolean;
  } = {},
): ConfigLoadResult {
  return {
    config: Object.freeze({ ...DEFAULT_CONFIG, enabled: input.enabled ?? true }),
    sources: {
      global: input.global ?? 'absent',
      project: input.project ?? 'absent',
    },
    warnings: input.warning ? [{ source: 'global', reason: 'invalid_schema' }] : [],
  };
}

function register(
  harness: FakePiHarness,
  options: Parameters<typeof createSignalBoardExtension>[0] = {},
): void {
  createSignalBoardExtension({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: async () => configResult(),
    now: () => new Date('2030-01-02T03:04:05.000Z'),
    writePrint: () => undefined,
    ...options,
  })(harness.api);
}

async function runCommand(harness: FakePiHarness, args: string): Promise<string> {
  const registration = harness.registrations.commands[0];
  if (!registration) throw new Error('Expected a command registration.');
  const options = registration.options as {
    handler(args: string, context: ExtensionCommandContext): Promise<void>;
  };
  await options.handler(args, harness.context() as ExtensionCommandContext);
  const call = harness.uiCalls.at(-1);
  expect(call?.surface).toBe('notify');
  return String(call?.args[0]);
}

describe('M0 registration and doctor shell', () => {
  it('starts a supported diagnostic shell with exact ranges and zero state counts', async () => {
    const harness = new FakePiHarness();
    register(harness);

    await harness.dispatch('session_start');
    const report = await runCommand(harness, 'doctor');

    expect(report).toContain('Status: healthy');
    expect(report).toContain('Supported Node range: >=22.19.0');
    expect(report).toContain('Supported Pi range: >=0.84.1 <0.85.0');
    expect(report).toContain('Effective config: enabled');
    expect(report).toContain('Session: persistent');
    expect(report).toContain(
      'Board counts: active=0; updates=0; questions=0; decisions=0; unread=0',
    );
    expect(report).toContain('Diagnostics: total=0; retained=0');
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('reports an injected unsupported host without mutating domain surfaces', async () => {
    const harness = new FakePiHarness();
    register(harness, {
      evaluateCompatibility: () =>
        evaluateHostCompatibility({ nodeVersion: '22.18.0', piVersion: '0.85.0' }),
    });

    await harness.dispatch('session_start');
    const report = await runCommand(harness, 'doctor');

    expect(report).toContain('Status: unsupported');
    expect(report).toContain('Node: 22.18.0 (unsupported)');
    expect(report).toContain('Pi host: 0.85.0 (unsupported)');
    expect(report).toContain('Diagnostic codes: SB_UNSUPPORTED_HOST=1');
    expect(harness.registrationCount('tools')).toBe(3);
    expect(harness.registrationCount('shortcuts')).toBe(1);
    expect(harness.registrationCount('messageRenderers')).toBe(1);
    expect(harness.registrationCount('entryRenderers')).toBe(0);
    expect(harness.appendCalls).toHaveLength(0);
  });

  it('keeps doctor available with rejected invalid configuration', async () => {
    const harness = new FakePiHarness();
    register(harness, {
      loadConfig: async () => configResult({ global: 'rejected', warning: true }),
    });

    await harness.dispatch('session_start');
    const report = await runCommand(harness, 'doctor');

    expect(report).toContain('Status: healthy');
    expect(report).toContain('global=rejected');
    expect(report).toContain('Config warnings: 1');
    expect(report).toContain('Config warning categories: global:invalid_schema');
    expect(report).toContain('Diagnostic codes: SB_CONFIG_INVALID=1');
  });

  it('checks trust before the loader can access a project config path', async () => {
    const harness = new FakePiHarness({ trusted: false });
    const calls: string[] = [];
    const reader: FixedConfigReader = {
      async readUtf8Capped(path) {
        calls.push(path);
        if (path.startsWith(harness.cwd)) {
          throw new Error('SYNTHETIC_PRIVATE_PROJECT_PATH');
        }
        return { kind: 'absent' };
      },
    };
    register(harness, {
      loadConfig: (context) => loadConfiguration(context, reader),
    });

    await harness.dispatch('session_start');
    const report = await runCommand(harness, 'doctor');

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(harness.cwd);
    expect(report).toContain('Project trust: untrusted');
    expect(report).toContain('project=not_read_untrusted');
    expect(report).not.toContain('SYNTHETIC_PRIVATE_PROJECT_PATH');
  });

  it.each([
    [true, 'persistent'],
    [false, 'ephemeral'],
  ] as const)('reports persistent=%s as %s', async (persistent, expected) => {
    const harness = new FakePiHarness({ persistent });
    register(harness);
    await harness.dispatch('session_start');
    expect(await runCommand(harness, 'doctor')).toContain(`Session: ${expected}`);
  });

  it.each(['print', 'json'] as const)('runs doctor in %s mode without custom UI', async (mode) => {
    const harness = new FakePiHarness({ mode });
    const printed: string[] = [];
    register(harness, { writePrint: (text) => printed.push(text) });
    await harness.dispatch('session_start');

    const report = await runCommand(harness, 'doctor');
    expect(report).toContain(`Mode: ${mode}`);
    expect(printed).toHaveLength(mode === 'print' ? 1 : 0);
    expect(printed[0] ?? report).toContain(`Mode: ${mode}`);
    expect(harness.uiCalls.some((call) => call.surface === 'custom')).toBe(false);
  });

  it('registers signalboard once and does not add registrations during repeated starts', async () => {
    const harness = new FakePiHarness();
    register(harness);

    await harness.dispatch('session_start');
    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });

    expect(harness.registrations.commands.map((entry) => entry.name)).toEqual([
      'agent-board',
      'agentboard',
      'signalboard',
    ]);
    expect(harness.registrationCount('tools')).toBe(3);
    expect(harness.registrationCount('shortcuts')).toBe(1);
    expect(harness.registrationCount('messageRenderers')).toBe(1);
    expect(harness.registrationCount('entryRenderers')).toBe(0);
    expect(harness.handlerCount('session_start')).toBe(3);
    expect(harness.handlerCount('session_shutdown')).toBe(3);
    expect(harness.handlerCount('tool_result')).toBe(1);
  });

  it('converts startup exceptions to stable content-free diagnostics', async () => {
    const harness = new FakePiHarness();
    register(harness, {
      evaluateCompatibility: () => {
        throw new Error('SYNTHETIC_SECRET_STACK_AND_PATH');
      },
    });

    await expect(harness.dispatch('session_start')).resolves.toBeDefined();
    const report = await runCommand(harness, 'doctor');

    expect(report).toContain('Status: degraded');
    expect(report).toContain('Diagnostic codes: SB_INTERNAL=1');
    expect(report).not.toContain('SYNTHETIC_SECRET_STACK_AND_PATH');
    expect(report).not.toContain('/home/');
  });

  it('reports disabled and uninitialized states without mutation', async () => {
    const disabled = new FakePiHarness();
    register(disabled, { loadConfig: async () => configResult({ enabled: false }) });
    await disabled.dispatch('session_start');
    expect(await runCommand(disabled, 'doctor')).toContain('Status: disabled');
    expect(disabled.appendCalls).toHaveLength(0);

    const uninitialized = new FakePiHarness();
    register(uninitialized);
    expect(await runCommand(uninitialized, 'doctor')).toContain('Status: uninitialized');
    expect(uninitialized.appendCalls).toHaveLength(0);
  });

  it('returns summary or stable usage for non-doctor arguments without mutation', async () => {
    const harness = new FakePiHarness({ mode: 'print' });
    register(harness);
    await harness.dispatch('session_start');

    for (const args of ['', 'summary']) {
      expect(await runCommand(harness, args)).toContain('Signal: 0 actionable questions');
    }
    for (const args of ['doctor extra', 'unknown']) {
      expect(await runCommand(harness, args)).toContain(
        'Usage: /agent-board [inbox|updates|decisions|history|summary|doctor]',
      );
    }
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });
});
