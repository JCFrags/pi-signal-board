import { describe, expect, it } from 'vitest';

import {
  collectMultipleAnswerIntent,
  type ManualAnswerIntent,
} from '../../src/commands/answer-actions.js';
import type { QuestionId } from '../../src/domain/ids.js';
import type { QuestionItem } from '../../src/domain/types.js';
import { FakePiHarness } from '../helpers/index.js';

const QUESTION_ID = 'qst_10000000-0000-4000-8000-000000000032' as QuestionId;

function question(
  kind: 'multiple' | 'multiple_or_text',
  overrides: Partial<QuestionItem> = {},
): QuestionItem {
  return {
    id: QUESTION_ID,
    displayId: 'Q-32',
    revision: 3,
    status: 'pending',
    question: 'Select supported systems.',
    reason: 'The build matrix needs a stable set.',
    class: 'preference',
    response: {
      kind,
      options: [
        { id: 'linux', label: 'Linux' },
        { id: 'macos', label: 'macOS' },
        { id: 'windows', label: 'Windows' },
      ],
    },
    recommendedOptionIds: [],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    lastEventId: 'evt_10000000-0000-4000-8000-000000000032',
    lastCommandId: 'tool:create-32',
    ...overrides,
  } as QuestionItem;
}

function intent(
  result: Awaited<ReturnType<typeof collectMultipleAnswerIntent>>,
): ManualAnswerIntent {
  expect(result.kind).toBe('intent');
  if (result.kind !== 'intent') throw new Error(`Expected intent, received ${result.kind}`);
  return result.intent;
}

function calls(harness: FakePiHarness, surface: string) {
  return harness.uiCalls.filter((entry) => entry.surface === surface);
}

describe('SB-032 multiple answer coordinator', () => {
  it('returns a multiple-only manual intent normalized to schema order', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('custom', { kind: 'submit', optionIds: ['windows', 'linux'] });
    const answer = intent(
      await collectMultipleAnswerIntent(harness.context(), question('multiple'), 3),
    );
    expect(answer).toEqual({
      questionId: QUESTION_ID,
      expectedRevision: 3,
      source: 'manual',
      value: { kind: 'multiple', optionIds: ['linux', 'windows'] },
    });
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(answer.value)).toBe(true);
    expect(Object.isFrozen((answer.value as { optionIds: readonly string[] }).optionIds)).toBe(
      true,
    );
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('supports text-only multiple_or_text with accepted normalization and limits', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('custom', { kind: 'text', optionIds: [] });
    harness.queueUiResult('editor', '  alpha\r\nbeta 😀  ');
    expect(
      intent(await collectMultipleAnswerIntent(harness.context(), question('multiple_or_text'), 3))
        .value,
    ).toEqual({ kind: 'multiple_or_text', optionIds: [], text: 'alpha\nbeta 😀' });
    expect(calls(harness, 'confirm')).toHaveLength(0);
  });

  it('confirms a combined value and preserves entries when confirmation is cancelled', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('custom', { kind: 'text', optionIds: ['windows'] });
    harness.queueUiResult('editor', 'Use the compatibility runner.');
    harness.queueUiResult('confirm', false);
    harness.queueUiResult('custom', { kind: 'submit', optionIds: ['windows'] });
    harness.queueUiResult('confirm', true);

    const answer = intent(
      await collectMultipleAnswerIntent(harness.context(), question('multiple_or_text'), 3),
    );
    expect(answer.value).toEqual({
      kind: 'multiple_or_text',
      optionIds: ['windows'],
      text: 'Use the compatibility runner.',
    });
    expect(calls(harness, 'custom')).toHaveLength(2);
    expect(calls(harness, 'editor')).toHaveLength(1);
    expect(calls(harness, 'confirm')).toHaveLength(2);
  });

  it('returns to selection after editor cancellation without losing selected options', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('custom', { kind: 'text', optionIds: ['macos'] });
    harness.queueUiResult('editor', undefined);
    harness.queueUiResult('custom', { kind: 'submit', optionIds: ['macos'] });
    expect(
      intent(await collectMultipleAnswerIntent(harness.context(), question('multiple_or_text'), 3))
        .value,
    ).toEqual({ kind: 'multiple_or_text', optionIds: ['macos'] });
    expect(calls(harness, 'custom')).toHaveLength(2);
  });

  it.each(['', '   ', '😀'.repeat(4_001)])(
    'rejects invalid hybrid editor text %#',
    async (text) => {
      const harness = new FakePiHarness();
      harness.queueUiResult('custom', { kind: 'text', optionIds: [] });
      harness.queueUiResult('editor', text);
      expect(
        await collectMultipleAnswerIntent(harness.context(), question('multiple_or_text'), 3),
      ).toEqual({ kind: 'invalid', code: 'SB_INVALID_ARGUMENT' });
      expect(calls(harness, 'notify')).toHaveLength(1);
    },
  );

  it('accepts exactly 4,000 Unicode code points', async () => {
    const harness = new FakePiHarness();
    const text = '😀'.repeat(4_000);
    harness.queueUiResult('custom', { kind: 'text', optionIds: [] });
    harness.queueUiResult('editor', text);
    expect(
      intent(await collectMultipleAnswerIntent(harness.context(), question('multiple_or_text'), 3))
        .value,
    ).toEqual({ kind: 'multiple_or_text', optionIds: [], text });
  });

  it.each([
    { kind: 'submit', optionIds: [] },
    { kind: 'submit', optionIds: ['linux', 'linux'] },
    { kind: 'submit', optionIds: ['unknown'] },
    { kind: 'submit', optionIds: 'linux' },
    { kind: 'text', optionIds: [] },
    { kind: 'other', optionIds: ['linux'] },
    null,
    4,
  ])('rejects no-selection, duplicate, unknown, and malformed host result %#', async (result) => {
    const harness = new FakePiHarness();
    harness.queueUiResult('custom', result);
    expect(await collectMultipleAnswerIntent(harness.context(), question('multiple'), 3)).toEqual({
      kind: 'invalid',
      code: 'SB_INVALID_ARGUMENT',
    });
  });

  it('cancels Escape/host cancellation with no intent or mutation', async () => {
    for (const result of [undefined, { kind: 'cancelled' }]) {
      const harness = new FakePiHarness();
      harness.queueUiResult('custom', result);
      expect(await collectMultipleAnswerIntent(harness.context(), question('multiple'), 3)).toEqual(
        {
          kind: 'cancelled',
        },
      );
      expect(harness.appendCalls).toHaveLength(0);
      expect(harness.sendCalls).toHaveLength(0);
    }
  });

  it('returns stable unavailable results for missing, stale, non-TUI, and thrown UI', async () => {
    const harness = new FakePiHarness();
    expect(await collectMultipleAnswerIntent(harness.context(), undefined, 3)).toEqual({
      kind: 'unavailable',
      code: 'SB_NOT_FOUND',
    });
    expect(await collectMultipleAnswerIntent(harness.context(), question('multiple'), 2)).toEqual({
      kind: 'unavailable',
      code: 'SB_REVISION_MISMATCH',
    });
    const print = new FakePiHarness({ mode: 'print' });
    expect(await collectMultipleAnswerIntent(print.context(), question('multiple'), 3)).toEqual({
      kind: 'unavailable',
      code: 'SB_UI_UNAVAILABLE',
    });
    harness.failNextUi('custom', new Error('private content'));
    expect(await collectMultipleAnswerIntent(harness.context(), question('multiple'), 3)).toEqual({
      kind: 'unavailable',
      code: 'SB_UI_UNAVAILABLE',
    });
  });

  it('contains editor and confirmation throws and malformed confirmation results', async () => {
    const editor = new FakePiHarness();
    editor.queueUiResult('custom', { kind: 'text', optionIds: [] });
    editor.failNextUi('editor', new Error('private'));
    expect(
      await collectMultipleAnswerIntent(editor.context(), question('multiple_or_text'), 3),
    ).toEqual({ kind: 'unavailable', code: 'SB_UI_UNAVAILABLE' });

    const confirm = new FakePiHarness();
    confirm.queueUiResult('custom', { kind: 'text', optionIds: ['linux'] });
    confirm.queueUiResult('editor', 'text');
    confirm.failNextUi('confirm', new Error('private'));
    expect(
      await collectMultipleAnswerIntent(confirm.context(), question('multiple_or_text'), 3),
    ).toEqual({ kind: 'unavailable', code: 'SB_UI_UNAVAILABLE' });

    const malformed = new FakePiHarness();
    malformed.queueUiResult('custom', { kind: 'text', optionIds: ['linux'] });
    malformed.queueUiResult('editor', 'text');
    malformed.queueUiResult('confirm', 'yes');
    expect(
      await collectMultipleAnswerIntent(malformed.context(), question('multiple_or_text'), 3),
    ).toEqual({ kind: 'invalid', code: 'SB_INVALID_ARGUMENT' });
  });

  it('reopens 100 times without persistence, messages, or retained interaction state', async () => {
    const harness = new FakePiHarness();
    for (let run = 0; run < 100; run += 1) {
      harness.queueUiResult(
        'custom',
        run % 2 === 0 ? { kind: 'submit', optionIds: ['linux'] } : undefined,
      );
      const result = await collectMultipleAnswerIntent(harness.context(), question('multiple'), 3);
      expect(result.kind).toBe(run % 2 === 0 ? 'intent' : 'cancelled');
    }
    expect(calls(harness, 'custom')).toHaveLength(100);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('normalizes fixed-seed option permutations and prints the seed on failure', async () => {
    const seed = 0x5b032;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    try {
      for (let run = 0; run < 200; run += 1) {
        const ids = ['linux', 'macos', 'windows'].filter(() => (next() & 1) === 1);
        if (ids.length === 0) ids.push('linux');
        ids.sort(() => (next() & 1) * 2 - 1);
        const harness = new FakePiHarness();
        harness.queueUiResult('custom', { kind: 'submit', optionIds: ids });
        const value = intent(
          await collectMultipleAnswerIntent(harness.context(), question('multiple'), 3),
        ).value as { readonly optionIds: readonly string[] };
        expect(value.optionIds, `seed=${seed} case=${run}`).toEqual(
          ['linux', 'macos', 'windows'].filter((id) => ids.includes(id)),
        );
      }
    } catch (error) {
      console.error(`multiple-answer property seed=${seed} state=${state}`);
      throw error;
    }
  });
});
