import { describe, expect, it } from 'vitest';

import type { BoardEvent } from '../../src/domain/events.js';
import {
  answerMatchesRecommendation,
  canonicalize,
  commandFingerprint,
  eventFingerprint,
  hasValidEnvelope,
  isFiniteUtcTimestamp,
  isPositiveSafeInteger,
  isRecord,
  sameSemanticValue,
  validAnswerValue,
  validAttachments,
  validQuestionSpec,
  validUpdateFields,
} from '../../src/domain/invariants.js';
import type {
  AnswerValue,
  Attachment,
  QuestionSpec,
  ResponseSpec,
  UpdateFields,
} from '../../src/domain/types.js';

const TIME = '2026-08-08T20:00:00.000Z';
const options = [
  { id: 'one' as const, label: 'One' },
  { id: 'two' as const, label: 'Two' },
  { id: 'three' as const, label: 'Three' },
] as const;

const questionSpec: QuestionSpec = {
  question: 'Choose?',
  reason: 'A choice is needed.',
  class: 'reversible',
  response: { kind: 'single', options },
  recommendedOptionIds: ['one'],
  priority: 'normal',
  blockingPolicy: 'never',
  deliveryMode: 'steer',
  affectedWork: [],
  continuingWork: [],
  attachments: [],
};

function asQuestionSpec(value: unknown): QuestionSpec {
  return value as QuestionSpec;
}
function asUpdateFields(value: unknown): UpdateFields {
  return value as UpdateFields;
}
function asAnswerValue(value: unknown): AnswerValue {
  return value as AnswerValue;
}
function asAttachments(value: unknown): readonly Attachment[] {
  return value as readonly Attachment[];
}

function event(overrides: Record<string, unknown> = {}): BoardEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    eventType: 'board.viewed',
    occurredAt: TIME,
    actor: 'user',
    commandId: 'ui:test',
    payload: { cutoffAt: TIME },
    ...overrides,
  } as BoardEvent;
}

describe('SB-010 invariant boundaries', () => {
  it.each([
    [null, false],
    [[], false],
    [{}, true],
    [Object.create(null), true],
    ['x', false],
  ])('classifies records %#', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });

  it.each([
    [TIME, true],
    ['2026-08-08T20:00:00Z', false],
    ['2026-13-08T20:00:00.000Z', false],
    ['not-a-time', false],
    [42, false],
  ])('validates UTC timestamps %#', (value, expected) => {
    expect(isFiniteUtcTimestamp(value)).toBe(expected);
  });

  it.each([
    [1, true],
    [Number.MAX_SAFE_INTEGER, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])('validates positive safe integers %#', (value, expected) => {
    expect(isPositiveSafeInteger(value)).toBe(expected);
  });

  it.each([
    [event(), true],
    [null, false],
    [{}, false],
    [event({ schemaVersion: 2 }), false],
    [event({ eventType: 1 }), false],
    [event({ eventType: 'unknown' }), false],
    [event({ eventId: 1 }), false],
    [event({ commandId: 1 }), false],
    [event({ occurredAt: 'bad' }), false],
    [event({ actor: 1 }), false],
    [event({ payload: [] }), false],
    [event({ actor: 'agent' }), false],
    [event({ eventType: 'update.archived', actor: 'agent', payload: {} }), true],
  ])('validates event envelopes %#', (value, expected) => {
    expect(hasValidEnvelope(value)).toBe(expected);
  });

  it('canonicalizes every supported shape in stable key order', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(2)).toBe('2');
    expect(canonicalize([2, 'x', null])).toBe('[2,"x",null]');
    expect(canonicalize({ z: 2, skip: undefined, a: [true] })).toBe('{"a":[true],"z":2}');
    expect(canonicalize(Number.NaN)).toBeUndefined();
    expect(canonicalize(Symbol('x'))).toBeUndefined();
    expect(canonicalize([Symbol('x')])).toBeUndefined();
    expect(canonicalize({ x: Symbol('x') })).toBeUndefined();
    const array: unknown[] = [];
    array.push(array);
    expect(canonicalize(array)).toBeUndefined();
    const object: Record<string, unknown> = {};
    object.self = object;
    expect(canonicalize(object)).toBeUndefined();
    expect(sameSemanticValue({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(sameSemanticValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameSemanticValue(Symbol('x'), Symbol('x'))).toBe(false);
    expect(eventFingerprint(event())).toBe(canonicalize(event()));
    expect(commandFingerprint(event())).toBe(
      canonicalize({ eventType: 'board.viewed', payload: { cutoffAt: TIME } }),
    );
  });

  const validWorking = { kind: 'working', title: 'Work', attachments: [] } as const;
  it.each([
    [validWorking, undefined, true],
    [{ ...validWorking, key: 'good:key' }, undefined, true],
    [{ ...validWorking, stage: 'testing' }, undefined, true],
    [{ ...validWorking, progress: { current: 0, total: 1, unit: 'tests' } }, undefined, true],
    [{ ...validWorking, kind: 'completed' }, TIME, true],
    [{ ...validWorking, kind: 'completed', stage: 'complete' }, TIME, true],
    [{ ...validWorking, kind: 'failed' }, TIME, true],
    [null, undefined, false],
    [{ ...validWorking, title: 1 }, undefined, false],
    [{ ...validWorking, title: '' }, undefined, false],
    [{ ...validWorking, kind: 1 }, undefined, false],
    [{ ...validWorking, kind: 'other' }, undefined, false],
    [{ ...validWorking, attachments: 1 }, undefined, false],
    [{ ...validWorking, attachments: [{}] }, undefined, false],
    [{ ...validWorking, key: 1 }, undefined, false],
    [{ ...validWorking, key: ' bad' }, undefined, false],
    [{ ...validWorking, stage: 'other' }, undefined, false],
    [{ ...validWorking, progress: null }, undefined, false],
    [{ ...validWorking, progress: { current: '0', total: 1 } }, undefined, false],
    [{ ...validWorking, progress: { current: 0, total: '1' } }, undefined, false],
    [{ ...validWorking, progress: { current: Number.NaN, total: 1 } }, undefined, false],
    [
      { ...validWorking, progress: { current: 0, total: Number.POSITIVE_INFINITY } },
      undefined,
      false,
    ],
    [{ ...validWorking, progress: { current: -1, total: 1 } }, undefined, false],
    [{ ...validWorking, progress: { current: 0, total: 0 } }, undefined, false],
    [{ ...validWorking, progress: { current: 2, total: 1 } }, undefined, false],
    [{ ...validWorking, progress: { current: 0, total: 1, unit: 1 } }, undefined, false],
    [{ ...validWorking, progress: { current: 0, total: 1, unit: '' } }, undefined, false],
    [validWorking, TIME, false],
    [{ ...validWorking, kind: 'completed' }, undefined, false],
    [{ ...validWorking, kind: 'completed', stage: 'testing' }, TIME, false],
  ])('validates update fields %#', (fields, completedAt, expected) => {
    expect(validUpdateFields(asUpdateFields(fields), completedAt)).toBe(expected);
  });

  it.each([
    [questionSpec, true],
    [
      {
        ...questionSpec,
        class: 'information',
        response: { kind: 'text' },
        recommendedOptionIds: [],
      },
      true,
    ],
    [
      {
        ...questionSpec,
        response: { kind: 'multiple', options },
        recommendedOptionIds: ['one', 'two'],
      },
      true,
    ],
    [
      { ...questionSpec, response: { kind: 'single_or_text', options }, recommendedText: 'Other' },
      true,
    ],
    [{ ...questionSpec, temporaryDefault: { optionIds: ['one'], disclosure: 'Use one.' } }, true],
    [
      {
        ...questionSpec,
        response: { kind: 'multiple', options },
        temporaryDefault: { optionIds: ['one', 'two'], disclosure: 'Use both.' },
      },
      true,
    ],
    [{ ...questionSpec, expiresAt: TIME }, true],
    [null, false],
    [{ ...questionSpec, question: 1 }, false],
    [{ ...questionSpec, question: '' }, false],
    [{ ...questionSpec, reason: 1 }, false],
    [{ ...questionSpec, reason: '' }, false],
    [{ ...questionSpec, class: 'authorization' }, false],
    [{ ...questionSpec, class: 'other' }, false],
    [{ ...questionSpec, response: null }, false],
    [{ ...questionSpec, recommendedOptionIds: 1 }, false],
    [{ ...questionSpec, recommendedOptionIds: ['one', 'one'] }, false],
    [{ ...questionSpec, priority: 'urgent' }, false],
    [{ ...questionSpec, blockingPolicy: 'always' }, false],
    [{ ...questionSpec, deliveryMode: 'now' }, false],
    [{ ...questionSpec, affectedWork: ['x', 'x'] }, false],
    [{ ...questionSpec, continuingWork: [''] }, false],
    [{ ...questionSpec, attachments: [{}] }, false],
    [{ ...questionSpec, expiresAt: 'bad' }, false],
    [{ ...questionSpec, recommendedOptionIds: ['missing'] }, false],
    [{ ...questionSpec, recommendedOptionIds: ['one', 'two'] }, false],
    [{ ...questionSpec, recommendedText: 'text' }, false],
    [
      {
        ...questionSpec,
        response: { kind: 'text' },
        recommendedOptionIds: [],
        recommendedText: '   ',
      },
      false,
    ],
    [
      {
        ...questionSpec,
        class: 'information',
        temporaryDefault: { optionIds: ['one'], disclosure: 'Use.' },
      },
      false,
    ],
    [
      {
        ...questionSpec,
        response: { kind: 'text' },
        recommendedOptionIds: [],
        temporaryDefault: { optionIds: ['one'], disclosure: 'Use.' },
      },
      false,
    ],
    [{ ...questionSpec, temporaryDefault: { optionIds: [], disclosure: 'Use.' } }, false],
    [
      { ...questionSpec, temporaryDefault: { optionIds: ['one', 'one'], disclosure: 'Use.' } },
      false,
    ],
    [{ ...questionSpec, temporaryDefault: { optionIds: ['missing'], disclosure: 'Use.' } }, false],
    [
      { ...questionSpec, temporaryDefault: { optionIds: ['one', 'two'], disclosure: 'Use.' } },
      false,
    ],
    [{ ...questionSpec, temporaryDefault: { optionIds: ['one'], disclosure: 1 } }, false],
    [{ ...questionSpec, temporaryDefault: { optionIds: ['one'], disclosure: '' } }, false],
  ])('validates question specifications %#', (spec, expected) => {
    expect(validQuestionSpec(asQuestionSpec(spec))).toBe(expected);
  });

  it.each([
    [{ kind: 'text' }, true],
    [{ kind: 'text', options: [] }, true],
    [{ kind: 'text', options }, false],
    [{ kind: 'single', options }, true],
    [{ kind: 'multiple', options }, true],
    [{ kind: 'single_or_text', options }, true],
    [{ kind: 'multiple_or_text', options }, true],
    [null, false],
    [{ kind: 1 }, false],
    [{ kind: 'single', options: 1 }, false],
    [{ kind: 'other', options }, false],
    [{ kind: 'single', options: [options[0]] }, false],
    [{ kind: 'single', options: [...options, ...options, ...options] }, false],
    [{ kind: 'single', options: [null, options[1]] }, false],
    [{ kind: 'single', options: [{ id: 1, label: 'One' }, options[1]] }, false],
    [{ kind: 'single', options: [{ id: 'Bad', label: 'One' }, options[1]] }, false],
    [{ kind: 'single', options: [options[0], { id: 'one', label: 'Duplicate' }] }, false],
    [{ kind: 'single', options: [{ id: 'one', label: 1 }, options[1]] }, false],
    [{ kind: 'single', options: [{ id: 'one', label: '' }, options[1]] }, false],
  ])('covers response boundaries through question validation %#', (response, expected) => {
    const spec = { ...questionSpec, response, recommendedOptionIds: [] };
    expect(validQuestionSpec(asQuestionSpec(spec))).toBe(expected);
  });

  const answerSpecs: Readonly<Record<string, QuestionSpec>> = {
    single: { ...questionSpec, response: { kind: 'single', options } },
    multiple: { ...questionSpec, response: { kind: 'multiple', options } },
    text: { ...questionSpec, response: { kind: 'text' }, recommendedOptionIds: [] },
    single_or_text: { ...questionSpec, response: { kind: 'single_or_text', options } },
    multiple_or_text: { ...questionSpec, response: { kind: 'multiple_or_text', options } },
  };
  it.each([
    [{ kind: 'single', optionId: 'one' }, 'single', true],
    [{ kind: 'single', optionId: 'missing' }, 'single', false],
    [{ kind: 'single', optionId: 1 }, 'single', false],
    [{ kind: 'multiple', optionIds: ['one', 'two'] }, 'multiple', true],
    [{ kind: 'multiple', optionIds: [] }, 'multiple', false],
    [{ kind: 'multiple', optionIds: ['one', 'one'] }, 'multiple', false],
    [{ kind: 'multiple', optionIds: ['missing'] }, 'multiple', false],
    [{ kind: 'multiple', optionIds: ['two', 'one'] }, 'multiple', false],
    [{ kind: 'multiple', optionIds: 1 }, 'multiple', false],
    [{ kind: 'text', text: 'answer' }, 'text', true],
    [{ kind: 'text', text: '' }, 'text', false],
    [{ kind: 'text', text: ' answer' }, 'text', false],
    [{ kind: 'text', text: 1 }, 'text', false],
    [{ kind: 'single_or_text', optionId: 'one' }, 'single_or_text', true],
    [{ kind: 'single_or_text', text: 'other' }, 'single_or_text', true],
    [{ kind: 'single_or_text', optionId: 'one', text: 'other' }, 'single_or_text', true],
    [{ kind: 'single_or_text', optionId: 'missing' }, 'single_or_text', false],
    [{ kind: 'single_or_text', text: '' }, 'single_or_text', false],
    [{ kind: 'single_or_text' }, 'single_or_text', false],
    [{ kind: 'multiple_or_text', optionIds: ['one'] }, 'multiple_or_text', true],
    [{ kind: 'multiple_or_text', optionIds: [], text: 'other' }, 'multiple_or_text', true],
    [{ kind: 'multiple_or_text', optionIds: ['one'], text: 'other' }, 'multiple_or_text', true],
    [{ kind: 'multiple_or_text', optionIds: [] }, 'multiple_or_text', false],
    [{ kind: 'multiple_or_text', optionIds: ['two', 'one'] }, 'multiple_or_text', false],
    [{ kind: 'multiple_or_text', optionIds: [], text: '' }, 'multiple_or_text', false],
    [null, 'single', false],
    [{ kind: 'text', text: 'x' }, 'single', false],
    [{ kind: 'unknown' }, 'unknown', false],
  ])('validates answer shapes %#', (value, specName, expected) => {
    const spec =
      answerSpecs[specName] ??
      ({
        ...questionSpec,
        response: { kind: 'unknown' } as unknown as ResponseSpec,
      } as QuestionSpec);
    expect(validAnswerValue(asAnswerValue(value), spec)).toBe(expected);
  });

  it.each([
    [
      { kind: 'single', optionId: 'one' },
      { ...answerSpecs.single, recommendedOptionIds: ['one'] },
      true,
    ],
    [
      { kind: 'single', optionId: 'two' },
      { ...answerSpecs.single, recommendedOptionIds: ['one'] },
      false,
    ],
    [
      { kind: 'multiple', optionIds: ['one', 'two'] },
      { ...answerSpecs.multiple, recommendedOptionIds: ['one', 'two'] },
      true,
    ],
    [
      { kind: 'multiple', optionIds: ['one'] },
      { ...answerSpecs.multiple, recommendedOptionIds: ['one', 'two'] },
      false,
    ],
    [{ kind: 'text', text: 'yes' }, { ...answerSpecs.text, recommendedText: 'yes' }, true],
    [{ kind: 'text', text: 'no' }, { ...answerSpecs.text, recommendedText: 'yes' }, false],
    [
      { kind: 'single_or_text', optionId: 'one' },
      { ...answerSpecs.single_or_text, recommendedOptionIds: ['one'] },
      true,
    ],
    [
      { kind: 'single_or_text', text: 'yes' },
      { ...answerSpecs.single_or_text, recommendedOptionIds: [], recommendedText: 'yes' },
      true,
    ],
    [
      { kind: 'single_or_text', optionId: 'two' },
      { ...answerSpecs.single_or_text, recommendedOptionIds: ['one'] },
      false,
    ],
    [
      { kind: 'multiple_or_text', optionIds: ['one'], text: 'yes' },
      { ...answerSpecs.multiple_or_text, recommendedOptionIds: ['one'], recommendedText: 'yes' },
      true,
    ],
    [
      { kind: 'multiple_or_text', optionIds: ['one'] },
      { ...answerSpecs.multiple_or_text, recommendedOptionIds: ['two'] },
      false,
    ],
    [
      { kind: 'single', optionId: 'one' },
      { ...answerSpecs.single, recommendedOptionIds: [] },
      false,
    ],
    [{ kind: 'unknown' }, questionSpec, false],
  ])('matches recommendations %#', (value, spec, expected) => {
    expect(answerMatchesRecommendation(asAnswerValue(value), spec as QuestionSpec)).toBe(expected);
  });

  it.each([
    [[], true],
    [[{ kind: 'file', label: 'File', path: 'src/a.ts' }], true],
    [[{ kind: 'line_range', label: 'Lines', path: 'src/a.ts', startLine: 1, endLine: 2 }], true],
    [[{ kind: 'test_run', label: 'Test', reference: 'test:unit' }], true],
    [[{ kind: 'command', label: 'Command', reference: 'npm test' }], true],
    [[{ kind: 'url', label: 'URL', url: 'https://example.test' }], true],
    [[{ kind: 'url', label: 'URL', url: 'http://example.test' }], true],
    [[{ kind: 'note', label: 'Note', text: 'Evidence' }], true],
    [null, false],
    [Array.from({ length: 11 }, () => ({ kind: 'note', label: 'N', text: 'x' })), false],
    [[null], false],
    [[{ kind: 1, label: 'x' }], false],
    [[{ kind: 'file', label: 1, path: 'x' }], false],
    [[{ kind: 'file', label: '', path: 'x' }], false],
    [[{ kind: 'file', label: 'F', path: 1 }], false],
    [[{ kind: 'file', label: 'F', path: '' }], false],
    [[{ kind: 'line_range', label: 'L', path: 1, startLine: 1, endLine: 2 }], false],
    [[{ kind: 'line_range', label: 'L', path: '', startLine: 1, endLine: 2 }], false],
    [[{ kind: 'line_range', label: 'L', path: 'x', startLine: 0, endLine: 2 }], false],
    [[{ kind: 'line_range', label: 'L', path: 'x', startLine: 2, endLine: 1 }], false],
    [[{ kind: 'test_run', label: 'T', reference: 1 }], false],
    [[{ kind: 'command', label: 'C', reference: '' }], false],
    [[{ kind: 'url', label: 'U', url: 1 }], false],
    [[{ kind: 'url', label: 'U', url: 'ftp://example.test' }], false],
    [[{ kind: 'url', label: 'U', url: 'not a url' }], false],
    [[{ kind: 'note', label: 'N', text: 1 }], false],
    [[{ kind: 'note', label: 'N', text: '' }], false],
    [[{ kind: 'unknown', label: 'X' }], false],
  ])('validates attachment boundaries %#', (attachments, expected) => {
    expect(validAttachments(asAttachments(attachments))).toBe(expected);
  });
});
