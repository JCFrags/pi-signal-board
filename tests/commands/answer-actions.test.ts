import { describe, expect, it } from 'vitest';

import {
  collectSingleTextAnswerIntent,
  type ManualAnswerIntent,
} from '../../src/commands/answer-actions.js';
import type { QuestionId } from '../../src/domain/ids.js';
import type { QuestionItem, ResponseKind } from '../../src/domain/types.js';
import { FakePiHarness } from '../helpers/index.js';

const QUESTION_ID = 'qst_10000000-0000-4000-8000-000000000031' as QuestionId;

function question(kind: ResponseKind, overrides: Partial<QuestionItem> = {}): QuestionItem {
  const optionKind = kind !== 'text';
  return {
    id: QUESTION_ID,
    displayId: 'Q-31',
    revision: 2,
    status: 'pending',
    question: 'Choose a safe shape.',
    reason: 'Independent work can continue.',
    class: 'preference',
    response: optionKind
      ? {
          kind,
          options: [
            { id: 'first', label: 'First choice' },
            { id: 'second', label: 'Second choice' },
          ],
        }
      : { kind: 'text', options: [] },
    recommendation: 'The first choice is simpler.',
    recommendedOptionIds: optionKind ? ['first'] : [],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    lastEventId: 'evt_10000000-0000-4000-8000-000000000031',
    lastCommandId: 'tool:create-31',
    ...overrides,
  } as QuestionItem;
}

function intent(
  result: Awaited<ReturnType<typeof collectSingleTextAnswerIntent>>,
): ManualAnswerIntent {
  expect(result.kind).toBe('intent');
  if (result.kind !== 'intent') throw new Error(`Expected intent, received ${result.kind}`);
  return result.intent;
}

function calls(harness: FakePiHarness, surface: string) {
  return harness.uiCalls.filter((entry) => entry.surface === surface);
}

describe('SB-031 single and text answer interaction', () => {
  it.each([
    ['first', { kind: 'single', optionId: 'first' }],
    ['second', { kind: 'single', optionId: 'second' }],
  ] as const)('returns one manual single intent for the %s option', async (selected, value) => {
    const harness = new FakePiHarness();
    const item = question('single');
    const label = selected === 'first' ? 'First choice — Agent recommendation' : 'Second choice';
    harness.queueUiResult('select', label);

    const answer = intent(await collectSingleTextAnswerIntent(harness.context(), item, 2));

    expect(answer).toEqual({
      questionId: QUESTION_ID,
      expectedRevision: 2,
      source: 'manual',
      value,
    });
    expect(calls(harness, 'select')[0]?.args).toEqual([
      'Answer Q-31 (revision 2)',
      ['First choice — Agent recommendation', 'Second choice'],
    ]);
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(answer.value)).toBe(true);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('marks only a valid exact option recommendation and never changes source', async () => {
    const harness = new FakePiHarness();
    const item = question('single_or_text', { recommendedText: 'Add context.' });
    harness.queueUiResult('select', 'First choice');
    const answer = intent(await collectSingleTextAnswerIntent(harness.context(), item, 2));
    expect(answer.source).toBe('manual');
    expect(calls(harness, 'select')[0]?.args[1]).toEqual([
      'First choice',
      'Second choice',
      'Write another answer…',
    ]);
  });

  it('supports the option and explicit text branches of single_or_text', async () => {
    const optionHarness = new FakePiHarness();
    optionHarness.queueUiResult('select', 'Second choice');
    expect(
      intent(
        await collectSingleTextAnswerIntent(optionHarness.context(), question('single_or_text'), 2),
      ).value,
    ).toEqual({ kind: 'single_or_text', optionId: 'second' });

    const textHarness = new FakePiHarness();
    textHarness.queueUiResult('select', 'Write another answer…');
    textHarness.queueUiResult('editor', '  first\r\nsecond\rthird  ');
    expect(
      intent(
        await collectSingleTextAnswerIntent(textHarness.context(), question('single_or_text'), 2),
      ).value,
    ).toEqual({ kind: 'single_or_text', text: 'first\nsecond\nthird' });
  });

  it('normalizes outer whitespace and line endings while preserving internal newlines', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('editor', '\t alpha \r\n\r beta \r gamma \n\t');
    const answer = intent(
      await collectSingleTextAnswerIntent(harness.context(), question('text'), 2),
    );
    expect(answer.value).toEqual({ kind: 'text', text: 'alpha \n\n beta \n gamma' });
    expect(calls(harness, 'editor')[0]?.args).toEqual(['Answer Q-31 (revision 2)', '']);
  });

  it('accepts the 4,000-code-point limit and Unicode by code point', async () => {
    const harness = new FakePiHarness();
    const boundary = '😀'.repeat(4_000);
    harness.queueUiResult('editor', boundary);
    expect(
      intent(await collectSingleTextAnswerIntent(harness.context(), question('text'), 2)).value,
    ).toEqual({ kind: 'text', text: boundary });
  });

  it.each(['', '   ', '\r\n\t', '😀'.repeat(4_001)])(
    'rejects empty or over-limit text safely for case %#',
    async (value) => {
      const harness = new FakePiHarness();
      harness.queueUiResult('editor', value);
      const result = await collectSingleTextAnswerIntent(harness.context(), question('text'), 2);
      expect(result).toEqual({ kind: 'invalid', code: 'SB_INVALID_ARGUMENT' });
      expect(calls(harness, 'notify')).toEqual([
        {
          surface: 'notify',
          args: ['Answer is empty or exceeds the supported limit. No answer was saved.', 'warning'],
        },
      ]);
      expect(harness.appendCalls).toHaveLength(0);
      expect(harness.sendCalls).toHaveLength(0);
    },
  );

  it('contains notification failure after invalid text', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('editor', '   ');
    harness.failNextUi('notify', new Error('private notification failure'));
    await expect(
      collectSingleTextAnswerIntent(harness.context(), question('text'), 2),
    ).resolves.toEqual({ kind: 'invalid', code: 'SB_INVALID_ARGUMENT' });
  });

  it('cancels select and editor without intent, notification, or mutation', async () => {
    for (const kind of ['single', 'text'] as const) {
      const harness = new FakePiHarness();
      const result = await collectSingleTextAnswerIntent(harness.context(), question(kind), 2);
      expect(result).toEqual({ kind: 'cancelled' });
      expect(calls(harness, 'notify')).toHaveLength(0);
      expect(harness.appendCalls).toHaveLength(0);
      expect(harness.sendCalls).toHaveLength(0);
    }
  });

  it('treats editor cancellation after the hybrid text action as cancellation', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('select', 'Write another answer…');
    expect(
      await collectSingleTextAnswerIntent(harness.context(), question('single_or_text'), 2),
    ).toEqual({ kind: 'cancelled' });
  });

  it.each([null, 3, {}, 'not-an-option'])(
    'rejects invalid host selection result %#',
    async (value) => {
      const harness = new FakePiHarness();
      harness.queueUiResult('select', value);
      expect(await collectSingleTextAnswerIntent(harness.context(), question('single'), 2)).toEqual(
        { kind: 'invalid', code: 'SB_INVALID_ARGUMENT' },
      );
    },
  );

  it.each([null, 3, {}])('rejects invalid host editor result %#', async (value) => {
    const harness = new FakePiHarness();
    harness.queueUiResult('editor', value);
    expect(await collectSingleTextAnswerIntent(harness.context(), question('text'), 2)).toEqual({
      kind: 'invalid',
      code: 'SB_INVALID_ARGUMENT',
    });
  });

  it('disambiguates duplicate and reserved labels while preserving option IDs', async () => {
    const harness = new FakePiHarness();
    const item = question('single_or_text', {
      response: {
        kind: 'single_or_text',
        options: [
          { id: 'first', label: 'Write another answer…' },
          { id: 'second', label: 'Write another answer…' },
        ],
      },
      recommendedOptionIds: [],
    });
    harness.queueUiResult('select', 'Write another answer… [second]');
    expect(intent(await collectSingleTextAnswerIntent(harness.context(), item, 2)).value).toEqual({
      kind: 'single_or_text',
      optionId: 'second',
    });
    expect(calls(harness, 'select')[0]?.args[1]).toEqual([
      'Write another answer… [first]',
      'Write another answer… [second]',
      'Write another answer…',
    ]);
  });

  it('returns stable results for missing, stale, unsupported, and malformed detail', async () => {
    const harness = new FakePiHarness();
    expect(await collectSingleTextAnswerIntent(harness.context(), undefined, 2)).toEqual({
      kind: 'unavailable',
      code: 'SB_NOT_FOUND',
    });
    expect(await collectSingleTextAnswerIntent(harness.context(), question('single'), 1)).toEqual({
      kind: 'unavailable',
      code: 'SB_REVISION_MISMATCH',
    });
    expect(
      await collectSingleTextAnswerIntent(
        harness.context(),
        question('single', { status: 'stale' }),
        2,
      ),
    ).toEqual({ kind: 'unavailable', code: 'SB_REVISION_MISMATCH' });
    expect(await collectSingleTextAnswerIntent(harness.context(), question('multiple'), 2)).toEqual(
      { kind: 'unavailable', code: 'SB_UI_UNAVAILABLE' },
    );
    expect(
      await collectSingleTextAnswerIntent(
        harness.context(),
        question('single', { response: { kind: 'single', options: [] } }),
        2,
      ),
    ).toEqual({ kind: 'invalid', code: 'SB_INVALID_ARGUMENT' });
  });

  it('fails safely when UI is unavailable or either dialog throws', async () => {
    const unavailable = new FakePiHarness({ mode: 'print' });
    expect(
      await collectSingleTextAnswerIntent(unavailable.context(), question('single'), 2),
    ).toEqual({ kind: 'unavailable', code: 'SB_UI_UNAVAILABLE' });

    for (const kind of ['single', 'text'] as const) {
      const harness = new FakePiHarness();
      harness.failNextUi(kind === 'single' ? 'select' : 'editor', new Error('private content'));
      expect(await collectSingleTextAnswerIntent(harness.context(), question(kind), 2)).toEqual({
        kind: 'unavailable',
        code: 'SB_UI_UNAVAILABLE',
      });
    }
  });

  it('does not depend on ANSI color and releases all interaction state between calls', async () => {
    const harness = new FakePiHarness();
    for (let run = 0; run < 100; run += 1) {
      harness.queueUiResult(
        'select',
        run % 2 === 0 ? 'First choice — Agent recommendation' : undefined,
      );
      const result = await collectSingleTextAnswerIntent(harness.context(), question('single'), 2);
      expect(result.kind).toBe(run % 2 === 0 ? 'intent' : 'cancelled');
    }
    expect(calls(harness, 'select')).toHaveLength(100);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('validates fixed-seed option returns without selecting a default', async () => {
    const seed = 0x5b031;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    try {
      for (let run = 0; run < 500; run += 1) {
        const harness = new FakePiHarness();
        const selected = next() % 3;
        if (selected < 2) {
          harness.queueUiResult(
            'select',
            selected === 0 ? 'First choice — Agent recommendation' : 'Second choice',
          );
        }
        const result = await collectSingleTextAnswerIntent(
          harness.context(),
          question('single'),
          2,
        );
        expect(result.kind, `seed=${seed} case=${run}`).toBe(selected < 2 ? 'intent' : 'cancelled');
      }
    } catch (error) {
      console.error(`answer-actions property seed=${seed} state=${state}`);
      throw error;
    }
  });
});
