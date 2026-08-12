import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { Result } from '../../src/domain/errors.js';
import type { QuestionSpec } from '../../src/domain/types.js';
import {
  normalizeCreateQuestionSpec,
  normalizeReviseQuestionSpec,
  projectRecommendationAnswer,
  type QuestionValidationContext,
} from '../../src/questions/validation/index.js';

const NOW = '2026-08-12T12:00:00.000Z';
const context: QuestionValidationContext = {
  config: DEFAULT_CONFIG,
  cwd: '/workspace/project',
  currentTimestamp: NOW,
};

function option(id: string, label = id) {
  return { id, label };
}

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'create',
    question: 'Which shape should we use?',
    reason: 'Both shapes are safe and local.',
    class: 'reversible',
    response: { kind: 'single', options: [option('flat'), option('nested')] },
    ...overrides,
  };
}

function reviseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'revise',
    id: 'Q-1',
    expectedRevision: 1,
    revisionSummary: 'Replace the complete specification.',
    question: 'Which shape should we use now?',
    reason: 'The evidence changed.',
    class: 'reversible',
    response: { kind: 'single', options: [option('flat'), option('nested')] },
    recommendedOptionIds: [],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    ...overrides,
  };
}

function expectInvalid(result: Result<unknown>, path?: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('SB_INVALID_ARGUMENT');
  if (path !== undefined) expect(result.error.fieldErrors?.[0]?.path).toBe(path);
  for (const error of result.error.fieldErrors ?? []) {
    expect(error.path).toMatch(
      /^[A-Za-z][A-Za-z0-9_-]*(?:\[(?:\d+|\*)\]|\.[A-Za-z][A-Za-z0-9_-]*)*$/u,
    );
  }
}

function value(result: Result<QuestionSpec>): QuestionSpec {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('question specification normalization', () => {
  it('applies every create omission and retains no optional recommendation field', () => {
    const spec = value(normalizeCreateQuestionSpec(createInput(), context));
    expect(spec).toEqual({
      question: 'Which shape should we use?',
      reason: 'Both shapes are safe and local.',
      class: 'reversible',
      response: {
        kind: 'single',
        options: [option('flat'), option('nested')],
      },
      recommendedOptionIds: [],
      priority: 'normal',
      blockingPolicy: DEFAULT_CONFIG.questions.defaultBlockingPolicy,
      deliveryMode: DEFAULT_CONFIG.questions.defaultDeliveryMode,
      affectedWork: [],
      continuingWork: [],
      attachments: [],
    });
    expect('recommendation' in spec).toBe(false);
    expect('recommendedText' in spec).toBe(false);
    expect('temporaryDefault' in spec).toBe(false);
  });

  it('requires the authoritative full-replacement revise fields', () => {
    const required = [
      'recommendedOptionIds',
      'priority',
      'blockingPolicy',
      'deliveryMode',
      'affectedWork',
      'continuingWork',
      'attachments',
    ];
    for (const field of required) {
      const input = reviseInput();
      delete input[field];
      expectInvalid(normalizeReviseQuestionSpec(input, context), field);
    }
  });

  it('sanitizes all durable text before comparison and normalizes inert attachments', () => {
    const spec = value(
      normalizeCreateQuestionSpec(
        createInput({
          question: '  Which\u001b[31m shape?  ',
          reason: ' first\r\nsecond ',
          recommendation: '  Use flat.\u001b[0m ',
          response: {
            kind: 'single',
            options: [
              { id: 'flat', label: ' Flat\u001b[31m ', description: ' Simple  form ' },
              option('nested', ' Nested '),
            ],
          },
          recommendedOptionIds: ['flat'],
          affectedWork: [' parser   API '],
          continuingWork: [' tests '],
          temporaryDefault: {
            optionIds: ['flat'],
            disclosure: ' Preserve current behavior. ',
          },
          attachments: [
            { kind: 'file', label: ' Parser\u001b[31m ', path: '@/workspace/project/src/a.ts' },
            { kind: 'note', label: ' Note ', text: ' one\r\ntwo ' },
          ],
        }),
        context,
      ),
    );
    expect(spec.question).toBe('Which shape?');
    expect(spec.reason).toBe('first\nsecond');
    expect(spec.response.options?.[0]).toEqual({
      id: 'flat',
      label: 'Flat',
      description: 'Simple form',
    });
    expect(spec.affectedWork).toEqual(['parser API']);
    expect(spec.attachments).toEqual([
      { kind: 'file', label: 'Parser', path: 'src/a.ts' },
      { kind: 'note', label: 'Note', text: 'one\ntwo' },
    ]);
  });

  it('deep-freezes output and does not retain caller aliases', () => {
    const options = [option('flat'), option('nested')];
    const affectedWork = ['parser'];
    const attachments = [{ kind: 'note', label: 'Evidence', text: 'Safe' }];
    const input = createInput({
      response: { kind: 'multiple', options },
      affectedWork,
      attachments,
    });
    const spec = value(normalizeCreateQuestionSpec(input, context));
    const firstOption = options[0];
    const firstAttachment = attachments[0];
    if (firstOption === undefined || firstAttachment === undefined) throw new Error('fixture');
    firstOption.label = 'changed';
    affectedWork[0] = 'changed';
    firstAttachment.text = 'changed';
    expect(spec.response.options?.[0]?.label).toBe('flat');
    expect(spec.affectedWork).toEqual(['parser']);
    expect(spec.attachments[0]).toEqual({ kind: 'note', label: 'Evidence', text: 'Safe' });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.response)).toBe(true);
    expect(Object.isFrozen(spec.response.options)).toBe(true);
    expect(Object.isFrozen(spec.attachments[0])).toBe(true);
  });

  it('is deterministic for repeated calls', () => {
    const input = createInput({
      recommendedOptionIds: ['nested'],
      expiresAt: '2026-08-12T12:00:00.001Z',
    });
    const first = normalizeCreateQuestionSpec(input, context);
    const second = normalizeCreateQuestionSpec(input, context);
    expect(first).toEqual(second);
  });
});

describe('response cross-field matrix', () => {
  const validResponses = [
    { kind: 'single', options: [option('a'), option('b')] },
    { kind: 'multiple', options: [option('a'), option('b')] },
    { kind: 'text' },
    { kind: 'single_or_text', options: [option('a'), option('b')] },
    { kind: 'multiple_or_text', options: [option('a'), option('b')] },
  ];

  it.each(validResponses)('accepts and freezes response kind $kind', (response) => {
    const spec = value(normalizeCreateQuestionSpec(createInput({ response }), context));
    expect(spec.response.kind).toBe(response.kind);
    expect(spec.response.options ?? []).toHaveLength(response.kind === 'text' ? 0 : 2);
  });

  it('enforces text option prohibition including INV-005', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ response: { kind: 'text', options: [option('us'), option('eu')] } }),
        context,
      ),
      'response.options',
    );
  });

  it.each(['single', 'multiple', 'single_or_text', 'multiple_or_text'])(
    'requires 2-8 options for %s',
    (kind) => {
      expectInvalid(
        normalizeCreateQuestionSpec(
          createInput({ response: { kind, options: [option('a')] } }),
          context,
        ),
        'response.options',
      );
      expectInvalid(
        normalizeCreateQuestionSpec(
          createInput({
            response: {
              kind,
              options: Array.from({ length: 9 }, (_, index) => option(`o${index}`)),
            },
          }),
          context,
        ),
        'response.options',
      );
    },
  );

  it('requires exact unique option IDs and bounded labels/descriptions', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ response: { kind: 'single', options: [option('Bad'), option('ok')] } }),
        context,
      ),
      'response.options[0].id',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ response: { kind: 'single', options: [option('same'), option('same')] } }),
        context,
      ),
      'response.options[1].id',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          response: {
            kind: 'single',
            options: [option('a', 'x'.repeat(161)), option('b')],
          },
        }),
        context,
      ),
      'response.options[0].label',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          response: {
            kind: 'single',
            options: [{ ...option('a'), description: 'x'.repeat(501) }, option('b')],
          },
        }),
        context,
      ),
      'response.options[0].description',
    );
  });
});

describe('recommendation normalization and projection', () => {
  const cases = [
    {
      kind: 'single',
      fields: { recommendedOptionIds: ['b'] },
      answer: { kind: 'single', optionId: 'b' },
    },
    {
      kind: 'multiple',
      fields: { recommendedOptionIds: ['b', 'a'] },
      answer: { kind: 'multiple', optionIds: ['a', 'b'] },
    },
    {
      kind: 'text',
      fields: { recommendedText: 'Use us-east.' },
      answer: { kind: 'text', text: 'Use us-east.' },
    },
    {
      kind: 'single_or_text',
      fields: { recommendedOptionIds: ['a'], recommendedText: 'With a note.' },
      answer: { kind: 'single_or_text', optionId: 'a', text: 'With a note.' },
    },
    {
      kind: 'multiple_or_text',
      fields: { recommendedOptionIds: ['b'], recommendedText: 'And explain.' },
      answer: { kind: 'multiple_or_text', optionIds: ['b'], text: 'And explain.' },
    },
  ];

  it.each(cases)(
    'projects an exact valid $kind recommendation answer',
    ({ kind, fields, answer }) => {
      const response = kind === 'text' ? { kind } : { kind, options: [option('a'), option('b')] };
      const spec = value(
        normalizeCreateQuestionSpec(createInput({ response, ...fields }), context),
      );
      expect(projectRecommendationAnswer(spec)).toEqual(answer);
    },
  );

  it('does not treat rationale alone as an answer', () => {
    const spec = value(
      normalizeCreateQuestionSpec(createInput({ recommendation: 'Flat is simpler.' }), context),
    );
    expect(projectRecommendationAnswer(spec)).toBeUndefined();
  });

  it('rejects missing IDs (INV-006), duplicates, single cardinality, and wrong-kind text', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(createInput({ recommendedOptionIds: ['missing'] }), context),
      'recommendedOptionIds[0]',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(createInput({ recommendedOptionIds: ['flat', 'flat'] }), context),
      'recommendedOptionIds[1]',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ recommendedOptionIds: ['flat', 'nested'] }),
        context,
      ),
      'recommendedOptionIds',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(createInput({ recommendedText: 'Not allowed.' }), context),
      'recommendedText',
    );
  });

  it('rejects text made empty by sanitization', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          response: { kind: 'text' },
          recommendedText: '\u001b[31m\u001b[0m',
        }),
        context,
      ),
      'recommendedText',
    );
  });
});

describe('temporary defaults', () => {
  it.each(['single', 'single_or_text'])('accepts one ordered option for reversible %s', (kind) => {
    const spec = value(
      normalizeCreateQuestionSpec(
        createInput({
          response: { kind, options: [option('a'), option('b')] },
          temporaryDefault: { optionIds: ['b'], disclosure: 'Use B while waiting.' },
        }),
        context,
      ),
    );
    expect(spec.temporaryDefault?.optionIds).toEqual(['b']);
  });

  it.each(['multiple', 'multiple_or_text'])(
    'accepts and orders multiple options for reversible %s',
    (kind) => {
      const spec = value(
        normalizeCreateQuestionSpec(
          createInput({
            response: { kind, options: [option('a'), option('b')] },
            temporaryDefault: {
              optionIds: ['b', 'a'],
              disclosure: 'Use both while waiting.',
            },
          }),
          context,
        ),
      );
      expect(spec.temporaryDefault?.optionIds).toEqual(['a', 'b']);
    },
  );

  it('rejects non-reversible defaults (INV-007), text-only, missing, duplicate, and unknown IDs', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          class: 'preference',
          temporaryDefault: { optionIds: ['flat'], disclosure: 'Use Flat.' },
        }),
        context,
      ),
      'temporaryDefault',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          response: { kind: 'text' },
          temporaryDefault: { optionIds: ['flat'], disclosure: 'Use Flat.' },
        }),
        context,
      ),
      'temporaryDefault',
    );
    for (const optionIds of [[], ['flat', 'flat'], ['missing']]) {
      expectInvalid(
        normalizeCreateQuestionSpec(
          createInput({ temporaryDefault: { optionIds, disclosure: 'Temporary.' } }),
          context,
        ),
      );
    }
  });

  it('rejects single cardinality and empty or overlong disclosure', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          temporaryDefault: {
            optionIds: ['flat', 'nested'],
            disclosure: 'Use both.',
          },
        }),
        context,
      ),
      'temporaryDefault.optionIds',
    );
    for (const disclosure of ['   ', 'x'.repeat(1001)]) {
      expectInvalid(
        normalizeCreateQuestionSpec(
          createInput({ temporaryDefault: { optionIds: ['flat'], disclosure } }),
          context,
        ),
        'temporaryDefault.disclosure',
      );
    }
  });

  it('keeps safe authorization structurally representable but makes its default impossible', () => {
    const authorization = value(
      normalizeCreateQuestionSpec(createInput({ class: 'authorization' }), context),
    );
    expect(authorization.class).toBe('authorization');
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          class: 'authorization',
          temporaryDefault: { optionIds: ['flat'], disclosure: 'Not permitted.' },
        }),
        context,
      ),
      'temporaryDefault',
    );
  });
});

describe('expiry, lists, attachments, and field boundaries', () => {
  it('accepts only an exact canonical UTC expiry strictly after caller time', () => {
    expect(
      value(
        normalizeCreateQuestionSpec(
          createInput({ expiresAt: '2026-08-12T12:00:00.001Z' }),
          context,
        ),
      ).expiresAt,
    ).toBe('2026-08-12T12:00:00.001Z');
    for (const expiresAt of [
      NOW,
      '2026-08-12T11:59:59.999Z',
      '2026-08-12T12:00:01Z',
      '2026-08-12T12:00:01.000+00:00',
      'not-a-date',
      ' 2026-08-12T12:00:01.000Z ',
    ]) {
      expectInvalid(normalizeCreateQuestionSpec(createInput({ expiresAt }), context), 'expiresAt');
    }
    expectInvalid(
      normalizeCreateQuestionSpec(createInput(), { ...context, currentTimestamp: 'bad' }),
      'currentTimestamp',
    );
  });

  it('rejects sanitization-induced duplicate work within and across lists', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(createInput({ affectedWork: [' parser ', 'parser'] }), context),
      'affectedWork[1]',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ affectedWork: ['parser'], continuingWork: [' parser '] }),
        context,
      ),
      'continuingWork',
    );
  });

  it('enforces list and attachment collection limits and nested attachment semantics', () => {
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ affectedWork: Array.from({ length: 21 }, (_, index) => `work-${index}`) }),
        context,
      ),
      'affectedWork',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          attachments: Array.from({ length: 11 }, (_, index) => ({
            kind: 'note',
            label: `note-${index}`,
            text: 'safe',
          })),
        }),
        context,
      ),
      'attachments',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({
          attachments: [
            {
              kind: 'line_range',
              label: 'Bad range',
              path: 'src/a.ts',
              startLine: 20,
              endLine: 10,
            },
          ],
        }),
        context,
      ),
      'attachments[0].endLine',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(
        createInput({ attachments: [{ kind: 'url', label: 'Bad', url: 'file:///tmp/a' }] }),
        context,
      ),
      'attachments[0].url',
    );
  });

  it('enforces Unicode code-point boundaries after sanitization', () => {
    const question160 = '😀'.repeat(160);
    expect(
      value(normalizeCreateQuestionSpec(createInput({ question: question160 }), context)).question,
    ).toBe(question160);
    expectInvalid(
      normalizeCreateQuestionSpec(createInput({ question: `${question160}😀` }), context),
      'question',
    );
    expectInvalid(
      normalizeCreateQuestionSpec(createInput({ reason: '\u001b[31m\u001b[0m' }), context),
      'reason',
    );

    const bounded = value(
      normalizeCreateQuestionSpec(
        createInput({
          question: 'q'.repeat(160),
          reason: 'r'.repeat(4_000),
          recommendation: 'c'.repeat(1_000),
          recommendedText: 't'.repeat(4_000),
          response: {
            kind: 'multiple_or_text',
            options: Array.from({ length: 8 }, (_, index) => ({
              id: index === 0 ? 'a'.repeat(32) : `option_${index}`,
              label: 'l'.repeat(160),
              description: 'd'.repeat(500),
            })),
          },
          recommendedOptionIds: ['a'.repeat(32)],
          affectedWork: Array.from({ length: 20 }, (_, index) => `${index}-${'w'.repeat(237)}`),
          attachments: Array.from({ length: 10 }, (_, index) => ({
            kind: 'note',
            label: `note-${index}`,
            text: 'safe',
          })),
          temporaryDefault: {
            optionIds: ['a'.repeat(32)],
            disclosure: 'd'.repeat(1_000),
          },
        }),
        context,
      ),
    );
    expect(bounded.response.options).toHaveLength(8);
    expect(bounded.affectedWork).toHaveLength(20);
    expect(bounded.attachments).toHaveLength(10);

    for (const [field, overlong] of [
      ['reason', 'r'.repeat(4_001)],
      ['recommendation', 'c'.repeat(1_001)],
      ['recommendedText', 't'.repeat(4_001)],
    ] as const) {
      expectInvalid(
        normalizeCreateQuestionSpec(
          createInput({
            response: { kind: 'multiple_or_text', options: [option('a'), option('b')] },
            [field]: overlong,
          }),
          context,
        ),
        field,
      );
    }
  });
});

describe('deterministic property matrix', () => {
  it('normalizes 1,000 recommendation/default permutations deterministically', () => {
    const seed = 0x5b019;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    try {
      const kinds = ['single', 'multiple', 'text', 'single_or_text', 'multiple_or_text'] as const;
      for (let index = 0; index < 1_000; index += 1) {
        const kind = kinds[next() % kinds.length];
        if (kind === undefined) throw new Error('generated kind');
        const response =
          kind === 'text' ? { kind } : { kind, options: [option('a'), option('b'), option('c')] };
        const canText = kind === 'text' || kind.endsWith('_or_text');
        const ids = kind === 'text' ? [] : ['a', 'b', 'c'].filter(() => next() % 2 === 0);
        const recommendedOptionIds =
          kind === 'single' || kind === 'single_or_text' ? ids.slice(0, 1) : ids;
        const recommendedText = canText && next() % 2 === 0 ? `text-${index}` : undefined;
        const temporaryDefault =
          kind !== 'text' && next() % 3 === 0
            ? {
                optionIds:
                  kind === 'single' || kind === 'single_or_text'
                    ? ['a']
                    : recommendedOptionIds.length > 0
                      ? recommendedOptionIds
                      : ['a'],
                disclosure: `default-${index}`,
              }
            : undefined;
        const input = createInput({
          response,
          recommendedOptionIds,
          ...(recommendedText === undefined ? {} : { recommendedText }),
          ...(temporaryDefault === undefined ? {} : { temporaryDefault }),
        });
        const first = normalizeCreateQuestionSpec(input, context);
        const second = normalizeCreateQuestionSpec(input, context);
        expect(first, `seed=${seed} case=${index}`).toEqual(second);
        expect(first.ok, `seed=${seed} case=${index}`).toBe(true);
        if (first.ok) {
          const answer = projectRecommendationAnswer(first.value);
          const hasAnswerParts = recommendedOptionIds.length > 0 || recommendedText !== undefined;
          expect(answer !== undefined, `seed=${seed} case=${index}`).toBe(hasAnswerParts);
        }
      }
    } catch (error) {
      console.error(`question-validation property seed=${seed} state=${state}`);
      throw error;
    }
  });
});
