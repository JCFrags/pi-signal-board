import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import {
  createDeferred,
  DeterministicIds,
  FakeClock,
  FakeConfigReader,
  FakePiHarness,
  FakeTimers,
  makeCompactionEntry,
  makeCustomEntry,
  SyntheticLogCapture,
} from '../helpers/index.js';

describe('fake Pi harness', () => {
  it('models alternate root-to-leaf branches and can forbid getEntries', () => {
    const harness = new FakePiHarness();
    const root = makeCustomEntry({ id: 'root0001', data: { value: 'root' } });
    const left = makeCustomEntry({
      id: 'left0001',
      parentId: root.id,
      data: { value: 'left' },
    });
    const right = makeCustomEntry({
      id: 'right001',
      parentId: root.id,
      data: { value: 'right' },
    });

    harness.replaceTree([root, left, right], left.id);
    expect(
      harness
        .context()
        .sessionManager.getBranch()
        .map((entry) => entry.id),
    ).toEqual([root.id, left.id]);

    harness.selectLeaf(right.id);
    expect(
      harness
        .context()
        .sessionManager.getBranch()
        .map((entry) => entry.id),
    ).toEqual([root.id, right.id]);

    harness.forbidGetEntries();
    expect(() => harness.context().sessionManager.getEntries()).toThrow(
      'Production replay must use getBranch()',
    );
    expect(harness.branchReads).toBe(2);
    expect(harness.entriesReads).toBe(1);
  });

  it('records append parent linkage and throws before recording when injected', () => {
    const harness = new FakePiHarness();
    harness.replaceBranch([makeCustomEntry({ id: 'root0001', data: { value: 1 } })]);

    harness.api.appendEntry('pi-signal-board/event', { value: 2 });

    expect(harness.appendCalls).toEqual([
      {
        customType: 'pi-signal-board/event',
        data: { value: 2 },
        parentId: 'root0001',
      },
    ]);
    expect(harness.getBranch().at(-1)).toMatchObject({
      type: 'custom',
      parentId: 'root0001',
      data: { value: 2 },
    });

    harness.failNextAppend(new Error('append rejected'));
    expect(() => harness.api.appendEntry('pi-signal-board/event', { value: 3 })).toThrow(
      'append rejected',
    );
    expect(harness.appendCalls).toHaveLength(1);
    expect(harness.getBranch()).toHaveLength(2);
  });

  it('records exact hidden message options and supports send failure injection', () => {
    const harness = new FakePiHarness();
    const message = {
      customType: 'pi-signal-board/answer',
      content: 'Synthetic answer.',
      display: false,
      details: { answerId: 'ans_0001' },
    };
    const options = { deliverAs: 'steer' as const, triggerTurn: true };

    harness.api.sendMessage(message, options);
    expect(harness.sendCalls).toEqual([{ message, options }]);

    harness.failNextSend(new Error('send rejected'));
    expect(() => harness.api.sendMessage(message, options)).toThrow('send rejected');
    expect(harness.sendCalls).toHaveLength(1);
  });

  it('records static registrations and awaits lifecycle handlers in order', async () => {
    const harness = new FakePiHarness();
    const handled: string[] = [];

    harness.api.registerTool({
      name: 'synthetic_tool',
      label: 'Synthetic tool',
      description: 'Synthetic test tool.',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
    });
    harness.api.registerCommand('signalboard', {
      description: 'Open the synthetic board.',
      handler: async () => undefined,
    });
    harness.api.registerShortcut('ctrl+shift+b', { handler: () => undefined });
    harness.api.on('session_start', async (event) => {
      await Promise.resolve();
      handled.push(`first:${event.reason}`);
    });
    harness.api.on('session_start', (event) => {
      handled.push(`second:${event.reason}`);
    });

    await harness.dispatch('session_start', { type: 'session_start', reason: 'reload' });

    expect(harness.registrationCount('tools')).toBe(1);
    expect(harness.registrationCount('commands')).toBe(1);
    expect(harness.registrationCount('shortcuts')).toBe(1);
    expect(harness.handlerCount('session_start')).toBe(2);
    expect(handled).toEqual(['first:reload', 'second:reload']);
  });

  it.each([
    ['tui', true],
    ['rpc', true],
    ['json', false],
    ['print', false],
  ] as const)('models %s mode with hasUI=%s', async (mode, hasUI) => {
    const harness = new FakePiHarness({ mode });
    const context = harness.context();

    expect(context.mode).toBe(mode);
    expect(context.hasUI).toBe(hasUI);
    await context.ui.custom(() => {
      throw new Error('The fake does not invoke a custom component factory.');
    });

    expect(harness.uiCalls.at(-1)?.surface).toBe('custom');
  });

  it('scripts dialogs and lets each UI surface fail independently', async () => {
    const harness = new FakePiHarness();
    const context = harness.context();
    harness.queueUiResult('select', 'Keep');
    harness.queueUiResult('confirm', true);

    await expect(context.ui.select('Choice', ['Keep', 'Remove'])).resolves.toBe('Keep');
    await expect(context.ui.confirm('Confirm', 'Proceed?')).resolves.toBe(true);

    harness.failNextUi('setWidget', new Error('widget failed'));
    expect(() => context.ui.setWidget('signal', ['Synthetic'])).toThrow('widget failed');
    context.ui.setStatus('signal', 'ready');
    expect(harness.uiCalls.map((call) => call.surface)).toEqual([
      'select',
      'confirm',
      'setWidget',
      'setStatus',
    ]);
  });

  it('spies trust reads and models persistent and ephemeral sessions', () => {
    const harness = new FakePiHarness({ trusted: false, persistent: false });
    const context = harness.context();

    expect(context.isProjectTrusted()).toBe(false);
    expect(context.sessionManager.getSessionFile()).toBeUndefined();
    expect(harness.trustReads).toBe(1);

    harness.trusted = true;
    harness.persistent = true;
    expect(context.isProjectTrusted()).toBe(true);
    expect(context.sessionManager.getSessionFile()).toContain('/sessions/signal-fixture/');
  });

  it('keeps compaction entries in the complete branch', () => {
    const harness = new FakePiHarness();
    const root = makeCustomEntry({ id: 'root0001' });
    const compact = makeCompactionEntry({ id: 'compact1', parentId: root.id });
    const board = makeCustomEntry({ id: 'board001', parentId: compact.id });
    harness.replaceTree([root, compact, board], board.id);

    expect(harness.getBranch().map((entry) => entry.type)).toEqual([
      'custom',
      'compaction',
      'custom',
    ]);
  });
});

describe('deterministic harness controls', () => {
  it('injects versions, clock, and deterministic IDs', () => {
    const harness = new FakePiHarness({
      nodeVersion: '22.19.0',
      piVersion: '0.84.9',
      now: '2030-05-06T07:08:09.000Z',
    });
    const ids = new DeterministicIds();
    ids.seed('answer', ['ans_scripted']);

    expect(harness.versions).toEqual({ node: '22.19.0', pi: '0.84.9' });
    expect(harness.clock.now().toISOString()).toBe('2030-05-06T07:08:09.000Z');
    expect(ids.answer()).toBe('ans_scripted');
    expect(ids.answer()).toBe('ans_0001');
  });

  it('runs fake timers by due time without wall-clock sleeps', async () => {
    const clock = new FakeClock('2030-01-01T00:00:00.000Z');
    const timers = new FakeTimers(clock);
    const fired: string[] = [];
    const later = timers.setTimeout(() => {
      fired.push('later');
    }, 20);
    const earlier = timers.setTimeout(() => {
      fired.push('earlier');
    }, 10);
    timers.unref(later);

    await timers.advanceBy(10);
    expect(fired).toEqual(['earlier']);
    expect(timers.pending()).toEqual([
      { id: later.id, dueAt: Date.parse('2030-01-01T00:00:00.020Z'), unrefed: true },
    ]);

    timers.clearTimeout(earlier);
    await timers.advanceBy(10);
    expect(fired).toEqual(['earlier', 'later']);
  });

  it('provides deferred barriers for explicit interleaving control', async () => {
    const first = createDeferred<void>('first');
    const second = createDeferred<void>('second');
    const order: string[] = [];
    const operation = (async () => {
      await first.promise;
      order.push('first');
      await second.promise;
      order.push('second');
    })();

    second.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    first.resolve();
    await operation;
    expect(order).toEqual(['first', 'second']);
    expect(first.settled).toBe(true);
  });

  it('records fixed config reads and rejects forbidden project paths', async () => {
    const reader = new FakeConfigReader();
    reader.set('/config/global.json', { kind: 'present', text: '{"schemaVersion":1}' });
    reader.forbidPrefix('/workspace/signal-fixture/.pi');

    await expect(reader.readUtf8Capped('/config/global.json', 65_536)).resolves.toEqual({
      kind: 'present',
      text: '{"schemaVersion":1}',
    });
    await expect(
      reader.readUtf8Capped('/workspace/signal-fixture/.pi/pi-signal-board.json', 65_536),
    ).rejects.toThrow('Forbidden synthetic config path access');
    expect(reader.calls).toHaveLength(2);
  });

  it('fails immediately if synthetic private content reaches captured logs', () => {
    const capture = new SyntheticLogCapture();
    capture.record({ code: 'SB_REPLAY_SKIPPED', eventId: 'evt_0001' });
    expect(capture.records).toHaveLength(1);
    expect(() => capture.record('SYNTHETIC_SECRET_DO_NOT_LOG')).toThrow(
      'Synthetic private marker was logged',
    );
  });

  it('records one global call order across session, Pi, lifecycle, and UI activity', async () => {
    const harness = new FakePiHarness();
    harness.api.on('agent_settled', () => undefined);
    harness.replaceBranch([makeCustomEntry({ id: 'root0001' })]);
    harness.api.appendEntry('pi-signal-board/event', { value: 1 });
    harness.context().ui.setStatus('signal', 'ready');
    await harness.dispatch('agent_settled');

    expect(harness.orderedCalls.map((call) => call.sequence)).toEqual(
      harness.orderedCalls.map((_, index) => index + 1),
    );
    expect(harness.orderedCalls.map((call) => `${call.area}:${call.operation}`)).toEqual(
      expect.arrayContaining([
        'session:replaceTree',
        'pi:appendEntry:recorded',
        'ui:setStatus',
        'lifecycle:agent_settled',
      ]),
    );
  });

  it('uses no real timer APIs', () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const timers = new FakeTimers(new FakeClock());
    timers.setTimeout(() => undefined, 1);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });
});
