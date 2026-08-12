import type {
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { EffectiveConfig } from '../../src/config/types.js';
import type { BoardEvent, UpdateUpsertedEvent } from '../../src/domain/events.js';
import { selectCatchUp } from '../../src/domain/selectors.js';
import type { BoardState } from '../../src/domain/types.js';
import { createSignalBoardExtension } from '../../src/index.js';
import { evaluateHostCompatibility } from '../../src/integration/compatibility.js';
import type { RuntimeLifecycle } from '../../src/integration/lifecycle.js';
import { FakePiHarness, makeCustomEntry } from '../helpers/index.js';

const T1 = '2030-01-01T01:00:00.000Z';
const T2 = '2030-01-01T02:00:00.000Z';
const T3 = '2030-01-01T03:00:00.000Z';
const T4 = '2030-01-01T04:00:00.000Z';
const UPDATE_ID = 'upd_00000000-0000-4000-8000-000000000001';

function updateEvent(): UpdateUpsertedEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt_00000000-0000-4000-8000-000000000001',
    eventType: 'update.upserted',
    occurredAt: T1,
    actor: 'agent',
    commandId: 'tool:initial-update',
    payload: {
      updateId: UPDATE_ID,
      displayId: 'U-1',
      revision: 1,
      createdAt: T1,
      updatedAt: T1,
      fields: { kind: 'working', title: 'Initial visible update', attachments: [] },
    },
  };
}

function register(
  harness: FakePiHarness,
  config: EffectiveConfig = DEFAULT_CONFIG,
): { lifecycle: RuntimeLifecycle } {
  let lifecycle: RuntimeLifecycle | undefined;
  createSignalBoardExtension({
    evaluateCompatibility: () =>
      evaluateHostCompatibility({ nodeVersion: '22.19.0', piVersion: '0.84.1' }),
    loadConfig: async () => ({
      config,
      sources: { global: 'absent', project: 'absent' },
      warnings: [],
    }),
    now: () => harness.clock.now(),
    writePrint: () => undefined,
    expiryTimers: harness.timers,
    captureLifecycle: (value) => {
      lifecycle = value;
    },
  })(harness.api);
  if (lifecycle === undefined) throw new Error('Lifecycle capture failed.');
  return { lifecycle };
}

function seedUnread(harness: FakePiHarness): void {
  harness.replaceBranch([makeCustomEntry({ id: 'initial-entry', data: updateEvent() })]);
  harness.clock.set(T2);
}

function commandHandler(harness: FakePiHarness) {
  const registration = harness.registrations.commands[0];
  if (registration === undefined) throw new Error('Missing command.');
  return (
    registration.options as {
      handler(args: string, context: ExtensionCommandContext): Promise<void>;
    }
  ).handler;
}

function shortcutHandler(harness: FakePiHarness) {
  const registration = harness.registrations.shortcuts[0];
  if (registration === undefined) throw new Error('Missing shortcut.');
  return (
    registration.options as {
      handler(context: ExtensionContext): Promise<void>;
    }
  ).handler;
}

function updateTool(harness: FakePiHarness) {
  const tool = harness.registrations.tools.find(
    (candidate) => (candidate as { name?: string }).name === 'signal_board_update',
  );
  if (tool === undefined) throw new Error('Missing update tool.');
  return tool as {
    execute(toolCallId: string, input: unknown): Promise<unknown>;
  };
}

function closingContext(
  harness: FakePiHarness,
  beforeClose?: () => void | Promise<void>,
): ExtensionCommandContext {
  const base = harness.context() as ExtensionCommandContext;
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
        await beforeClose?.();
        component.handleInput?.('\u001b');
        harness.clock.set(T4);
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
}

function noColorTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function viewedEvents(harness: FakePiHarness): BoardEvent[] {
  return harness.appendCalls
    .map((call) => call.data as BoardEvent)
    .filter((event) => event.eventType === 'board.viewed');
}

describe('SB-030 command and shortcut close integration', () => {
  it.each(['command', 'shortcut'] as const)(
    'marks a normal %s close at the open cutoff',
    async (path) => {
      const harness = new FakePiHarness({ now: T1 });
      seedUnread(harness);
      const { lifecycle } = register(harness);
      await harness.dispatch('session_start');

      if (path === 'command') {
        await commandHandler(harness)('', closingContext(harness));
      } else {
        await shortcutHandler(harness)(closingContext(harness));
      }

      expect(viewedEvents(harness)).toHaveLength(1);
      expect(viewedEvents(harness)[0]).toMatchObject({
        occurredAt: T4,
        actor: 'user',
        commandId: expect.stringMatching(/^ui:/u),
        payload: { cutoffAt: T2 },
      });
      expect(lifecycle.slot.current()?.state.lastViewedAt).toBe(T2);
    },
  );

  it('keeps an event appended while open unread after normal close', async () => {
    const harness = new FakePiHarness({ now: T1 });
    seedUnread(harness);
    const { lifecycle } = register(harness);
    await harness.dispatch('session_start');

    await commandHandler(harness)(
      '',
      closingContext(harness, async () => {
        harness.clock.set(T3);
        await updateTool(harness).execute('during-open', {
          operation: 'upsert',
          id: UPDATE_ID,
          kind: 'warning',
          title: 'Changed while open',
        });
      }),
    );

    const runtime = lifecycle.slot.current();
    expect(runtime?.state.lastViewedAt).toBe(T2);
    expect(selectCatchUp(runtime?.state as NonNullable<typeof runtime>['state'], T4).items).toEqual(
      [
        expect.objectContaining({
          occurredAt: T3,
          change: expect.objectContaining({ itemId: UPDATE_ID }),
        }),
      ],
    );
  });

  it('serializes an update queued at close before the fixed-cutoff checkpoint', async () => {
    const harness = new FakePiHarness({ now: T1 });
    seedUnread(harness);
    const { lifecycle } = register(harness);
    await harness.dispatch('session_start');
    let queued: Promise<unknown> | undefined;

    await commandHandler(harness)(
      '',
      closingContext(harness, () => {
        harness.clock.set(T3);
        queued = updateTool(harness).execute('queued-at-close', {
          operation: 'upsert',
          id: UPDATE_ID,
          kind: 'warning',
          title: 'Queued while closing',
        });
      }),
    );
    await queued;

    const eventTypes = harness.appendCalls.map((call) => (call.data as BoardEvent).eventType);
    expect(eventTypes.slice(-2)).toEqual(['update.upserted', 'board.viewed']);
    const runtime = lifecycle.slot.current();
    expect(runtime?.state.lastViewedAt).toBe(T2);
    expect(
      selectCatchUp(runtime?.state as NonNullable<typeof runtime>['state'], T4).items,
    ).toHaveLength(1);
  });

  it.each([
    ['summary', 'summary', 'tui'],
    ['doctor', 'doctor', 'tui'],
    ['usage', 'unknown', 'tui'],
    ['noninteractive', '', 'print'],
  ] as const)('does not mark viewed on the %s path', async (_label, args, mode) => {
    const harness = new FakePiHarness({ now: T1, mode });
    seedUnread(harness);
    register(harness);
    await harness.dispatch('session_start', undefined, harness.context(mode));
    await commandHandler(harness)(args, harness.context(mode) as ExtensionCommandContext);
    expect(viewedEvents(harness)).toHaveLength(0);
  });

  it('does not mark a model construction failure', async () => {
    const harness = new FakePiHarness({ now: T1 });
    seedUnread(harness);
    const { lifecycle } = register(harness);
    await harness.dispatch('session_start');
    const runtime = lifecycle.slot.current();
    if (runtime === undefined) throw new Error('Runtime is unavailable.');
    const throwingUpdates = {
      values: () => {
        throw new Error('synthetic model failure');
      },
    } as unknown as BoardState['updates'];
    runtime.state = { ...runtime.state, updates: throwingUpdates };
    await commandHandler(harness)('', closingContext(harness));
    expect(viewedEvents(harness)).toHaveLength(0);
    const notice = [...harness.uiCalls].reverse().find((call) => call.surface === 'notify');
    expect(String(notice?.args[0])).toContain('SB_INTERNAL');
  });

  it('does not mark cancellation, unsupported actions, or component failure', async () => {
    for (const outcome of ['cancel', 'action', 'failure'] as const) {
      const harness = new FakePiHarness({ now: T1 });
      seedUnread(harness);
      register(harness);
      await harness.dispatch('session_start');
      const base = harness.context() as ExtensionCommandContext;
      const custom =
        outcome === 'cancel'
          ? async () => undefined
          : outcome === 'action'
            ? async () => ({
                type: 'answer',
                tab: 'inbox',
                entityId: UPDATE_ID,
                expectedRevision: 1,
              })
            : async () => {
                throw new Error('synthetic component failure');
              };
      const context = { ...base, ui: { ...base.ui, custom } } as ExtensionCommandContext;
      await commandHandler(harness)('', context);
      expect(viewedEvents(harness), outcome).toHaveLength(0);
    }
  });

  it.each(['session', 'tree'] as const)(
    'does not checkpoint a %s replacement runtime after the old component closes',
    async (replacement) => {
      const harness = new FakePiHarness({ now: T1 });
      seedUnread(harness);
      const { lifecycle } = register(harness);
      await harness.dispatch('session_start');
      const openedGeneration = lifecycle.slot.current()?.generation;

      await commandHandler(harness)(
        '',
        closingContext(harness, async () => {
          if (replacement === 'session') {
            await harness.dispatch('session_start', {
              type: 'session_start',
              reason: 'resume',
            });
          } else {
            harness.replaceBranch([]);
            await harness.dispatch('session_tree');
          }
        }),
      );

      expect(viewedEvents(harness)).toHaveLength(0);
      expect(lifecycle.slot.current()?.state.lastViewedAt).toBeUndefined();
      if (replacement === 'session') {
        expect(lifecycle.slot.current()?.generation).not.toBe(openedGeneration);
      } else {
        expect(lifecycle.slot.current()?.generation).toBe(openedGeneration);
        expect(lifecycle.slot.current()?.treeRevision).toBe(1);
      }
      const notice = [...harness.uiCalls].reverse().find((call) => call.surface === 'notify');
      expect(String(notice?.args[0])).toContain('SB_STATE_CONFLICT');
    },
  );

  it('keeps unread state on close append failure and succeeds on the next identical open-close', async () => {
    const harness = new FakePiHarness({ now: T1 });
    seedUnread(harness);
    const { lifecycle } = register(harness);
    await harness.dispatch('session_start');
    harness.failNextAppend();

    await commandHandler(harness)('', closingContext(harness));
    expect(lifecycle.slot.current()?.state.lastViewedAt).toBeUndefined();
    expect(viewedEvents(harness)).toHaveLength(0);

    harness.clock.set(T2);
    await commandHandler(harness)('', closingContext(harness));
    expect(lifecycle.slot.current()?.state.lastViewedAt).toBe(T2);
    expect(viewedEvents(harness)).toHaveLength(1);
  });
});
