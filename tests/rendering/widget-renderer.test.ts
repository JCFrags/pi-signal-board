import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import type { UpdateId } from '../../src/domain/ids.js';
import type { VisibleChangeRecord } from '../../src/domain/types.js';
import {
  renderWidgetLines,
  WIDGET_NAMESPACE,
  type WidgetRenderRequest,
} from '../../src/ui/widget/index.js';
import {
  time,
  widgetConfig,
  widgetQuestion,
  widgetState,
  widgetUpdate,
} from './fixtures/widget-state.js';

const request = (
  width: number,
  overrides: Partial<WidgetRenderRequest> = {},
): WidgetRenderRequest => ({
  completedWindowCutoff: time(0),
  currentTime: time(59),
  effectiveCommand: '/signals',
  width,
  ...overrides,
});

function expectWidthBound(lines: readonly string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(width);
}

function itemIds(lines: readonly string[]): string[] {
  return lines.slice(1, -1).map((line) => line.match(/\b[QU]-\d+\b/u)?.[0] ?? 'missing');
}

describe('SB-017 compact widget renderer', () => {
  it('keeps the required namespace and renders exact narrow and long-header golden lines', () => {
    expect(WIDGET_NAMESPACE).toBe('pi-signal-board');
    const state = widgetState({
      questions: [
        widgetQuestion(1, 'blocking', 20, {
          question: 'Preserve the deprecated cache option while compatibility tests run?',
        }),
      ],
      updates: [widgetUpdate(2, 'warning', 19, { title: 'Auth refactor — testing' })],
    });
    const expected = new Map<number, readonly string[]>([
      [
        50,
        [
          'SIGNALS · 1Q · 1U',
          '[BLOCKED] Q-1 Preserve the deprecated cache optio…',
          '[WARNING] U-2 Auth refactor — testing',
          'Open /signalboard:1',
        ],
      ],
      [
        80,
        [
          'SIGNALS · 1 question · 1 update',
          '[BLOCKED] Q-1 Preserve the deprecated cache option while compatibility tests ru…',
          '[WARNING] U-2 Auth refactor — testing',
          'Open /signalboard:1',
        ],
      ],
      [
        100,
        [
          'SIGNALS · 1 question · 1 update',
          '[BLOCKED] Q-1 Preserve the deprecated cache option while compatibility tests run?',
          '[WARNING] U-2 Auth refactor — testing',
          'Open /signalboard:1',
        ],
      ],
      [
        120,
        [
          'SIGNALS · 1 question · 1 update',
          '[BLOCKED] Q-1 Preserve the deprecated cache option while compatibility tests run?',
          '[WARNING] U-2 Auth refactor — testing',
          'Open /signalboard:1',
        ],
      ],
      [
        240,
        [
          'SIGNALS · 1 question · 1 update',
          '[BLOCKED] Q-1 Preserve the deprecated cache option while compatibility tests run?',
          '[WARNING] U-2 Auth refactor — testing',
          'Open /signalboard:1',
        ],
      ],
    ]);

    for (const [width, golden] of expected) {
      const lines = renderWidgetLines(
        state,
        widgetConfig(),
        request(width, { effectiveCommand: '/signalboard:1' }),
      );
      expect(lines, `width ${width}`).toEqual(golden);
      expectWidthBound(lines, width);
    }
  });

  it('preserves selector rank, every rank boundary, and stable newest/display-ID ties', () => {
    const questions = [
      widgetQuestion(1, 'delivery_failed', 1, { answerId: 'ans_one' }),
      widgetQuestion(2, 'needs_attention', 2, { answerId: 'ans_two' }),
      widgetQuestion(3, 'blocking', 3),
      widgetQuestion(4, 'pending', 4, { priority: 'high' }),
      widgetQuestion(10, 'pending', 10),
    ];
    const updates = [
      widgetUpdate(5, 'blocked', 5),
      widgetUpdate(6, 'failed', 6),
      widgetUpdate(7, 'warning', 7),
      widgetUpdate(8, 'working', 8),
      widgetUpdate(9, 'finding', 9),
      widgetUpdate(11, 'completed', 11),
    ];
    const lines = renderWidgetLines(
      widgetState({ questions, updates }),
      widgetConfig({ maxItems: 20 }),
      request(120),
    );
    expect(itemIds(lines)).toEqual([
      'Q-2',
      'Q-1',
      'Q-3',
      'Q-4',
      'U-6',
      'U-5',
      'U-9',
      'U-8',
      'U-7',
      'Q-10',
      'U-11',
    ]);
    expect(lines.slice(1, -1).map((line) => line.match(/^\[[^\]]+\]/u)?.[0])).toEqual([
      '[NEEDS ATTENTION]',
      '[DELIVERY FAILED]',
      '[BLOCKED]',
      '[PENDING]',
      '[FAILED]',
      '[BLOCKED]',
      '[FOUND]',
      '[WORKING]',
      '[WARNING]',
      '[PENDING]',
      '[DONE]',
    ]);
  });

  it('uses deterministic total order for exact timestamp ties', () => {
    const updates = [
      widgetUpdate(12, 'working', 20),
      widgetUpdate(2, 'working', 20),
      widgetUpdate(7, 'working', 20),
    ];
    const forward = renderWidgetLines(
      widgetState({ updates }),
      widgetConfig({ maxItems: 10 }),
      request(80),
    );
    const reverse = renderWidgetLines(
      widgetState({ updates: [...updates].reverse() }),
      widgetConfig({ maxItems: 10 }),
      request(80),
    );
    expect(itemIds(forward)).toEqual(['U-2', 'U-7', 'U-12']);
    expect(reverse).toEqual(forward);
  });

  it('enforces max items without changing useful total counts', () => {
    const lines = renderWidgetLines(
      widgetState({
        questions: [widgetQuestion(1, 'blocking', 4), widgetQuestion(2, 'pending', 3)],
        updates: [widgetUpdate(1, 'blocked', 2), widgetUpdate(2, 'working', 1)],
      }),
      widgetConfig({ maxItems: 2 }),
      request(50),
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('SIGNALS · 2Q · 2U');
    expect(itemIds(lines)).toEqual(['Q-1', 'U-1']);
  });

  it('includes a completion exactly at the passed cutoff and excludes one before it', () => {
    const state = widgetState({
      updates: [widgetUpdate(1, 'completed', 10), widgetUpdate(2, 'completed', 11)],
    });
    expect(
      itemIds(
        renderWidgetLines(state, widgetConfig(), request(80, { completedWindowCutoff: time(10) })),
      ),
    ).toEqual(['U-2', 'U-1']);
    expect(
      itemIds(
        renderWidgetLines(
          state,
          widgetConfig(),
          request(80, { completedWindowCutoff: '2026-08-12T10:10:00.001Z' }),
        ),
      ),
    ).toEqual(['U-2']);
  });

  it('uses only the exact passed current time for the unread header count', () => {
    const item = widgetUpdate(1, 'working', 10);
    const change: VisibleChangeRecord = {
      eventId: 'evt_change' as VisibleChangeRecord['eventId'],
      occurredAt: time(20),
      change: { kind: 'update_changed', itemId: item.id, updateKind: 'working' },
    };
    const state = widgetState({ updates: [item], visibleChanges: [change] });
    expect(
      renderWidgetLines(state, widgetConfig(), request(50, { currentTime: time(19) }))[0],
    ).toBe('SIGNALS · 0Q · 1U');
    expect(
      renderWidgetLines(state, widgetConfig(), request(50, { currentTime: time(20) }))[0],
    ).toBe('SIGNALS · 0Q · 1U · 1 new');
  });

  it('clears disabled and default empty widgets, and renders an explicit configured clear state', () => {
    const empty = widgetState();
    expect(renderWidgetLines(empty, widgetConfig(), request(80))).toEqual([]);
    expect(
      renderWidgetLines(empty, widgetConfig({ enabled: false, hideWhenClear: false }), request(80)),
    ).toEqual([]);
    expect(
      renderWidgetLines(
        empty,
        widgetConfig({ hideWhenClear: false }, { enabled: false }),
        request(80),
      ),
    ).toEqual([]);
    expect(renderWidgetLines(empty, widgetConfig({ hideWhenClear: false }), request(80))).toEqual([
      'SIGNALS · clear',
      'Open /signals',
    ]);
  });

  it('is safe at width zero and one and bounds all required and wide widths', () => {
    const state = widgetState({
      questions: [widgetQuestion(1, 'delivery_failed', 1, { answerId: 'ans_one' })],
    });
    expect(renderWidgetLines(state, widgetConfig(), request(0))).toEqual([]);
    const one = renderWidgetLines(state, widgetConfig(), request(1));
    expect(one.length).toBeGreaterThan(0);
    expectWidthBound(one, 1);
    for (const width of [50, 80, 100, 120, 240]) {
      const lines = renderWidgetLines(state, widgetConfig(), request(width));
      expectWidthBound(lines, width);
      expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(120);
    }
  });

  it('handles Unicode display width and preserves state label and display ID before title truncation', () => {
    const unicode = 'e\u0301 全角 😀👩🏽‍💻 '.repeat(20);
    const state = widgetState({
      updates: [widgetUpdate(42, 'warning', 1, { title: unicode })],
    });
    for (const width of [50, 80, 100, 120, 240]) {
      const lines = renderWidgetLines(state, widgetConfig(), request(width));
      expect(lines[1]).toMatch(/^\[WARNING\] U-42 /u);
      expectWidthBound(lines, width);
    }
  });

  it('removes hostile terminal controls and never emits detail, attachments, or unrelated state', () => {
    const hostileTitle =
      '\u001b[31mRed\u001b[0m \u001b]8;;https://invalid.example\u0007link\u001b]8;;\u0007 ' +
      '\u001bPprivate-event-json\u001b\\ safe\u0000text\u009b31m';
    const state = widgetState({
      updates: [
        widgetUpdate(1, 'working', 1, {
          title: hostileTitle,
          detail: 'UNRELATED_DETAIL',
          attachments: [{ kind: 'note', label: 'SECRET_ATTACHMENT', text: 'SECRET_ANSWER' }],
        }),
      ],
    });
    const lines = renderWidgetLines(
      state,
      widgetConfig(),
      request(120, { effectiveCommand: '/signalboard:2\u001b[5m' }),
    );
    const output = lines.join('\n');
    expect(output).toContain('[WORKING] U-1 Red link safetext');
    expect(output).toContain('Open /signalboard:2');
    expect(
      [...output].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint === 0x1b || (codePoint >= 0x7f && codePoint <= 0x9f);
      }),
    ).toBe(false);
    expect(output).not.toContain('private-event-json');
    expect(output).not.toContain('UNRELATED_DETAIL');
    expect(output).not.toContain('SECRET_ATTACHMENT');
    expect(output).not.toContain('SECRET_ANSWER');
  });

  it('returns frozen deterministic lines and does not mutate immutable board input', () => {
    const update = widgetUpdate(1, 'working', 1);
    const state = widgetState({ updates: [update] });
    const before = structuredClone({ update: [...state.updates.values()][0] });
    const first = renderWidgetLines(state, widgetConfig(), request(80));
    const second = renderWidgetLines(state, widgetConfig(), request(80));
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => (first as string[]).push('mutation')).toThrow(TypeError);
    expect({ update: [...state.updates.values()][0] }).toEqual(before);
  });

  it('does not render archived updates', () => {
    const archived = widgetUpdate(1, 'failed', 20, {
      id: 'upd_10000000-0000-4000-8000-000000000001' as UpdateId,
      archived: true,
      archivedAt: time(21),
    });
    expect(
      renderWidgetLines(widgetState({ updates: [archived] }), widgetConfig(), request(80)),
    ).toEqual([]);
  });
});
