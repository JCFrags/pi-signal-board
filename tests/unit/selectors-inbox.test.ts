import { describe, expect, it } from 'vitest';

import type { AnswerId, QuestionId } from '../../src/domain/ids.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import {
  selectActionableQuestionProjections,
  selectInboxQuestionProjections,
  selectQuestionDetail,
} from '../../src/domain/selectors.js';
import type {
  AnswerAcknowledgement,
  AnswerRecord,
  BoardState,
  DeliveryAttempt,
  QuestionItem,
  QuestionStatus,
} from '../../src/domain/types.js';

const time = (minute: number): string =>
  `2026-08-12T08:${minute.toString().padStart(2, '0')}:00.000Z`;
const questionId = (value: number): QuestionId =>
  `qst_25000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const answerId = (value: number): AnswerId =>
  `ans_25000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function question(
  sequence: number,
  status: QuestionStatus,
  createdMinute = sequence,
  overrides: Partial<QuestionItem> = {},
): QuestionItem {
  return {
    id: questionId(sequence),
    displayId: `Q-${sequence}`,
    revision: 1,
    question: `Question ${sequence}?`,
    reason: `Reason ${sequence}.`,
    class: 'reversible',
    response: {
      kind: 'single',
      options: [
        { id: 'first', label: 'First' },
        { id: 'second', label: 'Second' },
      ],
    },
    recommendedOptionIds: ['first'],
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [`work-${sequence}`],
    continuingWork: [],
    attachments: [],
    status,
    createdAt: time(createdMinute),
    updatedAt: time(createdMinute),
    lastEventId: `evt_25000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    lastCommandId: `tool:question-${sequence}`,
    ...overrides,
  } as QuestionItem;
}

function answer(sequence: number, attempts: readonly DeliveryAttempt[] = []): AnswerRecord {
  return {
    id: answerId(sequence),
    questionId: questionId(sequence),
    questionDisplayId: `Q-${sequence}`,
    questionRevision: 1,
    source: 'manual',
    value: { kind: 'single', optionId: 'first' },
    answeredAt: time(30),
    deliveryStatus: attempts.at(-1)?.outcome === 'failed' ? 'failed' : 'queued',
    deliveryAttempts: attempts,
    lastEventId: `evt_35000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
  };
}

function acknowledgement(sequence: number): AnswerAcknowledgement {
  return {
    answerId: answerId(sequence),
    questionId: questionId(sequence),
    outcome: 'cannot_apply',
    summary: 'The answer needs another decision.',
    resultingUpdateIds: [],
    attachments: [{ kind: 'note', label: 'Detail', text: 'Safe local note.' }],
    acknowledgedAt: time(40),
    eventId: `evt_45000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
    commandId: `tool:ack-${sequence}`,
  };
}

function state(
  questions: readonly QuestionItem[],
  answers: readonly AnswerRecord[] = [],
  acknowledgements: readonly AnswerAcknowledgement[] = [],
): BoardState {
  return {
    ...createEmptyBoardState(),
    questions: new Map(questions.map((item) => [item.id, item])),
    answers: new Map(answers.map((item) => [item.id, item])),
    acknowledgements: new Map(acknowledgements.map((item) => [item.answerId, item])),
  };
}

function inboxFixture(): {
  readonly questions: readonly QuestionItem[];
  readonly answers: readonly AnswerRecord[];
  readonly acknowledgements: readonly AnswerAcknowledgement[];
} {
  const failedAttempts: DeliveryAttempt[] = [
    { attempt: 1, at: time(31), mode: 'steer', outcome: 'failed', errorCode: 'FIRST' },
    {
      attempt: 2,
      at: time(32),
      mode: 'steer',
      outcome: 'failed',
      errorCode: 'SB_DELIVERY_FAILED',
      errorCategory: 'host_rejected',
    },
  ];
  return {
    questions: [
      question(1, 'pending'),
      question(12, 'delivery_queued', 12, { answerId: answerId(12) }),
      question(8, 'pending', 8),
      question(7, 'pending', 7, { priority: 'high' }),
      question(6, 'blocking', 6),
      question(5, 'needs_attention', 5, { answerId: answerId(5) }),
      question(4, 'delivery_failed', 4, { answerId: answerId(4) }),
      question(3, 'answered', 3, { answerId: answerId(3) }),
      question(20, 'resolved', 20, { answerId: answerId(20), resolvedAt: time(20) }),
      question(21, 'stale', 21, {
        expiresAt: time(18),
        staleAt: time(21),
        staleReason: 'The original expiry passed.',
      }),
      question(22, 'cancelled', 22, { cancelledAt: time(22) }),
      question(23, 'dismissed', 23, { dismissedAt: time(23) }),
    ],
    answers: [answer(3), answer(4, failedAttempts), answer(5), answer(12)],
    acknowledgements: [acknowledgement(5)],
  };
}

describe('SB-025 Inbox and question projections', () => {
  it('returns an empty immutable Inbox projection', () => {
    const projected = selectInboxQuestionProjections(createEmptyBoardState());
    expect(projected).toEqual([]);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it('sorts every Inbox category, then oldest question and stable display ID', () => {
    const fixture = inboxFixture();
    const tied = [
      question(31, 'pending', 9, { displayId: 'Q-31' }),
      question(30, 'pending', 9, { displayId: 'Q-30' }),
    ];
    const projected = selectInboxQuestionProjections(
      state([...fixture.questions.slice(1), ...tied], fixture.answers, fixture.acknowledgements),
    );
    expect(projected.map(({ item, category }) => [item.displayId, category])).toEqual([
      ['Q-4', 'delivery_failed'],
      ['Q-5', 'needs_attention'],
      ['Q-6', 'blocking'],
      ['Q-7', 'high_pending'],
      ['Q-8', 'normal_pending'],
      ['Q-30', 'normal_pending'],
      ['Q-31', 'normal_pending'],
      ['Q-3', 'sent'],
      ['Q-12', 'sent'],
    ]);
  });

  it('excludes all terminal questions and keeps answer actions distinct from attention states', () => {
    const fixture = inboxFixture();
    const projected = selectActionableQuestionProjections(
      state(fixture.questions.slice(1), fixture.answers, fixture.acknowledgements),
    );
    expect(projected.map(({ item }) => item.status)).toEqual([
      'delivery_failed',
      'needs_attention',
      'blocking',
      'pending',
      'pending',
    ]);
    expect(
      projected.map(({ userAnswerable, retryableDelivery, attentionState }) => ({
        userAnswerable,
        retryableDelivery,
        attentionState,
      })),
    ).toEqual([
      { userAnswerable: false, retryableDelivery: true, attentionState: 'delivery_failed' },
      { userAnswerable: false, retryableDelivery: false, attentionState: 'needs_attention' },
      { userAnswerable: true, retryableDelivery: false, attentionState: undefined },
      { userAnswerable: true, retryableDelivery: false, attentionState: undefined },
      { userAnswerable: true, retryableDelivery: false, attentionState: undefined },
    ]);
  });

  it('projects delivery and acknowledgement detail without reading time', () => {
    const fixture = inboxFixture();
    const projected = selectInboxQuestionProjections(
      state(fixture.questions.slice(1), fixture.answers, fixture.acknowledgements),
    );
    const failed = projected.find(({ item }) => item.status === 'delivery_failed');
    const attention = projected.find(({ item }) => item.status === 'needs_attention');
    const recorded = projected.find(({ item }) => item.status === 'answered');
    const sent = projected.find(({ item }) => item.status === 'delivery_queued');
    expect(failed).toMatchObject({
      retryableDelivery: true,
      awaitingAcknowledgement: false,
      latestDeliveryAttempt: { attempt: 2, errorCode: 'SB_DELIVERY_FAILED' },
      answer: { deliveryStatus: 'failed' },
    });
    expect(attention).toMatchObject({
      userAnswerable: false,
      acknowledgement: { outcome: 'cannot_apply', summary: 'The answer needs another decision.' },
    });
    expect(recorded).toMatchObject({
      deliveryPending: true,
      awaitingAcknowledgement: false,
      category: 'sent',
    });
    expect(sent).toMatchObject({
      deliveryPending: false,
      awaitingAcknowledgement: true,
      category: 'sent',
    });
  });

  it('retains stale reason and original expiry only in terminal detail', () => {
    const fixture = inboxFixture();
    const current = state(fixture.questions, fixture.answers, fixture.acknowledgements);
    expect(selectQuestionDetail(current, questionId(21))).toMatchObject({
      item: { status: 'stale' },
      stale: {
        reason: 'The original expiry passed.',
        originalExpiry: time(18),
        staleAt: time(21),
      },
    });
    expect(selectQuestionDetail(current, questionId(8))?.stale).toBeUndefined();
    expect(selectQuestionDetail(current, questionId(99))).toBeUndefined();
  });

  it('returns replay-equivalent results independent of map insertion order', () => {
    const fixture = inboxFixture();
    const forward = state(fixture.questions, fixture.answers, fixture.acknowledgements);
    const reverse = state(
      [...fixture.questions].reverse(),
      [...fixture.answers].reverse(),
      [...fixture.acknowledgements].reverse(),
    );
    expect(selectInboxQuestionProjections(forward)).toEqual(
      selectInboxQuestionProjections(reverse),
    );
  });

  it('deep-freezes copies and retains no mutable question, answer, or acknowledgement aliases', () => {
    const fixture = inboxFixture();
    const source = state(fixture.questions.slice(1), fixture.answers, fixture.acknowledgements);
    const projected = selectInboxQuestionProjections(source);
    const failed = projected[0];
    const attention = projected[1];
    if (failed === undefined || attention === undefined)
      throw new Error('Missing fixture projection.');
    expect(failed.item).not.toBe(source.questions.get(failed.item.id));
    expect(failed.answer).not.toBe(source.answers.get(failed.item.answerId as AnswerId));
    expect(attention.acknowledgement).not.toBe(
      source.acknowledgements.get(attention.item.answerId as AnswerId),
    );
    expect(Object.isFrozen(failed.item.response)).toBe(true);
    expect(Object.isFrozen(failed.answer?.deliveryAttempts)).toBe(true);
    expect(Object.isFrozen(attention.acknowledgement?.attachments[0])).toBe(true);
    expect(() => (failed.item.affectedWork as string[]).push('caller mutation')).toThrow(TypeError);
    expect(() => (failed.answer?.deliveryAttempts as DeliveryAttempt[]).pop()).toThrow(TypeError);
    expect(() => (attention.acknowledgement?.attachments as unknown as unknown[]).push({})).toThrow(
      TypeError,
    );
  });

  it('keeps ordering deterministic across fixed-seed insertion permutations', () => {
    const seed = 0x5b025;
    let stateValue = seed;
    const random = (): number => {
      stateValue = (Math.imul(stateValue, 1_664_525) + 1_013_904_223) >>> 0;
      return stateValue / 0x1_0000_0000;
    };
    const fixture = inboxFixture();
    const expected = selectInboxQuestionProjections(
      state(fixture.questions, fixture.answers, fixture.acknowledgements),
    ).map(({ item }) => item.id);
    try {
      for (let run = 0; run < 100; run += 1) {
        const shuffled = [...fixture.questions];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const swap = Math.floor(random() * (index + 1));
          [shuffled[index], shuffled[swap]] = [
            shuffled[swap] as QuestionItem,
            shuffled[index] as QuestionItem,
          ];
        }
        expect(
          selectInboxQuestionProjections(
            state(shuffled, fixture.answers, fixture.acknowledgements),
          ).map(({ item }) => item.id),
        ).toEqual(expected);
      }
    } catch (error) {
      console.error(`inbox-projection property seed=${seed} state=${stateValue}`);
      throw error;
    }
  });
});
