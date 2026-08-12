import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '../../src/domain/events.js';
import { decodeBoardEvent, encodeBoardEvent } from '../../src/persistence/event-codec.js';
import { schemaPositiveEvents } from '../fixtures/schema-positive.js';

const time = '2026-08-12T09:00:00.000Z';
const providerQualifiedCommandId =
  'tool:call_Z6LPv0kJq22rXsNP67ojPhlg|fc_068d35c2414bddfc016a7c4fb7e8f4819881a1ba59d0364046';
const upd = 'upd_11111111-1111-4111-8111-111111111111';
const qst = 'qst_22222222-2222-4222-8222-222222222222';
const ans = 'ans_33333333-3333-4333-8333-333333333333';
const spec = {
  question: 'Choose one?',
  reason: 'A choice is needed.',
  class: 'reversible',
  response: {
    kind: 'single',
    options: [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ],
  },
  recommendedOptionIds: ['one'],
  priority: 'normal',
  blockingPolicy: 'when_agent_settles',
  deliveryMode: 'steer',
  affectedWork: [],
  continuingWork: [],
  attachments: [],
} as const;

const payloads = {
  'update.upserted': {
    updateId: upd,
    displayId: 'U-1',
    revision: 1,
    createdAt: time,
    updatedAt: time,
    fields: { kind: 'working', title: 'Work', attachments: [] },
  },
  'update.archived': { updateId: upd, expectedRevision: 1, revision: 2, archivedAt: time },
  'question.created': { questionId: qst, displayId: 'Q-1', revision: 1, createdAt: time, spec },
  'question.revised': {
    questionId: qst,
    expectedRevision: 1,
    revision: 2,
    updatedAt: time,
    revisionSummary: 'Changed.',
    spec,
  },
  'question.cancelled': {
    questionId: qst,
    expectedRevision: 1,
    revision: 2,
    cancelledAt: time,
    reason: 'No longer needed.',
  },
  'question.escalated': { questionId: qst, expectedRevision: 1, revision: 2, escalatedAt: time },
  'question.staled': {
    questionId: qst,
    expectedRevision: 1,
    revision: 2,
    staleAt: time,
    reason: 'Expired.',
  },
  'question.dismissed': { questionId: qst, expectedRevision: 1, revision: 2, dismissedAt: time },
  'question.answered': {
    questionId: qst,
    expectedRevision: 1,
    answer: {
      id: ans,
      questionId: qst,
      questionDisplayId: 'Q-1',
      questionRevision: 1,
      source: 'manual',
      value: { kind: 'single', optionId: 'one' },
      answeredAt: time,
    },
  },
  'answer.delivery_queued': { answerId: ans, questionId: qst, attempt: 1, at: time, mode: 'steer' },
  'answer.delivery_failed': {
    answerId: ans,
    questionId: qst,
    attempt: 1,
    at: time,
    mode: 'steer',
    errorCode: 'SB_DELIVERY_FAILED',
    errorCategory: 'unknown',
  },
  'answer.acknowledged': {
    acknowledgement: {
      answerId: ans,
      questionId: qst,
      outcome: 'applied',
      summary: 'Applied.',
      resultingUpdateIds: [upd],
      attachments: [],
      acknowledgedAt: time,
    },
  },
  'board.viewed': { cutoffAt: time },
  'board.reset': { resetAt: time, reason: 'Start again.' },
} as const;

const actors = {
  'update.upserted': 'agent',
  'update.archived': 'agent',
  'question.created': 'agent',
  'question.revised': 'agent',
  'question.cancelled': 'agent',
  'question.escalated': 'system',
  'question.staled': 'system',
  'question.dismissed': 'user',
  'question.answered': 'user',
  'answer.delivery_queued': 'system',
  'answer.delivery_failed': 'system',
  'answer.acknowledged': 'agent',
  'board.viewed': 'user',
  'board.reset': 'user',
} as const;

function event(type: keyof typeof payloads, index = 1): BoardEvent {
  const actor = actors[type];
  return {
    schemaVersion: 1,
    eventId: `evt_aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    eventType: type,
    occurredAt: time,
    actor,
    commandId: `${actor === 'agent' ? 'tool' : actor === 'user' ? 'ui' : 'system'}:test-${index}`,
    payload: payloads[type],
  } as BoardEvent;
}

function mutable(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

describe('event codec', () => {
  it('decodes every authoritative event example', () => {
    schemaPositiveEvents.forEach((input) => {
      expect(decodeBoardEvent(input).ok).toBe(true);
    });
  });

  it('FR-010 decodes and encodes all 14 schema-v1 events', () => {
    Object.keys(payloads).forEach((type, index) => {
      const input = event(type as keyof typeof payloads, index + 1);
      const decoded = decodeBoardEvent(input);
      expect(decoded, type).toMatchObject({ ok: true });
      expect(encodeBoardEvent(input)).toEqual(input);
    });
  });

  it('preserves a provider-qualified Pi command ID exactly', () => {
    const input = {
      ...event('update.upserted'),
      commandId: providerQualifiedCommandId,
    } as BoardEvent;
    const decoded = decodeBoardEvent(input);
    expect(decoded).toMatchObject({
      ok: true,
      event: { commandId: providerQualifiedCommandId },
    });
    expect(encodeBoardEvent(input)).toEqual(input);
  });

  it('returns fresh deeply immutable plain values', () => {
    const input = mutable(event('question.created'));
    const decoded = decodeBoardEvent(input);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.event).not.toBe(input);
    expect(Object.getPrototypeOf(decoded.event)).toBe(Object.prototype);
    expect(Object.isFrozen(decoded.event)).toBe(true);
    expect(Object.isFrozen(decoded.event.payload)).toBe(true);
    (input.payload as Record<string, unknown>).displayId = 'Q-9';
    expect((decoded.event.payload as { displayId: string }).displayId).toBe('Q-1');
  });

  it.each([
    [
      'unknown property',
      (value: Record<string, unknown>) => {
        value.extra = true;
      },
    ],
    [
      'wrong actor',
      (value: Record<string, unknown>) => {
        value.actor = 'user';
      },
    ],
    [
      'offset timestamp',
      (value: Record<string, unknown>) => {
        value.occurredAt = '2026-08-12T02:00:00.000-07:00';
      },
    ],
    [
      'forbidden controls',
      (value: Record<string, unknown>) => {
        ((value.payload as Record<string, unknown>).fields as Record<string, unknown>).title =
          'bad\u001b[31m';
      },
    ],
    [
      'nonfinite number',
      (value: Record<string, unknown>) => {
        ((value.payload as Record<string, unknown>).fields as Record<string, unknown>).progress = {
          current: Number.NaN,
          total: 1,
        };
      },
    ],
    [
      'invalid progress',
      (value: Record<string, unknown>) => {
        ((value.payload as Record<string, unknown>).fields as Record<string, unknown>).progress = {
          current: 2,
          total: 1,
        };
      },
    ],
  ])('rejects %s with a stable content-free error', (_name, change) => {
    const input = mutable(event('update.upserted'));
    change(input);
    expect(decodeBoardEvent(input)).toEqual({ ok: false, error: { code: 'SB_EVENT_INVALID' } });
  });

  it('classifies unsupported versions', () => {
    const input = mutable(event('board.reset'));
    input.schemaVersion = 2;
    expect(decodeBoardEvent(input)).toEqual({
      ok: false,
      error: { code: 'SB_EVENT_UNSUPPORTED_VERSION' },
    });
  });

  it('rejects accessors, cycles, arrays as records, custom prototypes, and pollution keys', () => {
    const accessor = mutable(event('board.reset'));
    Object.defineProperty(accessor, 'payload', {
      enumerable: true,
      get: () => payloads['board.reset'],
    });
    const cycle = mutable(event('board.reset'));
    (cycle.payload as Record<string, unknown>).cycle = cycle;
    const arrayPayload = mutable(event('board.reset'));
    arrayPayload.payload = [];
    const custom = mutable(event('board.reset'));
    Object.setPrototypeOf(custom.payload as object, { hostile: true });
    const polluted = JSON.parse(
      JSON.stringify(event('board.reset')).replace('"reason":', '"__proto__":{},"reason":'),
    ) as unknown;
    for (const input of [accessor, cycle, arrayPayload, custom, polluted])
      expect(decodeBoardEvent(input).ok).toBe(false);
  });

  it('uses Unicode code-point limits and does not rewrite persisted text', () => {
    const valid = mutable(event('update.upserted'));
    ((valid.payload as Record<string, unknown>).fields as Record<string, unknown>).title =
      '😀'.repeat(160);
    expect(decodeBoardEvent(valid).ok).toBe(true);
    const tooLong = structuredClone(valid);
    ((tooLong.payload as Record<string, unknown>).fields as Record<string, unknown>).title =
      '😀'.repeat(161);
    expect(decodeBoardEvent(tooLong).ok).toBe(false);
    const padded = mutable(event('update.upserted'));
    ((padded.payload as Record<string, unknown>).fields as Record<string, unknown>).title =
      ' Work ';
    expect(decodeBoardEvent(padded).ok).toBe(false);
  });

  it('accepts every attachment and optional update field', () => {
    const input = mutable(event('update.upserted'));
    const payload = input.payload as Record<string, unknown>;
    payload.completedAt = time;
    payload.fields = {
      key: 'complete-work',
      kind: 'completed',
      title: 'Complete',
      detail: 'Done.\nVerified.',
      stage: 'complete',
      progress: { current: 2, total: 2, unit: 'checks' },
      attachments: [
        { kind: 'file', label: 'File', path: 'src/a.ts', external: false },
        { kind: 'line_range', label: 'Lines', path: 'src/a.ts', startLine: 1, endLine: 2 },
        { kind: 'test_run', label: 'Test', reference: 'unit-1' },
        { kind: 'command', label: 'Command', reference: 'npm test' },
        { kind: 'url', label: 'URL', url: 'https://example.test/path' },
        { kind: 'note', label: 'Note', text: 'Evidence\nretained.' },
      ],
    };
    expect(decodeBoardEvent(input).ok).toBe(true);
  });

  it('accepts text and multiple question cross-field forms', () => {
    const textQuestion = mutable(event('question.created'));
    (textQuestion.payload as Record<string, unknown>).spec = {
      ...spec,
      class: 'information',
      response: { kind: 'text' },
      recommendation: 'Supply a value.',
      recommendedOptionIds: [],
      recommendedText: 'Value',
      expiresAt: '2026-08-12T10:00:00.000Z',
    };
    expect(decodeBoardEvent(textQuestion).ok).toBe(true);
    const multiple = mutable(event('question.created'));
    (multiple.payload as Record<string, unknown>).spec = {
      ...spec,
      response: { ...spec.response, kind: 'multiple' },
      recommendedOptionIds: ['one', 'two'],
      temporaryDefault: { optionIds: ['one', 'two'], disclosure: 'Use both.' },
    };
    expect(decodeBoardEvent(multiple).ok).toBe(true);
  });

  it.each([
    { kind: 'multiple', optionIds: ['one', 'two'] },
    { kind: 'text', text: 'An answer.' },
    { kind: 'single_or_text', text: 'Another answer.' },
    { kind: 'multiple_or_text', optionIds: [], text: 'Hybrid answer.' },
  ])('accepts answer value $kind', (value) => {
    const input = mutable(event('question.answered'));
    ((input.payload as Record<string, unknown>).answer as Record<string, unknown>).value = value;
    expect(decodeBoardEvent(input).ok).toBe(true);
  });

  it('rejects semantic cross-field and attachment failures', () => {
    const cases: Record<string, unknown>[] = [];
    const noCompletion = mutable(event('update.upserted'));
    ((noCompletion.payload as Record<string, unknown>).fields as Record<string, unknown>).kind =
      'failed';
    cases.push(noCompletion);
    const badStage = mutable(event('update.upserted'));
    const badStagePayload = badStage.payload as Record<string, unknown>;
    badStagePayload.completedAt = time;
    (badStagePayload.fields as Record<string, unknown>).kind = 'completed';
    (badStagePayload.fields as Record<string, unknown>).stage = 'testing';
    cases.push(badStage);
    const badRevision = mutable(event('question.revised'));
    (badRevision.payload as Record<string, unknown>).revision = 9;
    cases.push(badRevision);
    const badRecommendation = mutable(event('question.created'));
    (
      (badRecommendation.payload as Record<string, unknown>).spec as Record<string, unknown>
    ).recommendedOptionIds = ['missing'];
    cases.push(badRecommendation);
    const badDefault = mutable(event('question.created'));
    const badDefaultSpec = (badDefault.payload as Record<string, unknown>).spec as Record<
      string,
      unknown
    >;
    badDefaultSpec.class = 'preference';
    badDefaultSpec.temporaryDefault = { optionIds: ['one'], disclosure: 'Use one.' };
    cases.push(badDefault);
    const badLine = mutable(event('update.upserted'));
    ((badLine.payload as Record<string, unknown>).fields as Record<string, unknown>).attachments = [
      { kind: 'line_range', label: 'Lines', path: 'a', startLine: 2, endLine: 1 },
    ];
    cases.push(badLine);
    const badUrl = mutable(event('update.upserted'));
    ((badUrl.payload as Record<string, unknown>).fields as Record<string, unknown>).attachments = [
      { kind: 'url', label: 'URL', url: 'file:///tmp/private' },
    ];
    cases.push(badUrl);
    const badViewed = mutable(event('board.viewed'));
    (badViewed.payload as Record<string, unknown>).cutoffAt = '2026-08-12T10:00:00.000Z';
    cases.push(badViewed);

    const updateMutation = (
      change: (payload: Record<string, unknown>, fields: Record<string, unknown>) => void,
    ) => {
      const input = mutable(event('update.upserted'));
      const payload = input.payload as Record<string, unknown>;
      change(payload, payload.fields as Record<string, unknown>);
      cases.push(input);
    };
    updateMutation((payload) => {
      payload.extra = true;
    });
    updateMutation((_payload, fields) => {
      fields.extra = true;
    });
    updateMutation((_payload, fields) => {
      fields.key = '-bad';
    });
    updateMutation((_payload, fields) => {
      fields.detail = ' padded ';
    });
    updateMutation((_payload, fields) => {
      fields.stage = 'unknown';
    });
    updateMutation((_payload, fields) => {
      fields.attachments = [{ kind: 'mystery', label: 'X' }];
    });
    updateMutation((_payload, fields) => {
      fields.attachments = [{ kind: 'url', label: 'URL', url: 'https://[' }];
    });
    updateMutation((_payload, fields) => {
      fields.attachments = [{ kind: 'note', label: '', text: 'X' }];
    });

    const questionMutation = (change: (questionSpec: Record<string, unknown>) => void) => {
      const input = mutable(event('question.created'));
      change((input.payload as Record<string, unknown>).spec as Record<string, unknown>);
      cases.push(input);
    };
    questionMutation((value) => {
      value.extra = true;
    });
    questionMutation((value) => {
      value.priority = 'urgent';
    });
    questionMutation((value) => {
      value.recommendation = ' padded ';
    });
    questionMutation((value) => {
      value.recommendedText = ' padded ';
    });
    questionMutation((value) => {
      value.expiresAt = time;
    });
    questionMutation((value) => {
      value.recommendedOptionIds = ['one', 'two'];
    });
    questionMutation((value) => {
      value.response = { kind: 'single', options: [{ id: 'one', label: 'One' }] };
    });
    questionMutation((value) => {
      value.response = {
        kind: 'single',
        options: [
          { id: 'one', label: '' },
          { id: 'two', label: 'Two' },
        ],
      };
    });
    questionMutation((value) => {
      value.response = {
        kind: 'single',
        options: [
          { id: 'one', label: 'One', description: ' padded ' },
          { id: 'two', label: 'Two' },
        ],
      };
    });

    const badAnswer = mutable(event('question.answered'));
    delete ((badAnswer.payload as Record<string, unknown>).answer as Record<string, unknown>).id;
    cases.push(badAnswer);
    const unknownAnswer = mutable(event('question.answered'));
    ((unknownAnswer.payload as Record<string, unknown>).answer as Record<string, unknown>).value = {
      kind: 'unknown',
    };
    cases.push(unknownAnswer);
    const badDelivery = mutable(event('answer.delivery_queued'));
    (badDelivery.payload as Record<string, unknown>).attempt = 0;
    cases.push(badDelivery);

    cases.forEach((input) => {
      expect(decodeBoardEvent(input).ok).toBe(false);
    });
  });

  it('rejects invalid values on encode', () => {
    const input = mutable(event('board.reset'));
    (input.payload as Record<string, unknown>).reason = '';
    expect(() => encodeBoardEvent(input as unknown as BoardEvent)).toThrow('SB_EVENT_INVALID');
  });
});
