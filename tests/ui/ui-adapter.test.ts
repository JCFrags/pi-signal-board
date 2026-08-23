import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { EffectiveConfig } from '../../src/config/types.js';
import type { VisibleChangeRecord } from '../../src/domain/types.js';
import { createDiagnostics } from '../../src/services/diagnostics.js';
import {
  completionWindowCutoff,
  createSignalBoardUiAdapter,
  type UiAdapterRefresh,
} from '../../src/ui/adapter.js';
import { FakePiHarness } from '../helpers/fake-pi.js';
import {
  time,
  widgetQuestion,
  widgetState,
  widgetUpdate,
} from '../rendering/fixtures/widget-state.js';

function config(
  input: {
    widget?: boolean;
    status?: boolean;
    enabled?: boolean;
    hideWhenClear?: boolean;
    statusHideWhenClear?: boolean;
  } = {},
): EffectiveConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: input.enabled ?? true,
    widget: {
      ...DEFAULT_CONFIG.widget,
      enabled: input.widget ?? true,
      hideWhenClear: input.hideWhenClear ?? true,
    },
    status: {
      ...DEFAULT_CONFIG.status,
      enabled: input.status ?? true,
      hideWhenClear: input.statusHideWhenClear ?? true,
    },
  };
}

function refresh(
  state: UiAdapterRefresh['state'],
  effectiveConfig = config(),
  overrides: Partial<UiAdapterRefresh> = {},
): UiAdapterRefresh {
  return {
    state,
    config: effectiveConfig,
    currentTime: time(59),
    completedWindowCutoff: time(0),
    effectiveCommand: '/signalboard',
    ...overrides,
  };
}

function surfaceCalls(harness: FakePiHarness, surface: string) {
  return harness.uiCalls.filter((call) => call.surface === surface);
}

function lastSurface(harness: FakePiHarness, surface: string): readonly unknown[] | undefined {
  return surfaceCalls(harness, surface).at(-1)?.args;
}

function renderInstalledWidget(harness: FakePiHarness, width: number): string[] {
  const content = lastSurface(harness, 'setWidget')?.[1];
  if (typeof content !== 'function') return [];
  return (content as () => Component)().render(width);
}

describe('Signals UI adapter', () => {
  it('sets exact actionable, active, and unread no-color status counts', () => {
    const harness = new FakePiHarness();
    const diagnostics = createDiagnostics();
    const active = widgetUpdate(1, 'working', 10);
    const terminal = widgetUpdate(2, 'completed', 20);
    const question = widgetQuestion(1, 'blocking', 30);
    const change: VisibleChangeRecord = {
      eventId: 'evt_visible' as VisibleChangeRecord['eventId'],
      occurredAt: time(40),
      change: { kind: 'update_completed', itemId: terminal.id, updateKind: 'completed' },
    };
    const adapter = createSignalBoardUiAdapter(harness.context(), diagnostics);

    adapter.refresh(
      refresh(
        widgetState({
          updates: [active, terminal],
          questions: [question],
          visibleChanges: [change],
        }),
      ),
    );

    expect(lastSurface(harness, 'setStatus')).toEqual(['pi-signal-board', 'Signal: 1Q 1U 1 new']);
    expect(renderInstalledWidget(harness, 80).join('\n')).toContain('[BLOCKED] Q-1');
    expect(renderInstalledWidget(harness, 80).join('\n')).toContain('[WORKING] U-1');
    expect(renderInstalledWidget(harness, 80).join('\n')).toContain('[DONE] U-2');
    expect(diagnostics.count()).toBe(0);
  });

  it('does not inflate status with terminal history and honors exact clear-state configuration', () => {
    const harness = new FakePiHarness();
    const adapter = createSignalBoardUiAdapter(harness.context(), createDiagnostics());
    adapter.refresh(refresh(widgetState({ updates: [widgetUpdate(1, 'completed', 20)] })));
    expect(lastSurface(harness, 'setStatus')).toEqual(['pi-signal-board', undefined]);

    adapter.refresh(refresh(widgetState()));
    expect(lastSurface(harness, 'setWidget')).toEqual([
      'pi-signal-board',
      undefined,
      { placement: 'aboveEditor' },
    ]);
    expect(lastSurface(harness, 'setStatus')).toEqual(['pi-signal-board', undefined]);

    adapter.refresh(refresh(widgetState(), config({ statusHideWhenClear: false })));
    expect(lastSurface(harness, 'setStatus')).toEqual(['pi-signal-board', 'Signal: clear']);
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ] as const)('clears each independently when widget=%s and status=%s', (widget, status) => {
    const harness = new FakePiHarness();
    const adapter = createSignalBoardUiAdapter(harness.context(), createDiagnostics());
    adapter.refresh(
      refresh(
        widgetState({ updates: [widgetUpdate(1, 'working', 20)] }),
        config({ widget, status }),
      ),
    );
    expect(typeof lastSurface(harness, 'setWidget')?.[1] === 'function').toBe(widget);
    expect(lastSurface(harness, 'setStatus')?.[1]).toBe(status ? 'Signal: 0Q 1U' : undefined);
  });

  it('uses the exact completion cutoff and preserves selector rank at all required widths', () => {
    const harness = new FakePiHarness();
    const adapter = createSignalBoardUiAdapter(harness.context(), createDiagnostics());
    adapter.refresh(
      refresh(
        widgetState({
          questions: [widgetQuestion(1, 'blocking', 5)],
          updates: [widgetUpdate(1, 'working', 6), widgetUpdate(2, 'completed', 10)],
        }),
        config(),
        { completedWindowCutoff: '2026-08-12T10:10:00.001Z' },
      ),
    );

    for (const width of [50, 80, 100, 120, 240]) {
      const lines = renderInstalledWidget(harness, width);
      expect(lines[1]).toContain('[BLOCKED] Q-1');
      expect(lines[2]).toContain('[WORKING] U-1');
      expect(lines.join('\n')).not.toContain('[DONE] U-2');
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join('\n')).not.toContain(String.fromCodePoint(27));
    }
  });

  it.each(['tui', 'rpc', 'json', 'print'] as const)(
    'is safe and deterministic in %s mode',
    (mode) => {
      const harness = new FakePiHarness({ mode });
      const adapter = createSignalBoardUiAdapter(harness.context(), createDiagnostics());
      expect(() =>
        adapter.refresh(refresh(widgetState({ updates: [widgetUpdate(1, 'working', 1)] }))),
      ).not.toThrow();
      if (mode === 'tui' || mode === 'rpc') {
        expect(lastSurface(harness, 'setStatus')?.[1]).toBe('Signal: 0Q 1U');
      } else {
        expect(harness.uiCalls).toEqual([]);
      }
    },
  );

  it('contains missing and throwing members, handles surfaces independently, and later recovers', () => {
    const harness = new FakePiHarness();
    const diagnostics = createDiagnostics();
    const base = harness.context();
    const missingWidget = {
      ...base,
      ui: { setStatus: base.ui.setStatus.bind(base.ui) },
    } as unknown as ExtensionContext;
    const missingAdapter = createSignalBoardUiAdapter(missingWidget, diagnostics);
    expect(() =>
      missingAdapter.refresh(refresh(widgetState({ updates: [widgetUpdate(1, 'working', 1)] }))),
    ).not.toThrow();
    expect(lastSurface(harness, 'setStatus')?.[1]).toBe('Signal: 0Q 1U');

    const missingStatus = {
      ...base,
      ui: { setWidget: base.ui.setWidget.bind(base.ui) },
    } as unknown as ExtensionContext;
    const missingStatusAdapter = createSignalBoardUiAdapter(missingStatus, diagnostics);
    expect(() =>
      missingStatusAdapter.refresh(
        refresh(widgetState({ updates: [widgetUpdate(2, 'working', 2)] })),
      ),
    ).not.toThrow();
    expect(typeof lastSurface(harness, 'setWidget')?.[1]).toBe('function');

    const adapter = createSignalBoardUiAdapter(harness.context(), diagnostics);
    harness.failNextUi('setWidget', new Error('PRIVATE board title'));
    adapter.refresh(
      refresh(
        widgetState({ updates: [widgetUpdate(2, 'working', 2, { title: 'PRIVATE board title' })] }),
      ),
    );
    expect(lastSurface(harness, 'setStatus')?.[1]).toBe('Signal: 0Q 1U');
    expect(() =>
      adapter.refresh(refresh(widgetState({ updates: [widgetUpdate(3, 'working', 3)] }))),
    ).not.toThrow();
    expect(typeof lastSurface(harness, 'setWidget')?.[1]).toBe('function');

    harness.failNextUi('setStatus', new Error('PRIVATE question text'));
    adapter.refresh(refresh(widgetState({ updates: [widgetUpdate(4, 'working', 4)] })));
    expect(typeof lastSurface(harness, 'setWidget')?.[1]).toBe('function');
    adapter.refresh(refresh(widgetState({ updates: [widgetUpdate(5, 'working', 5)] })));
    expect(lastSurface(harness, 'setStatus')?.[1]).toBe('Signal: 0Q 1U');

    const snapshot = diagnostics.snapshot();
    expect(snapshot.counts.SB_UI_UNAVAILABLE).toBe(4);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });

  it('clears installed surfaces when the host becomes noninteractive', () => {
    const harness = new FakePiHarness();
    const diagnostics = createDiagnostics();
    const base = harness.context();
    let hasUi = true;
    const context = {
      ...base,
      get hasUI() {
        return hasUi;
      },
    } as ExtensionContext;
    const adapter = createSignalBoardUiAdapter(context, diagnostics);
    const active = refresh(widgetState({ updates: [widgetUpdate(1, 'working', 1)] }));
    adapter.refresh(active);
    expect(typeof lastSurface(harness, 'setWidget')?.[1]).toBe('function');
    expect(lastSurface(harness, 'setStatus')?.[1]).toBe('Signal: 0Q 1U');

    hasUi = false;
    adapter.refresh(active);
    expect(lastSurface(harness, 'setWidget')?.[1]).toBeUndefined();
    expect(lastSurface(harness, 'setStatus')?.[1]).toBeUndefined();
    const callsAfterClear = harness.uiCalls.length;
    adapter.refresh(active);
    expect(harness.uiCalls).toHaveLength(callsAfterClear);
    expect(diagnostics.count()).toBe(0);
  });

  it('clears active surfaces without preventing a later refresh', () => {
    const harness = new FakePiHarness();
    const adapter = createSignalBoardUiAdapter(harness.context(), createDiagnostics());
    const active = refresh(widgetState({ updates: [widgetUpdate(1, 'working', 1)] }));
    adapter.refresh(active);

    const widgetCallsBeforeClear = surfaceCalls(harness, 'setWidget').length;
    const statusCallsBeforeClear = surfaceCalls(harness, 'setStatus').length;
    adapter.clear();
    expect(surfaceCalls(harness, 'setWidget')).toHaveLength(widgetCallsBeforeClear + 1);
    expect(surfaceCalls(harness, 'setStatus')).toHaveLength(statusCallsBeforeClear + 1);
    expect(lastSurface(harness, 'setWidget')?.[1]).toBeUndefined();
    expect(lastSurface(harness, 'setStatus')?.[1]).toBeUndefined();

    adapter.clear();
    expect(surfaceCalls(harness, 'setWidget')).toHaveLength(widgetCallsBeforeClear + 1);
    expect(surfaceCalls(harness, 'setStatus')).toHaveLength(statusCallsBeforeClear + 1);
    adapter.refresh(active);
    expect(typeof lastSurface(harness, 'setWidget')?.[1]).toBe('function');
    expect(lastSurface(harness, 'setStatus')?.[1]).toBe('Signal: 0Q 1U');
  });

  it('clears disabled state and makes direct disposal idempotent', () => {
    const harness = new FakePiHarness();
    const adapter = createSignalBoardUiAdapter(harness.context(), createDiagnostics());
    adapter.refresh(
      refresh(
        widgetState({ updates: [widgetUpdate(1, 'working', 1)] }),
        config({ enabled: false }),
      ),
    );
    expect(lastSurface(harness, 'setWidget')?.[1]).toBeUndefined();
    expect(lastSurface(harness, 'setStatus')?.[1]).toBeUndefined();

    const before = harness.uiCalls.length;
    adapter.dispose();
    const afterFirst = harness.uiCalls.length;
    adapter.dispose();
    expect(afterFirst - before).toBe(2);
    expect(harness.uiCalls).toHaveLength(afterFirst);
    adapter.refresh(refresh(widgetState({ updates: [widgetUpdate(2, 'working', 2)] })));
    expect(harness.uiCalls).toHaveLength(afterFirst);
  });

  it('computes an exact cutoff from the injected clock value', () => {
    expect(completionWindowCutoff(new Date('2026-08-12T10:20:00.000Z'), 10)).toBe(
      '2026-08-12T10:10:00.000Z',
    );
  });
});
