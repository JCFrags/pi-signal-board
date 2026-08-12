import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AnswerId, QuestionId, UpdateId } from '../../src/domain/ids.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import type {
  AnswerRecord,
  BoardState,
  QuestionItem,
  QuestionStatus,
  UpdateItem,
  VisibleChangeRecord,
} from '../../src/domain/types.js';
import { type SignalBoardAction, SignalBoardComponent } from '../../src/ui/board/component.js';
import {
  type BoardTab,
  type BoardViewModel,
  boardModelFailure,
  buildBoardViewModel,
} from '../../src/ui/board/model.js';

const OPENED_AT = '2026-08-12T12:30:00.000Z';
const QID = 'qst_72000000-0000-4000-8000-000000000001' as QuestionId;
const AID = 'ans_73000000-0000-4000-8000-000000000001' as AnswerId;
const UID = 'upd_74000000-0000-4000-8000-000000000001' as UpdateId;

function theme(prefix = ''): Theme {
  const value = {
    fg: (_color: string, text: string) => `${prefix}${text}`,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  // Tests provide only the documented theme methods used by the board component.
  return value as unknown as Theme;
}

function question(status: QuestionStatus = 'pending'): QuestionItem {
  return {
    id: QID,
    displayId: 'Q-1',
    revision: 4,
    question: 'Preserve the deprecated cache option? 🧪',
    reason: 'Removing it simplifies the parser, but older configuration may break.',
    class: 'reversible',
    response: {
      kind: 'single',
      options: [
        { id: 'keep', label: 'Keep with deprecation warning' },
        { id: 'remove', label: 'Remove immediately' },
      ],
    },
    recommendation: 'Keep it for one release.',
    recommendedOptionIds: ['keep'],
    temporaryDefault: { optionIds: ['keep'], disclosure: 'Keep current behavior while waiting.' },
    priority: 'high',
    blockingPolicy: 'when_agent_settles',
    deliveryMode: 'nextTurn',
    affectedWork: ['Final parser implementation'],
    continuingWork: ['Tests and documentation'],
    attachments: [{ kind: 'file', label: 'Parser', path: 'src/config/parser.ts' }],
    status,
    createdAt: '2026-08-12T12:01:00.000Z',
    updatedAt: '2026-08-12T12:20:00.000Z',
    ...(status === 'delivery_failed' ? { answerId: AID } : {}),
    lastEventId: 'evt_75000000-0000-4000-8000-000000000001',
    lastCommandId: 'tool:question-fixture',
  } as QuestionItem;
}

function answer(): AnswerRecord {
  return {
    id: AID,
    questionId: QID,
    questionDisplayId: 'Q-1',
    questionRevision: 4,
    source: 'manual',
    value: { kind: 'single', optionId: 'keep' },
    answeredAt: '2026-08-12T12:21:00.000Z',
    deliveryStatus: 'failed',
    deliveryAttempts: [
      {
        attempt: 1,
        at: '2026-08-12T12:22:00.000Z',
        mode: 'nextTurn',
        outcome: 'failed',
        errorCode: 'SB_DELIVERY_FAILED',
      },
    ],
    lastEventId: 'evt_75000000-0000-4000-8000-000000000002',
  };
}

function update(overrides: Partial<UpdateItem> = {}): UpdateItem {
  return {
    id: UID,
    displayId: 'U-1',
    revision: 3,
    kind: 'completed',
    title: 'Parser migration completed with Unicode café 漢字',
    detail: 'All compatibility tests passed.',
    stage: 'complete',
    progress: { current: 42, total: 42, unit: 'tests' },
    attachments: [{ kind: 'test_run', label: 'Tests', reference: 'run-42' }],
    createdAt: '2026-08-12T12:02:00.000Z',
    updatedAt: '2026-08-12T12:25:00.000Z',
    completedAt: '2026-08-12T12:25:00.000Z',
    archived: false,
    lastEventId: 'evt_75000000-0000-4000-8000-000000000003',
    lastCommandId: 'tool:update-fixture',
    ...overrides,
  } as UpdateItem;
}

function workingUpdate(overrides: Partial<UpdateItem> = {}): UpdateItem {
  const { completedAt: _completedAt, ...base } = update(overrides);
  return { ...base, kind: 'working', stage: 'testing' } as UpdateItem;
}

function stateWith(
  input: {
    question?: QuestionItem;
    update?: UpdateItem;
    answer?: AnswerRecord;
    visibleChanges?: readonly VisibleChangeRecord[];
    lastViewedAt?: string;
  } = {},
): BoardState {
  const empty = createEmptyBoardState();
  return {
    ...empty,
    updates: input.update === undefined ? new Map() : new Map([[input.update.id, input.update]]),
    questions:
      input.question === undefined ? new Map() : new Map([[input.question.id, input.question]]),
    answers: input.answer === undefined ? new Map() : new Map([[input.answer.id, input.answer]]),
    visibleChanges: input.visibleChanges ?? [],
    ...(input.lastViewedAt === undefined ? {} : { lastViewedAt: input.lastViewedAt }),
  };
}

function model(
  input: Parameters<typeof stateWith>[0] = { question: question(), update: update() },
  tab?: BoardTab,
  historyLimit = 500,
): BoardViewModel {
  return buildBoardViewModel(stateWith(input), tab, OPENED_AT, {
    ...DEFAULT_CONFIG,
    limits: { ...DEFAULT_CONFIG.limits, visibleHistoryLimit: historyLimit },
    ui: { ...DEFAULT_CONFIG.ui },
    widget: { ...DEFAULT_CONFIG.widget, showCompletedForMinutes: 10 },
  });
}

function component(view = model(), selectedTheme = theme()) {
  const actions: SignalBoardAction[] = [];
  const host = { requestRender: vi.fn() };
  const board = new SignalBoardComponent({
    tui: host,
    theme: selectedTheme,
    model: view,
    done: (action) => actions.push(action),
  });
  return { board, host, actions };
}

function plain(lines: readonly string[]): string {
  return lines.join('\n');
}

function expectWidthSafe(lines: readonly string[], width: number): void {
  for (const line of lines)
    expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
}

describe('SB-027 board component rendering', () => {
  it.each([49, 50, 80, 99, 100, 160])('matches the approved width-%i golden fixture', (width) => {
    const lines = component().board.render(width);
    expectWidthSafe(lines, width);
    expect(plain(lines)).not.toContain('\u001b');
    expect(lines).toMatchSnapshot();
  });

  it.each([50, 80, 99, 100, 160])(
    'keeps every applicable footer label complete at width %i',
    (width) => {
      const output = plain(component().board.render(width));
      for (const label of [
        'Enter details',
        'A answer',
        'R recommendation',
        'X dismiss',
        'Tab/Shift+Tab view',
        '↑↓/jk move',
        '? help',
        'Esc close',
      ]) {
        expect(output).toContain(label);
      }
    },
  );

  it('renders the exact resize warning below 50 columns with width-safe wrapping', () => {
    const lines = component().board.render(49);
    expect(lines).toEqual([
      'Signal Board requires at least 50 columns. Resize',
      'the terminal or press Esc.',
    ]);
    expect(lines.join(' ')).toBe(
      'Signal Board requires at least 50 columns. Resize the terminal or press Esc.',
    );
    expectWidthSafe(lines, 49);
  });

  it('renders empty, help, unavailable, error, catch-up, and truncated History states', () => {
    const empty = component(model({}));
    expect(plain(empty.board.render(80))).toContain('No questions need attention.');

    empty.board.handleInput('?');
    const help = plain(empty.board.render(80));
    expect(help).toContain('Signal Board keys');
    expect(help).toContain('Decisions and History: read-only');

    const unavailableModel = {
      ...model({}),
      availability: boardModelFailure('ui_unavailable'),
    } as BoardViewModel;
    expect(plain(component(unavailableModel).board.render(80))).toContain('SB_UI_UNAVAILABLE');

    const errorModel = {
      ...model({}),
      availability: boardModelFailure('internal_error'),
    } as BoardViewModel;
    expect(plain(component(errorModel).board.render(80))).toContain('SIGNAL BOARD ERROR');

    const visible: VisibleChangeRecord = {
      eventId: 'evt_75000000-0000-4000-8000-000000000004',
      occurredAt: '2026-08-12T12:25:00.000Z',
      change: { kind: 'update_completed', itemId: UID, updateKind: 'completed' },
    };
    const catchUp = model({
      update: update(),
      visibleChanges: [visible],
      lastViewedAt: '2026-08-12T12:10:00.000Z',
    });
    expect(plain(component(catchUp).board.render(100))).toContain('SINCE LAST VIEWED');

    const history = model({ update: update() }, 'history', 0);
    expect(plain(component(history).board.render(80))).toContain(
      'omitted by the configured history limit',
    );
  });

  it('renders selected detail, Unicode, and hostile long content without control injection', () => {
    const hostile = question('pending');
    const hostileQuestion = {
      ...hostile,
      question: `\u001b]8;;https://bad.invalid\u0007${'漢🙂'.repeat(200)}\u001b]8;;\u0007`,
      reason: 'line one\r\nline two\u001b[31mRED',
    } as QuestionItem;
    const board = component(model({ question: hostileQuestion })).board;
    board.handleInput('\r');
    const lines = board.render(50);
    expectWidthSafe(lines, 50);
    expect(plain(lines)).not.toContain('bad.invalid');
    expect(plain(lines)).not.toContain('\u001b]');
    expect(plain(lines)).toContain('Q-1 · revision 4');
  });

  it('uses a stable two-pane left width clamp at 100 and 160 columns', () => {
    for (const width of [100, 160]) {
      const lines = component().board.render(width);
      const pane = lines.find((line) => line.includes('│'));
      expect(pane).toBeDefined();
      const left = pane?.split('│')[0] ?? '';
      expect(visibleWidth(left)).toBe(Math.max(30, Math.min(Math.floor(width * 0.38), 46)));
    }
  });

  it('is deterministic and uses visible textual semantics without color', () => {
    const board = component(model(), theme()).board;
    expect(board.render(99)).toEqual(board.render(99));
    const output = plain(board.render(99));
    expect(output).toContain('> [PENDING] Q-1');
    expect(output).toContain('[Inbox 1]');
  });

  it('keeps random Unicode and hostile titles within fixed widths with a printed seed on failure', () => {
    const seed = 0x5b027;
    let randomState = seed;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    try {
      for (let run = 0; run < 100; run += 1) {
        const length = 1 + Math.floor(random() * 500);
        const title = Array.from(
          { length },
          () => ['a', '漢', '🙂', '\u0301', '\u001b[31m'][Math.floor(random() * 5)],
        ).join('');
        const item = update({ title });
        for (const width of [49, 50, 80, 99, 100, 160]) {
          expectWidthSafe(component(model({ update: item }, 'updates')).board.render(width), width);
        }
      }
    } catch (error) {
      console.error(`board-component property seed=${seed} state=${randomState}`);
      throw error;
    }
  });
});

describe('SB-027 board component input boundary', () => {
  it('wraps keyboard navigation, cycles tabs in both directions, and requests render', () => {
    const first = update();
    const second = workingUpdate({
      id: 'upd_74000000-0000-4000-8000-000000000002' as UpdateId,
      displayId: 'U-2',
    });
    const source = stateWith({ update: first });
    const view = buildBoardViewModel(
      {
        ...source,
        updates: new Map([
          [first.id, first],
          [second.id, second],
        ]),
      },
      'updates',
      OPENED_AT,
      DEFAULT_CONFIG,
    );
    const { board, host } = component(view);

    board.handleInput('\u001b[B');
    expect(plain(board.render(80))).toContain('> [WORKING] U-2');
    board.handleInput('\u001b[A');
    expect(plain(board.render(80))).toContain('> [DONE] U-1');
    board.handleInput('j');
    expect(plain(board.render(80))).toContain('> [WORKING] U-2');
    board.handleInput('k');
    expect(plain(board.render(80))).toContain('> [DONE] U-1');
    board.handleInput('\t');
    expect(plain(board.render(80))).toContain('[Decisions 0]');
    board.handleInput('\u001b[Z');
    expect(plain(board.render(80))).toContain('[Updates 2]');
    expect(host.requestRender).toHaveBeenCalledTimes(6);
  });

  it('toggles selected detail with Enter and closes help before closing the component', () => {
    const { board, actions, host } = component();
    expect(plain(board.render(80))).not.toContain('Why:');
    board.handleInput('\r');
    expect(plain(board.render(80))).toContain('Why:');
    board.handleInput('?');
    expect(plain(board.render(80))).toContain('Signal Board keys');
    board.handleInput('\u001b');
    expect(plain(board.render(80))).not.toContain('Signal Board keys');
    expect(actions).toEqual([]);
    board.handleInput('\u001b');
    expect(actions).toEqual([{ type: 'close', tab: 'inbox' }]);
    board.handleInput('\u001b');
    expect(actions).toHaveLength(1);
    expect(host.requestRender).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a', 'answer'],
    ['A', 'answer'],
    ['r', 'accept_recommendation'],
    ['R', 'accept_recommendation'],
    ['x', 'dismiss'],
    ['X', 'dismiss'],
  ] as const)('returns %s as typed %s intent with entity and revision metadata', (key, type) => {
    const { board, actions } = component(model({ question: question('pending') }));
    board.handleInput(key);
    expect(actions).toEqual([{ type, tab: 'inbox', entityId: QID, expectedRevision: 4 }]);
  });

  it('uses full detail and valid R/Y payloads after navigation to a non-initial Inbox row', () => {
    const pendingId = 'qst_72000000-0000-4000-8000-000000000002' as QuestionId;
    const pending = {
      ...question('pending'),
      id: pendingId,
      displayId: 'Q-2',
      question: 'Use the complete second-row detail?',
      revision: 7,
      answerId: undefined,
    } as unknown as QuestionItem;
    const failed = question('delivery_failed');
    const source = stateWith({ question: failed, answer: answer() });
    const view = buildBoardViewModel(
      {
        ...source,
        questions: new Map([
          [failed.id, failed],
          [pending.id, pending],
        ]),
      },
      'inbox',
      OPENED_AT,
      DEFAULT_CONFIG,
    );

    const recommendation = component(view);
    recommendation.board.handleInput('j');
    recommendation.board.handleInput('\r');
    expect(plain(recommendation.board.render(80))).toContain(
      'Why: Removing it simplifies the parser',
    );
    expect(plain(recommendation.board.render(80))).toContain('R recommendation');
    recommendation.board.handleInput('r');
    expect(recommendation.actions).toEqual([
      {
        type: 'accept_recommendation',
        tab: 'inbox',
        entityId: pendingId,
        expectedRevision: 7,
      },
    ]);

    const retry = component(view);
    retry.board.handleInput('j');
    retry.board.handleInput('j');
    retry.board.handleInput('\r');
    expect(plain(retry.board.render(80))).toContain('Why: Removing it simplifies the parser');
    retry.board.handleInput('Y');
    expect(retry.actions).toEqual([
      {
        type: 'retry_delivery',
        tab: 'inbox',
        entityId: QID,
        expectedRevision: 4,
        answerId: AID,
      },
    ]);
  });

  it('returns retry with the stable answer ID and update archive with revision metadata', () => {
    const retry = component(model({ question: question('delivery_failed'), answer: answer() }));
    retry.board.handleInput('y');
    expect(retry.actions).toEqual([
      {
        type: 'retry_delivery',
        tab: 'inbox',
        entityId: QID,
        expectedRevision: 4,
        answerId: AID,
      },
    ]);

    const archive = component(model({ update: update() }, 'updates'));
    archive.board.handleInput('H');
    expect(archive.actions).toEqual([
      {
        type: 'archive_update',
        tab: 'updates',
        entityId: UID,
        expectedRevision: 3,
      },
    ]);
  });

  it('does not return unavailable contextual actions or actions from read-only tabs', () => {
    const sent = component(model({ question: question('answered') }));
    for (const key of ['a', 'r', 'x', 'y', 'h']) sent.board.handleInput(key);
    expect(sent.actions).toEqual([]);

    const invalidRecommendation = {
      ...question('pending'),
      recommendedOptionIds: ['missing'],
    } as QuestionItem;
    const invalid = component(model({ question: invalidRecommendation }));
    expect(plain(invalid.board.render(80))).not.toContain('R recommendation');
    invalid.board.handleInput('r');
    expect(invalid.actions).toEqual([]);

    const malformedHybrid = {
      ...question('pending'),
      response: { kind: 'single_or_text', options: question().response.options },
      recommendedOptionIds: ['keep'],
      recommendedText: '  not normalized  ',
    } as QuestionItem;
    const malformed = component(model({ question: malformedHybrid }));
    expect(plain(malformed.board.render(80))).not.toContain('R recommendation');
    malformed.board.handleInput('r');
    expect(malformed.actions).toEqual([]);

    const active = component(model({ update: workingUpdate() }, 'updates'));
    active.board.handleInput('h');
    expect(active.actions).toEqual([]);

    for (const tab of ['decisions', 'history'] as const) {
      const readOnly = component(model({ update: update() }, tab));
      for (const key of ['a', 'r', 'x', 'y', 'h']) readOnly.board.handleInput(key);
      expect(readOnly.actions).toEqual([]);
    }
  });

  it('releases completion and host references after close and creates no handlers or timers', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    for (let run = 0; run < 100; run += 1) {
      const instance = component();
      instance.board.handleInput('\u001b');
      instance.board.invalidate();
      instance.board.dispose();
      expect(instance.actions).toHaveLength(1);
      expect(instance.host.requestRender).not.toHaveBeenCalled();
    }
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('re-renders with the current theme after invalidate and does not retain pre-baked content', () => {
    let prefix = 'OLD:';
    const mutableTheme = {
      fg: (_color: string, text: string) => `${prefix}${text}`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const { board, host } = component(model(), mutableTheme);
    expect(plain(board.render(80))).toContain('OLD:SIGNAL');
    prefix = 'NEW:';
    board.invalidate();
    expect(plain(board.render(80))).toContain('NEW:SIGNAL');
    expect(plain(board.render(80))).not.toContain('OLD:');
    expect(host.requestRender).toHaveBeenCalledOnce();
  });
});
