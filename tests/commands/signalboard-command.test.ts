import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ConfigLoadResult } from '../../src/config/types.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import type { BoardState, QuestionItem, UpdateItem } from '../../src/domain/types.js';
import {
  createSignalBoardExtension,
  formatPlainSummary,
  parseSignalBoardCommand,
  resolveEffectiveCommand,
} from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import { FakePiHarness } from '../helpers/index.js';

const NOW = '2030-01-02T03:04:05.000Z';
const SUPPORTED = evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' });

function configResult(): ConfigLoadResult {
  return {
    config: DEFAULT_CONFIG,
    sources: { global: 'absent', project: 'absent' },
    warnings: [],
  };
}

function register(harness: FakePiHarness, now: () => Date = () => new Date(NOW)): void {
  createSignalBoardExtension({
    evaluateCompatibility: () => SUPPORTED,
    loadConfig: async () => configResult(),
    now,
    writePrint: () => undefined,
    expiryTimers: harness.timers,
  })(harness.api);
}

function commandHandler(
  harness: FakePiHarness,
): (args: string, context: ExtensionCommandContext) => Promise<void> {
  const registration = harness.registrations.commands[0];
  if (registration === undefined) throw new Error('Missing Signal Board command.');
  return (
    registration.options as {
      handler(args: string, context: ExtensionCommandContext): Promise<void>;
    }
  ).handler;
}

function lastNotice(harness: FakePiHarness): string | undefined {
  const call = [...harness.uiCalls].reverse().find((entry) => entry.surface === 'notify');
  return call === undefined ? undefined : String(call.args[0]);
}

function interactiveContext(harness: FakePiHarness, capture: string[]): ExtensionCommandContext {
  const base = harness.context() as ExtensionCommandContext;
  const ui = {
    ...base.ui,
    custom: async <T>(
      factory: (
        tui: { requestRender(): void },
        theme: Theme,
        keybindings: never,
        done: (value: T) => void,
      ) => Component,
    ): Promise<T | undefined> => {
      let result: T | undefined;
      const component = factory(
        { requestRender: () => undefined },
        noColorTheme(),
        undefined as never,
        (value) => {
          result = value;
        },
      );
      capture.push(component.render(80).join('\n'));
      component.handleInput?.('\u001b');
      return result;
    },
  };
  return { ...base, ui } as unknown as ExtensionCommandContext;
}

function noColorTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

describe('SB-028 parser', () => {
  it.each([
    ['', { kind: 'open' }],
    [' \t\r\n ', { kind: 'open' }],
    ['inbox', { kind: 'open', tab: 'inbox' }],
    [' updates ', { kind: 'open', tab: 'updates' }],
    ['decisions', { kind: 'open', tab: 'decisions' }],
    ['history', { kind: 'open', tab: 'history' }],
    ['summary', { kind: 'summary' }],
    ['doctor', { kind: 'doctor' }],
    ['Inbox', { kind: 'usage' }],
    ['SUMMARY', { kind: 'usage' }],
    ['/signalboard', { kind: 'usage' }],
    ['inbox extra', { kind: 'usage' }],
    ['doctor\u00a0extra', { kind: 'usage' }],
    ['unknown', { kind: 'usage' }],
  ] as const)('parses %j without throwing', (raw, expected) => {
    expect(parseSignalBoardCommand(raw)).toEqual(expected);
  });

  it('never throws for fixed-seed hostile whitespace and token strings', () => {
    const seed = 0x5b028;
    let state = seed;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const alphabet = [' ', '\t', '\n', '\r', '\u00a0', '/', ':', 'A', 'z', '0', '\u001b'];
    try {
      for (let run = 0; run < 1_000; run += 1) {
        const raw = Array.from(
          { length: Math.floor(random() * 80) },
          () => alphabet[Math.floor(random() * alphabet.length)],
        ).join('');
        expect(() => parseSignalBoardCommand(raw)).not.toThrow();
      }
    } catch (error) {
      console.error(`signalboard-parser property seed=${seed} state=${state}`);
      throw error;
    }
  });
});

describe('SB-028 command boundary', () => {
  it.each([
    ['', 'Inbox'],
    ['inbox', 'Inbox'],
    ['updates', 'Updates'],
    ['decisions', 'Decisions'],
    ['history', 'History'],
  ] as const)('opens %j in non-overlay custom UI on the %s tab', async (args, tab) => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const captures: string[] = [];
    const beforeAppends = harness.appendCalls.length;

    await commandHandler(harness)(args, interactiveContext(harness, captures));

    expect(captures).toHaveLength(1);
    expect(captures[0]).toContain(`[${tab} 0]`);
    expect(harness.appendCalls).toHaveLength(beforeAppends);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('uses automatic initial-tab precedence for no arguments', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const captures: string[] = [];
    await commandHandler(harness)('', interactiveContext(harness, captures));
    expect(captures[0]).toContain('[Inbox 0]');
  });

  it('formats stable non-empty summary labels, singular counts, whitespace, and omission', () => {
    const empty = createEmptyBoardState();
    const question = {
      id: 'qst_summary',
      displayId: 'Q-1',
      status: 'delivery_failed',
      priority: 'normal',
      createdAt: NOW,
      updatedAt: NOW,
      question: 'Choose\n  one?',
    } as unknown as QuestionItem;
    const update = {
      id: 'upd_summary',
      displayId: 'U-1',
      kind: 'finding',
      archived: false,
      updatedAt: NOW,
      title: 'Found\t evidence',
    } as unknown as UpdateItem;
    const state = {
      ...empty,
      questions: new Map([[question.id, question]]),
      updates: new Map([[update.id, update]]),
    } as BoardState;
    expect(formatPlainSummary({ state }, NOW)).toBe(
      'Signal: 1 actionable question, 1 active update, 0 unread changes.\nQuestions:\n- [DELIVERY FAILED] Q-1 Choose one?\nUpdates:\n- [FOUND] U-1 Found evidence',
    );
  });

  it('returns exact stable plain summary without UI or persistence', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    harness.uiCalls.length = 0;

    await commandHandler(harness)('summary', harness.context() as ExtensionCommandContext);

    expect(lastNotice(harness)).toBe(
      'Signal: 0 actionable questions, 0 active updates, 0 unread changes.\nQuestions:\n- none\nUpdates:\n- none',
    );
    expect(harness.uiCalls.some((call) => call.surface === 'custom')).toBe(false);
    expect(harness.appendCalls).toHaveLength(0);
    expect(formatPlainSummary({ state: createEmptyBoardState() }, NOW)).toBe(lastNotice(harness));
  });

  it('routes doctor to accepted privacy-safe output', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    await commandHandler(harness)('doctor', harness.context() as ExtensionCommandContext);
    const output = lastNotice(harness) ?? '';
    expect(output).toContain('PI SIGNAL BOARD DOCTOR');
    expect(output).toContain('Command: /signalboard');
    expect(output).not.toContain('/home/');
    expect(output).not.toContain('session.jsonl');
  });

  it.each(['print', 'json', 'rpc'] as const)(
    'returns summary in %s mode and never opens custom UI',
    async (mode) => {
      const harness = new FakePiHarness({ mode });
      register(harness);
      await harness.dispatch('session_start');
      harness.uiCalls.length = 0;
      for (const args of ['', 'inbox', 'updates', 'decisions', 'history']) {
        await commandHandler(harness)(args, harness.context() as ExtensionCommandContext);
      }
      expect(harness.uiCalls.some((call) => call.surface === 'custom')).toBe(false);
      expect(lastNotice(harness)).toContain('Signal: 0 actionable questions');
      expect(harness.appendCalls).toHaveLength(0);
      expect(harness.sendCalls).toHaveLength(0);
    },
  );

  it('uses summary when a TUI context has no custom UI method', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const base = harness.context() as ExtensionCommandContext;
    const context = {
      ...base,
      ui: { ...base.ui, custom: undefined },
    } as unknown as ExtensionCommandContext;
    await commandHandler(harness)('', context);
    expect(lastNotice(harness)).toContain('Signal: 0 actionable questions');
  });

  it.each(['unknown', 'inbox extra', 'Doctor', '\tupdates\nextra\r'])(
    'returns stable usage for %j without throwing',
    async (args) => {
      const harness = new FakePiHarness();
      register(harness);
      await harness.dispatch('session_start');
      await expect(
        commandHandler(harness)(args, harness.context() as ExtensionCommandContext),
      ).resolves.toBeUndefined();
      expect(lastNotice(harness)).toBe(
        'Usage: /signalboard [inbox|updates|decisions|history|summary|doctor]\nSubcommands are case-sensitive. Extra arguments are not accepted.',
      );
    },
  );

  it('returns a stable unavailable result for later mutation actions without service calls', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    harness.queueUiResult('custom', {
      type: 'answer',
      tab: 'inbox',
      entityId: 'qst_synthetic',
      expectedRevision: 1,
    });
    await commandHandler(harness)('', harness.context() as ExtensionCommandContext);
    expect(lastNotice(harness)).toBe(
      'Answer interaction unavailable (SB_NOT_FOUND). No state changed.',
    );
    expect(harness.uiCalls.filter((call) => call.surface === 'custom')).toHaveLength(2);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('contains component failures and does not expose exception text', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const base = harness.context() as ExtensionCommandContext;
    const context = {
      ...base,
      ui: {
        ...base.ui,
        custom: async () => {
          throw new Error('SYNTHETIC_PRIVATE_COMPONENT_STACK');
        },
      },
    } as ExtensionCommandContext;
    await expect(commandHandler(harness)('', context)).resolves.toBeUndefined();
    expect(lastNotice(harness)).toBe(
      'Signal Board interactive UI failed (SB_UI_UNAVAILABLE). No state changed.',
    );
    expect(lastNotice(harness)).not.toContain('SYNTHETIC_PRIVATE_COMPONENT_STACK');
  });

  it('reports unavailable runtime and a failing clock safely', async () => {
    const unavailable = new FakePiHarness();
    register(unavailable);
    await commandHandler(unavailable)('summary', unavailable.context() as ExtensionCommandContext);
    expect(lastNotice(unavailable)).toContain('SB_NOT_INITIALIZED');

    const clockFailure = new FakePiHarness();
    register(clockFailure, () => {
      throw new Error('SYNTHETIC_CLOCK_SECRET');
    });
    await commandHandler(clockFailure)('', clockFailure.context() as ExtensionCommandContext);
    expect(lastNotice(clockFailure)).toBe(
      'Signal Board command failed safely (SB_INTERNAL). No state changed.',
    );
    expect(lastNotice(clockFailure)).not.toContain('SYNTHETIC_CLOCK_SECRET');
  });

  it('opens and closes repeatedly without command, handler, timer, or persistence leaks', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    const registrations = harness.registrationCount('commands');
    const handlers = harness.handlerCount('session_start');
    for (let run = 0; run < 100; run += 1) {
      await commandHandler(harness)('', interactiveContext(harness, []));
    }
    await harness.dispatch('session_tree');
    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });
    await harness.dispatch('session_shutdown');
    expect(harness.registrationCount('commands')).toBe(registrations);
    expect(harness.handlerCount('session_start')).toBe(handlers);
    expect(harness.timers.pending()).toEqual([]);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });
});

describe('SB-028 effective command discovery', () => {
  const sourceInfo = (source: string, path: string) => ({ source, path });

  it('uses exact base name when unique and deterministic numeric suffix when owned', () => {
    expect(
      resolveEffectiveCommand([
        { name: 'signalboard', source: 'extension', sourceInfo: sourceInfo(PRODUCT, '/ours') },
      ]),
    ).toMatchObject({ invocation: '/signalboard', discovered: true, collision: false });
    expect(
      resolveEffectiveCommand(
        [
          { name: 'signalboard:1', source: 'extension', sourceInfo: sourceInfo('other', '/other') },
          { name: 'signalboard:2', source: 'extension', sourceInfo: sourceInfo(PRODUCT, '/ours') },
        ],
        '/ours',
      ),
    ).toMatchObject({ invocation: '/signalboard:2', discovered: true, collision: true });
  });

  it('matches injected source paths without filesystem inspection', () => {
    expect(
      resolveEffectiveCommand(
        [
          {
            name: 'signalboard:3',
            source: 'extension',
            sourceInfo: sourceInfo('unknown', 'C:\\\\pkg\\\\dist\\\\index.js/'),
          },
          { name: 'signalboard:4', source: 'extension', sourceInfo: sourceInfo('other', '/other') },
        ],
        'C:/pkg/dist/index.js',
      ),
    ).toMatchObject({ invocation: '/signalboard:3', discovered: true });
  });

  it('falls back safely when duplicate metadata is ambiguous', () => {
    expect(
      resolveEffectiveCommand([
        { name: 'signalboard:1', source: 'extension', sourceInfo: sourceInfo('one', '/one') },
        { name: 'signalboard:2', source: 'extension', sourceInfo: sourceInfo('two', '/two') },
      ]),
    ).toMatchObject({ invocation: '/signalboard', discovered: false, ambiguous: true });
  });

  it('reports the actual suffix in doctor and records one content-free ambiguity diagnostic', async () => {
    const suffixed = new FakePiHarness();
    suffixed.setCommands([
      {
        name: 'signalboard:1',
        source: 'extension',
        sourceInfo: sourceInfo('other', '/other/index.js'),
      },
      {
        name: 'signalboard:2',
        source: 'extension',
        sourceInfo: sourceInfo(PRODUCT, '/ours/index.js'),
      },
    ]);
    register(suffixed);
    await suffixed.dispatch('session_start');
    await commandHandler(suffixed)('doctor', suffixed.context() as ExtensionCommandContext);
    expect(lastNotice(suffixed)).toContain('Command: /signalboard:2');

    const ambiguous = new FakePiHarness();
    ambiguous.setCommands([
      { name: 'signalboard:1', source: 'extension', sourceInfo: sourceInfo('one', '/one') },
      { name: 'signalboard:2', source: 'extension', sourceInfo: sourceInfo('two', '/two') },
    ]);
    register(ambiguous);
    await ambiguous.dispatch('session_start');
    await commandHandler(ambiguous)('summary', ambiguous.context() as ExtensionCommandContext);
    await commandHandler(ambiguous)('summary', ambiguous.context() as ExtensionCommandContext);
    await commandHandler(ambiguous)('doctor', ambiguous.context() as ExtensionCommandContext);
    expect(lastNotice(ambiguous)).toContain('SB_COMMAND_DISCOVERY_AMBIGUOUS=1');
    expect(lastNotice(ambiguous)).not.toContain('/one');
    expect(lastNotice(ambiguous)).not.toContain('/two');
  });
});

const PRODUCT = 'pi-signal-board';
