import { describe, expect, it, vi } from 'vitest';

import {
  confirmArchiveUpdate,
  confirmDismissQuestion,
} from '../../src/commands/dismiss-archive-actions.js';
import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type {
  QuestionItem,
  QuestionStatus,
  UpdateItem,
  UpdateKind,
} from '../../src/domain/types.js';
import { FakePiHarness } from '../helpers/index.js';

const QUESTION_ID = 'qst_34000000-0000-4000-8000-000000000001' as const;
const UPDATE_ID = 'upd_34000000-0000-4000-8000-000000000001' as const;
const NOW = '2026-08-12T14:34:00.000Z';
const COMMAND = 'ui:34000000-0000-4000-8000-000000000001' as const;

function question(status: QuestionStatus = 'pending', displayId = 'Q-34'): QuestionItem {
  return {
    id: QUESTION_ID,
    displayId,
    revision: 7,
    status,
    question: 'Private question content',
    reason: 'Private reason content',
    class: 'preference',
    response: {
      kind: 'single',
      options: [
        { id: 'first', label: 'First' },
        { id: 'second', label: 'Second' },
      ],
    },
    recommendedOptionIds: [],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'nextTurn',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    createdAt: '2026-08-12T14:00:00.000Z',
    updatedAt: '2026-08-12T14:00:00.000Z',
    lastEventId: 'evt_34000000-0000-4000-8000-000000000001',
    lastCommandId: 'tool:create-34',
  } as QuestionItem;
}

function update(kind: UpdateKind = 'completed', displayId = 'U-34'): UpdateItem {
  return {
    id: UPDATE_ID,
    displayId,
    revision: 5,
    kind,
    title: 'Private update content',
    stage: kind === 'completed' ? 'complete' : 'testing',
    attachments: [],
    createdAt: '2026-08-12T14:00:00.000Z',
    updatedAt: '2026-08-12T14:20:00.000Z',
    ...(kind === 'completed' || kind === 'failed'
      ? { completedAt: '2026-08-12T14:20:00.000Z' }
      : {}),
    archived: false,
    lastEventId: 'evt_34000000-0000-4000-8000-000000000002',
    lastCommandId: 'tool:update-34',
  } as UpdateItem;
}

function successValue(item: QuestionItem | UpdateItem) {
  return succeed({ item, noOp: false, event: undefined } as never);
}

describe('SB-034 dismissal confirmation coordinator', () => {
  it.each(['pending', 'blocking'] as const)(
    'confirms and calls the accepted service exactly once for a %s question',
    async (status) => {
      const harness = new FakePiHarness();
      harness.queueUiResult('confirm', true);
      const service = vi.fn(async () => successValue(question(status)));

      expect(
        await confirmDismissQuestion({
          context: harness.context(),
          question: question(status),
          expectedRevision: 7,
          now: () => new Date(NOW),
          commandId: () => COMMAND,
          dismissQuestion: service,
        }),
      ).toEqual({ kind: 'success' });
      expect(service).toHaveBeenCalledOnce();
      expect(service).toHaveBeenCalledWith({
        commandId: COMMAND,
        id: QUESTION_ID,
        expectedRevision: 7,
        dismissedAt: NOW,
        reason: 'user_dismissed',
        source: 'board',
      });
      expect(harness.appendCalls).toHaveLength(0);
      expect(harness.sendCalls).toHaveLength(0);
    },
  );

  it('shows a safe display ID and item type, and cancellation makes no service call', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('confirm', false);
    const service = vi.fn(async () => successValue(question()));
    const item = question('pending', 'Q-34\u001b]8;;https://bad.invalid\u0007');

    expect(
      await confirmDismissQuestion({
        context: harness.context(),
        question: item,
        expectedRevision: 7,
        now: () => new Date(NOW),
        commandId: () => COMMAND,
        dismissQuestion: service,
      }),
    ).toEqual({ kind: 'cancelled' });
    expect(service).not.toHaveBeenCalled();
    const args = harness.uiCalls.find((call) => call.surface === 'confirm')?.args ?? [];
    expect(args[0]).toBe('Dismiss Q-34?');
    expect(args[1]).toContain('Item type: question');
    expect(args[1]).toContain('Nothing will be sent to the agent');
    expect(JSON.stringify(args)).not.toContain('bad.invalid');
    expect(JSON.stringify(args)).not.toContain('Private question');
  });

  it('contains missing detail, stale revision, malformed confirmation, clock, ID, and service failures', async () => {
    const missing = new FakePiHarness();
    const service = vi.fn(async () => successValue(question()));
    const base = {
      context: missing.context(),
      question: question(),
      expectedRevision: 7,
      now: () => new Date(NOW),
      commandId: () => COMMAND,
      dismissQuestion: service,
    };
    expect(await confirmDismissQuestion({ ...base, question: undefined })).toEqual({
      kind: 'unavailable',
      code: 'SB_NOT_FOUND',
    });
    expect(await confirmDismissQuestion({ ...base, expectedRevision: 6 })).toEqual({
      kind: 'unavailable',
      code: 'SB_REVISION_MISMATCH',
    });

    missing.queueUiResult('confirm', 'yes');
    expect(await confirmDismissQuestion(base)).toEqual({
      kind: 'unavailable',
      code: 'SB_INVALID_ARGUMENT',
    });
    missing.queueUiResult('confirm', true);
    expect(await confirmDismissQuestion({ ...base, now: () => new Date(Number.NaN) })).toEqual({
      kind: 'unavailable',
      code: 'SB_INTERNAL',
    });
    missing.queueUiResult('confirm', true);
    expect(
      await confirmDismissQuestion({
        ...base,
        commandId: () => {
          throw new Error('private ID state');
        },
      }),
    ).toEqual({ kind: 'unavailable', code: 'SB_INTERNAL' });
    missing.queueUiResult('confirm', true);
    expect(
      await confirmDismissQuestion({
        ...base,
        dismissQuestion: async () => {
          throw new Error('private service state');
        },
      }),
    ).toEqual({ kind: 'unavailable', code: 'SB_INTERNAL' });
    expect(service).not.toHaveBeenCalled();
  });

  it.each(['answered', 'cancelled', 'stale', 'resolved', 'dismissed'] as const)(
    'rejects terminal or answered status %s before the dialog',
    async (status) => {
      const harness = new FakePiHarness();
      const service = vi.fn(async () => successValue(question(status)));
      expect(
        await confirmDismissQuestion({
          context: harness.context(),
          question: question(status),
          expectedRevision: 7,
          now: () => new Date(NOW),
          commandId: () => COMMAND,
          dismissQuestion: service,
        }),
      ).toEqual({ kind: 'unavailable', code: 'SB_STATE_CONFLICT' });
      expect(service).not.toHaveBeenCalled();
      expect(harness.uiCalls).toHaveLength(0);
    },
  );
});

describe('SB-034 archive confirmation coordinator', () => {
  it.each(['completed', 'failed'] as const)(
    'confirms and calls the accepted service exactly once for a %s update',
    async (kind) => {
      const harness = new FakePiHarness();
      harness.queueUiResult('confirm', true);
      const service = vi.fn(async () => successValue(update(kind)));

      expect(
        await confirmArchiveUpdate({
          context: harness.context(),
          update: update(kind),
          expectedRevision: 5,
          now: () => new Date(NOW),
          commandId: () => COMMAND,
          archiveFromUi: service,
        }),
      ).toEqual({ kind: 'success' });
      expect(service).toHaveBeenCalledOnce();
      expect(service).toHaveBeenCalledWith({
        commandId: COMMAND,
        id: UPDATE_ID,
        expectedRevision: 5,
        archivedAt: NOW,
        source: 'board',
      });
      expect(harness.sendCalls).toHaveLength(0);
    },
  );

  it('cancels without mutation and rejects non-terminal or archived updates', async () => {
    const cancelled = new FakePiHarness();
    cancelled.queueUiResult('confirm', false);
    const service = vi.fn(async () => successValue(update()));
    expect(
      await confirmArchiveUpdate({
        context: cancelled.context(),
        update: update(),
        expectedRevision: 5,
        now: () => new Date(NOW),
        commandId: () => COMMAND,
        archiveFromUi: service,
      }),
    ).toEqual({ kind: 'cancelled' });
    expect(service).not.toHaveBeenCalled();

    for (const item of [update('working'), { ...update(), archived: true } as UpdateItem]) {
      expect(
        await confirmArchiveUpdate({
          context: cancelled.context(),
          update: item,
          expectedRevision: 5,
          now: () => new Date(NOW),
          commandId: () => COMMAND,
          archiveFromUi: service,
        }),
      ).toEqual({ kind: 'unavailable', code: 'SB_STATE_CONFLICT' });
    }
    expect(service).not.toHaveBeenCalled();
  });

  it('contains stale revisions, persistence failures, unavailable UI, and dialog throws', async () => {
    const stale = new FakePiHarness();
    const service = vi.fn(async () => fail(signalBoardError('SB_PERSISTENCE_FAILED')));
    expect(
      await confirmArchiveUpdate({
        context: stale.context(),
        update: update(),
        expectedRevision: 4,
        now: () => new Date(NOW),
        commandId: () => COMMAND,
        archiveFromUi: service,
      }),
    ).toEqual({ kind: 'unavailable', code: 'SB_REVISION_MISMATCH' });

    stale.queueUiResult('confirm', true);
    expect(
      await confirmArchiveUpdate({
        context: stale.context(),
        update: update(),
        expectedRevision: 5,
        now: () => new Date(NOW),
        commandId: () => COMMAND,
        archiveFromUi: service,
      }),
    ).toEqual({ kind: 'unavailable', code: 'SB_PERSISTENCE_FAILED' });
    expect(service).toHaveBeenCalledOnce();

    const print = new FakePiHarness({ mode: 'print' });
    expect(
      await confirmArchiveUpdate({
        context: print.context(),
        update: update(),
        expectedRevision: 5,
        now: () => new Date(NOW),
        commandId: () => COMMAND,
        archiveFromUi: service,
      }),
    ).toEqual({ kind: 'unavailable', code: 'SB_UI_UNAVAILABLE' });

    const thrown = new FakePiHarness();
    thrown.failNextUi('confirm', new Error('private update content'));
    expect(
      await confirmArchiveUpdate({
        context: thrown.context(),
        update: update(),
        expectedRevision: 5,
        now: () => new Date(NOW),
        commandId: () => COMMAND,
        archiveFromUi: service,
      }),
    ).toEqual({ kind: 'unavailable', code: 'SB_UI_UNAVAILABLE' });
  });

  it('releases invocation state and checks fixed-seed terminal cases with seed output', async () => {
    const seed = 0x5b034;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      for (let run = 0; run < 200; run += 1) {
        const terminal = (next() & 1) === 1;
        const harness = new FakePiHarness();
        if (terminal) harness.queueUiResult('confirm', run % 2 === 0);
        const service = vi.fn(async () => successValue(update('completed')));
        const result = await confirmArchiveUpdate({
          context: harness.context(),
          update: update(terminal ? 'completed' : 'working'),
          expectedRevision: 5,
          now: () => new Date(NOW),
          commandId: () => COMMAND,
          archiveFromUi: service,
        });
        expect(result.kind, `seed=${seed} case=${run}`).toBe(
          terminal ? (run % 2 === 0 ? 'success' : 'cancelled') : 'unavailable',
        );
      }
    } catch (error) {
      console.error(`dismiss-archive-actions property seed=${seed} state=${state}`);
      throw error;
    } finally {
      expect(timer).not.toHaveBeenCalled();
      timer.mockRestore();
    }
  });
});
