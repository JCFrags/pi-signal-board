import { describe, expect, it } from 'vitest';

import {
  collectRecommendationIntent,
  type RecommendationAnswerIntent,
} from '../../src/commands/answer-actions.js';
import type { QuestionId } from '../../src/domain/ids.js';
import type { QuestionItem, ResponseKind } from '../../src/domain/types.js';
import { FakePiHarness } from '../helpers/index.js';

const QUESTION_ID = 'qst_10000000-0000-4000-8000-000000000033' as QuestionId;

function question(kind: ResponseKind, overrides: Partial<QuestionItem> = {}): QuestionItem {
  const options =
    kind === 'text'
      ? []
      : [
          { id: 'first', label: 'First choice' },
          { id: 'second', label: 'Second choice' },
          { id: 'third', label: 'Third choice' },
        ];
  return {
    id: QUESTION_ID,
    displayId: 'Q-33',
    revision: 5,
    status: 'pending',
    question: 'Accept the exact recommendation?',
    reason: 'The writer boundary needs an explicit choice.',
    class: 'preference',
    response: { kind, options },
    recommendation: 'Use the proposed value.',
    recommendedOptionIds:
      kind === 'single' || kind === 'single_or_text'
        ? ['second']
        : kind === 'multiple' || kind === 'multiple_or_text'
          ? ['first', 'third']
          : [],
    ...(kind === 'text' || kind === 'single_or_text' || kind === 'multiple_or_text'
      ? { recommendedText: 'normalized\ntext' }
      : {}),
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    lastEventId: 'evt_10000000-0000-4000-8000-000000000033',
    lastCommandId: 'tool:create-33',
    ...overrides,
  } as QuestionItem;
}

function recommendation(
  result: Awaited<ReturnType<typeof collectRecommendationIntent>>,
): RecommendationAnswerIntent {
  expect(result.kind).toBe('intent');
  if (result.kind !== 'intent' || result.intent.source !== 'recommendation') {
    throw new Error(`Expected recommendation intent, received ${result.kind}`);
  }
  return result.intent;
}

function calls(harness: FakePiHarness, surface: string) {
  return harness.uiCalls.filter((entry) => entry.surface === surface);
}

describe('SB-033 recommendation acceptance coordinator', () => {
  it.each([
    ['single', { kind: 'single', optionId: 'second' }],
    ['multiple', { kind: 'multiple', optionIds: ['first', 'third'] }],
    ['text', { kind: 'text', text: 'normalized\ntext' }],
    ['single_or_text', { kind: 'single_or_text', optionId: 'second', text: 'normalized\ntext' }],
    [
      'multiple_or_text',
      { kind: 'multiple_or_text', optionIds: ['first', 'third'], text: 'normalized\ntext' },
    ],
  ] as const)('returns the exact validator-approved %s recommendation', async (kind, value) => {
    const harness = new FakePiHarness();
    harness.queueUiResult('confirm', true);

    const intent = recommendation(
      await collectRecommendationIntent(harness.context(), question(kind), 5),
    );

    expect(intent).toEqual({
      questionId: QUESTION_ID,
      expectedRevision: 5,
      source: 'recommendation',
      value,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.value)).toBe(true);
    if ('optionIds' in intent.value) expect(Object.isFrozen(intent.value.optionIds)).toBe(true);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('requires explicit confirmation and cancellation creates no intent or mutation', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('confirm', false);
    expect(await collectRecommendationIntent(harness.context(), question('single'), 5)).toEqual({
      kind: 'cancelled',
    });
    expect(calls(harness, 'confirm')).toHaveLength(1);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it.each([
    ['single', { recommendedOptionIds: [] }],
    ['single', { recommendedOptionIds: ['missing'] }],
    ['single', { recommendedOptionIds: ['first', 'second'] }],
    ['multiple', { recommendedOptionIds: [] }],
    ['multiple', { recommendedOptionIds: ['first', 'first'] }],
    ['text', { recommendedText: undefined }],
    ['text', { recommendedText: '   ' }],
    ['single_or_text', { recommendedOptionIds: [], recommendedText: undefined }],
    ['multiple_or_text', { recommendedOptionIds: ['missing'], recommendedText: undefined }],
  ] as const)(
    'keeps invalid %s recommendation unavailable for case %#',
    async (kind, overrides) => {
      const harness = new FakePiHarness();
      expect(
        await collectRecommendationIntent(
          harness.context(),
          question(kind, overrides as Partial<QuestionItem>),
          5,
        ),
      ).toEqual({ kind: 'unavailable', code: 'SB_INVALID_ARGUMENT' });
      expect(calls(harness, 'confirm')).toHaveLength(0);
    },
  );

  it('returns stable unavailable results for absent, stale, changed, malformed, and no UI detail', async () => {
    const harness = new FakePiHarness();
    expect(await collectRecommendationIntent(harness.context(), undefined, 5)).toEqual({
      kind: 'unavailable',
      code: 'SB_NOT_FOUND',
    });
    expect(await collectRecommendationIntent(harness.context(), question('single'), 4)).toEqual({
      kind: 'unavailable',
      code: 'SB_REVISION_MISMATCH',
    });
    expect(
      await collectRecommendationIntent(
        harness.context(),
        question('single', { status: 'stale' }),
        5,
      ),
    ).toEqual({ kind: 'unavailable', code: 'SB_REVISION_MISMATCH' });
    expect(
      await collectRecommendationIntent(
        harness.context(),
        question('single', { recommendedOptionIds: null } as unknown as Partial<QuestionItem>),
        5,
      ),
    ).toEqual({ kind: 'unavailable', code: 'SB_INVALID_ARGUMENT' });
    const print = new FakePiHarness({ mode: 'print' });
    expect(await collectRecommendationIntent(print.context(), question('single'), 5)).toEqual({
      kind: 'unavailable',
      code: 'SB_UI_UNAVAILABLE',
    });
  });

  it('sanitizes terminal controls while identifying Q-33 and summarizing the exact value', async () => {
    const harness = new FakePiHarness();
    harness.queueUiResult('confirm', true);
    const item = question('text', {
      displayId: 'Q-33\u001b]8;;https://bad.invalid\u0007' as QuestionItem['displayId'],
      recommendedText: 'line one\n漢🙂 line two',
    });
    const intent = recommendation(await collectRecommendationIntent(harness.context(), item, 5));
    expect(intent.value).toEqual({ kind: 'text', text: 'line one\n漢🙂 line two' });
    const args = calls(harness, 'confirm')[0]?.args ?? [];
    expect(args[0]).toBe('Accept recommendation for Q-33?');
    expect(args[1]).toContain('text "line one\\n漢🙂 line two"');
    expect(JSON.stringify(args)).not.toContain('bad.invalid');
    expect(JSON.stringify(args)).not.toContain('\\u001b');
  });

  it('contains unavailable, thrown, and malformed confirmation results without content diagnostics', async () => {
    const thrown = new FakePiHarness();
    thrown.failNextUi('confirm', new Error('private recommended content'));
    expect(await collectRecommendationIntent(thrown.context(), question('single'), 5)).toEqual({
      kind: 'unavailable',
      code: 'SB_UI_UNAVAILABLE',
    });

    const malformed = new FakePiHarness();
    malformed.queueUiResult('confirm', 'yes');
    expect(await collectRecommendationIntent(malformed.context(), question('single'), 5)).toEqual({
      kind: 'unavailable',
      code: 'SB_INVALID_ARGUMENT',
    });
  });

  it('releases invocation state across 100 accepted and cancelled confirmations', async () => {
    const harness = new FakePiHarness();
    for (let run = 0; run < 100; run += 1) {
      harness.queueUiResult('confirm', run % 2 === 0);
      const result = await collectRecommendationIntent(harness.context(), question('single'), 5);
      expect(result.kind).toBe(run % 2 === 0 ? 'intent' : 'cancelled');
    }
    expect(calls(harness, 'confirm')).toHaveLength(100);
    expect(harness.appendCalls).toHaveLength(0);
    expect(harness.sendCalls).toHaveLength(0);
  });

  it('checks fixed-seed valid and invalid recommendation cases and prints the seed on failure', async () => {
    const seed = 0x5b033;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    try {
      for (let run = 0; run < 500; run += 1) {
        const valid = (next() & 1) === 1;
        const harness = new FakePiHarness();
        if (valid) harness.queueUiResult('confirm', true);
        const result = await collectRecommendationIntent(
          harness.context(),
          question('single', { recommendedOptionIds: valid ? ['first'] : ['unknown'] }),
          5,
        );
        expect(result.kind, `seed=${seed} case=${run}`).toBe(valid ? 'intent' : 'unavailable');
      }
    } catch (error) {
      console.error(`recommendation-actions property seed=${seed} state=${state}`);
      throw error;
    }
  });
});
