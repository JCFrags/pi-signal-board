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
import { schemaPositiveEvents } from '../fixtures/schema-positive.js';
import { FakePiHarness, makeCustomEntry } from '../helpers/index.js';

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
  if (registration === undefined) throw new Error('Missing Signals command.');
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
      'Signals: 1 actionable question, 1 active update, 0 unread changes.\nQuestions:\n- [DELIVERY FAILED] Q-1 Choose one?\nUpdates:\n- [FOUND] U-1 Found evidence',
    );
  });

  it('returns exact stable plain summary without UI or persistence', async () => {
    const harness = new FakePiHarness();
    register(harness);
    await harness.dispatch('session_start');
    harness.uiCalls.length = 0;

    await commandHandler(harness)('summary', harness.context() as ExtensionCommandContext);

    expect(lastNotice(harness)).toBe(
      'Signals: 0 actionable questions, 0 active updates, 0 unread changes.\nQuestions:\n- none\nUpdates:\n- none',
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
    expect(output).toContain('SIGNALS DOCTOR');
    expect(output).toContain('Command: /signals');
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
      expect(lastNotice(harness)).toContain('Signals: 0 actionable questions');
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
    expect(lastNotice(harness)).toContain('Signals: 0 actionable questions');
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
        'Usage: /signals [inbox|updates|decisions|history|summary|doctor]\nSubcommands are case-sensitive. Extra arguments are not accepted.',
      );
    },
  );

  it('persists and delivers a confirmed recommendation before returning to the board', async () => {
    const harness = new FakePiHarness();
    harness.replaceBranch([
      makeCustomEntry({
        id: 'question-entry',
        data: schemaPositiveEvents[1],
      }),
    ]);
    register(harness);
    await harness.dispatch('session_start');
    harness.queueUiResult('custom', {
      type: 'accept_recommendation',
      tab: 'inbox',
      entityId: 'qst_22222222-2222-4222-8222-222222222222',
      expectedRevision: 1,
    });
    harness.queueUiResult('confirm', true);

    await commandHandler(harness)('', harness.context() as ExtensionCommandContext);

    expect(lastNotice(harness)).toMatch(
      /^Answer ans_[0-9a-f-]+ was saved and queued for at-least-once delivery\.$/u,
    );
    expect(harness.uiCalls.filter((call) => call.surface === 'confirm')).toHaveLength(1);
    expect(harness.uiCalls.filter((call) => call.surface === 'custom')).toHaveLength(2);
    expect(
      harness.appendCalls.map((call) => (call.data as { eventType?: string }).eventType),
    ).toEqual(['question.answered', 'answer.delivery_queued']);
    expect(harness.sendCalls).toHaveLength(1);
    expect(harness.sendCalls[0]).toMatchObject({
      message: {
        customType: 'pi-signal-board/answer',
        details: {
          schemaVersion: 1,
          questionId: 'qst_22222222-2222-4222-8222-222222222222',
          answer: {
            kind: 'single_or_text',
            optionId: 'keep',
            optionLabel: 'Keep for one release',
          },
        },
      },
      options: { triggerTurn: true, deliverAs: 'steer' },
    });
  });

  it('rejects a tree replacement during recommendation confirmation at the shared writer boundary', async () => {
    const harness = new FakePiHarness();
    harness.replaceBranch([
      makeCustomEntry({ id: 'question-entry', data: schemaPositiveEvents[1] }),
    ]);
    register(harness);
    await harness.dispatch('session_start');
    harness.queueUiResult('custom', {
      type: 'accept_recommendation',
      tab: 'inbox',
      entityId: 'qst_22222222-2222-4222-8222-222222222222',
      expectedRevision: 1,
    });
    const base = harness.context() as ExtensionCommandContext;
    const context = {
      ...base,
      ui: {
        ...base.ui,
        confirm: async () => {
          await harness.dispatch('session_tree');
          return true;
        },
      },
    } as ExtensionCommandContext;

    await commandHandler(harness)('', context);

    expect(lastNotice(harness)).toBe('Recommendation unavailable (SB_STATE_CONFLICT).');
    expect(harness.uiCalls.filter((call) => call.surface === 'custom')).toHaveLength(2);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('wires confirmed dismissal once, refreshes the board, sends nothing, and moves Q-1 to History', async () => {
    const harness = new FakePiHarness();
    harness.replaceBranch([
      makeCustomEntry({ id: 'question-entry', data: schemaPositiveEvents[1] }),
    ]);
    register(harness);
    await harness.dispatch('session_start');
    harness.queueUiResult('custom', {
      type: 'dismiss',
      tab: 'inbox',
      entityId: 'qst_22222222-2222-4222-8222-222222222222',
      expectedRevision: 1,
    });
    harness.queueUiResult('confirm', true);

    await commandHandler(harness)('', harness.context() as ExtensionCommandContext);

    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.appendCalls[0]?.data).toMatchObject({
      eventType: 'question.dismissed',
      occurredAt: NOW,
      actor: 'user',
      payload: {
        questionId: 'qst_22222222-2222-4222-8222-222222222222',
        expectedRevision: 1,
        revision: 2,
        dismissedAt: NOW,
      },
    });
    expect(harness.uiCalls.filter((call) => call.surface === 'custom')).toHaveLength(2);
    expect(harness.sendCalls).toHaveLength(0);

    const captures: string[] = [];
    await commandHandler(harness)('history', interactiveContext(harness, captures));
    expect(captures[0]).toContain('[DISMISSED] Q-1');
    expect(captures[0]).not.toContain('[Inbox 1]');
  });

  it.each(['completed', 'failed'] as const)(
    'wires confirmed %s update archive once and moves U-1 to History',
    async (kind) => {
      const harness = new FakePiHarness();
      const base = schemaPositiveEvents[0];
      const event = {
        ...base,
        occurredAt: NOW,
        payload: {
          ...base.payload,
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: NOW,
          fields: { ...base.payload.fields, kind, stage: 'complete' },
        },
      };
      harness.replaceBranch([makeCustomEntry({ id: 'update-entry', data: event })]);
      register(harness);
      await harness.dispatch('session_start');
      harness.queueUiResult('custom', {
        type: 'archive_update',
        tab: 'updates',
        entityId: 'upd_11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
      });
      harness.queueUiResult('confirm', true);

      await commandHandler(harness)('updates', harness.context() as ExtensionCommandContext);

      expect(harness.appendCalls).toHaveLength(1);
      expect(harness.appendCalls[0]?.data).toMatchObject({
        eventType: 'update.archived',
        occurredAt: NOW,
        actor: 'user',
        payload: {
          updateId: 'upd_11111111-1111-4111-8111-111111111111',
          expectedRevision: 1,
          revision: 2,
          archivedAt: NOW,
        },
      });
      expect(harness.uiCalls.filter((call) => call.surface === 'custom')).toHaveLength(2);
      expect(harness.sendCalls).toHaveLength(0);

      const captures: string[] = [];
      await commandHandler(harness)('history', interactiveContext(harness, captures));
      expect(captures[0]).toContain('[ARCHIVED] U-1');
    },
  );

  it('rejects a session-tree replacement during confirmation without mutation', async () => {
    const harness = new FakePiHarness();
    harness.replaceBranch([
      makeCustomEntry({ id: 'question-entry', data: schemaPositiveEvents[1] }),
    ]);
    register(harness);
    await harness.dispatch('session_start');
    harness.queueUiResult('custom', {
      type: 'dismiss',
      tab: 'inbox',
      entityId: 'qst_22222222-2222-4222-8222-222222222222',
      expectedRevision: 1,
    });
    const base = harness.context() as ExtensionCommandContext;
    const context = {
      ...base,
      ui: {
        ...base.ui,
        confirm: async () => {
          await harness.dispatch('session_tree');
          return true;
        },
      },
    } as ExtensionCommandContext;

    await commandHandler(harness)('', context);

    expect(lastNotice(harness)).toBe(
      'Dismissal unavailable (SB_STATE_CONFLICT). No state changed.',
    );
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

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
      'Signals interactive UI failed (SB_UI_UNAVAILABLE). No state changed.',
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
      'Signals command failed safely (SB_INTERNAL). No state changed.',
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
    ).toMatchObject({ invocation: '/signalboard', discovered: true, collision: true });
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
    ).toMatchObject({ invocation: '/signals', discovered: false, ambiguous: true });
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
