import { describe, expect, it } from 'vitest';

import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type { QuestionAnsweredEvent, QuestionCreatedEvent } from '../../src/domain/events.js';
import type { AnswerId, EventId } from '../../src/domain/ids.js';
import { createEmptyBoardState, reduceBoardEvent } from '../../src/domain/reducer.js';
import type {
  AnswerRecord,
  AnswerSource,
  AnswerValue,
  BoardState,
  QuestionItem,
  ResponseKind,
} from '../../src/domain/types.js';
import { replayBranch } from '../../src/persistence/replay.js';
import {
  AnswerPersistenceService,
  type PersistAnswerCommand,
} from '../../src/services/answer-persistence-service.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { createDeferred, FakeClock } from '../helpers/index.js';

const QUESTION_ID = 'qst_36000000-0000-4000-8000-000000000001' as const;
const ANSWER_1 = 'ans_36000000-0000-4000-8000-000000000001' as const;
const ANSWER_2 = 'ans_36000000-0000-4000-8000-000000000002' as const;
const EVENT_1 = 'evt_36000000-0000-4000-8000-000000000001' as const;
const EVENT_2 = 'evt_36000000-0000-4000-8000-000000000002' as const;
const CREATED_EVENT = 'evt_36000000-0000-4000-8000-000000000010' as const;
const ANSWERED_AT = '2026-08-12T15:36:00.000Z';

function question(kind: ResponseKind, overrides: Partial<QuestionItem> = {}): QuestionItem {
  const options =
    kind === 'text'
      ? []
      : [
          { id: 'one' as const, label: 'One' },
          { id: 'two' as const, label: 'Two' },
          { id: 'three' as const, label: 'Three' },
        ];
  return {
    id: QUESTION_ID,
    displayId: 'Q-36',
    revision: 3,
    status: 'pending',
    question: 'Synthetic decision?',
    reason: 'Synthetic reason.',
    class: 'preference',
    response: { kind, options } as QuestionItem['response'],
    recommendedOptionIds:
      kind === 'single' || kind === 'single_or_text'
        ? ['one']
        : kind === 'multiple' || kind === 'multiple_or_text'
          ? ['one', 'three']
          : [],
    ...(kind === 'text' || kind === 'single_or_text' || kind === 'multiple_or_text'
      ? { recommendedText: 'recommended text' }
      : {}),
    priority: 'normal',
    blockingPolicy: 'never',
    deliveryMode: 'steer',
    affectedWork: [],
    continuingWork: [],
    attachments: [],
    createdAt: '2026-08-12T15:00:00.000Z',
    updatedAt: '2026-08-12T15:00:00.000Z',
    lastEventId: CREATED_EVENT,
    lastCommandId: 'tool:create-36',
    ...overrides,
  } as QuestionItem;
}

function valueFor(kind: ResponseKind, source: AnswerSource): AnswerValue {
  if (source === 'recommendation') {
    switch (kind) {
      case 'single':
        return { kind, optionId: 'one' };
      case 'multiple':
        return { kind, optionIds: ['one', 'three'] };
      case 'text':
        return { kind, text: 'recommended text' };
      case 'single_or_text':
        return { kind, optionId: 'one', text: 'recommended text' };
      case 'multiple_or_text':
        return { kind, optionIds: ['one', 'three'], text: 'recommended text' };
    }
  }
  switch (kind) {
    case 'single':
      return { kind, optionId: 'two' };
    case 'multiple':
      return { kind, optionIds: ['one', 'two'] };
    case 'text':
      return { kind, text: 'manual text' };
    case 'single_or_text':
      return { kind, text: 'manual text' };
    case 'multiple_or_text':
      return { kind, optionIds: ['two'], text: 'manual text' };
  }
}

function initialState(item = question('single')): BoardState {
  return { ...createEmptyBoardState(), questions: new Map([[item.id, item]]) };
}

class ScriptedIds {
  readonly calls: string[] = [];
  readonly answers: AnswerId[];
  readonly events: EventId[];

  constructor(answers: AnswerId[] = [ANSWER_1], events: EventId[] = [EVENT_1]) {
    this.answers = [...answers];
    this.events = [...events];
  }

  answer = (): AnswerId => {
    this.calls.push('answer');
    const value = this.answers.shift();
    if (value === undefined) throw new Error('answer IDs exhausted');
    return value;
  };

  event = (): EventId => {
    this.calls.push('event');
    const value = this.events.shift();
    if (value === undefined) throw new Error('event IDs exhausted');
    return value;
  };
}

function fixture(
  options: {
    state?: BoardState;
    ids?: ScriptedIds;
    append?: (event: QuestionAnsweredEvent) => Promise<ReturnType<typeof succeed<void>>>;
    refresh?: () => void | Promise<void>;
    afterMutationLocked?: () => void | Promise<void>;
  } = {},
) {
  let state = options.state ?? initialState();
  const ids = options.ids ?? new ScriptedIds();
  const calls: string[] = [];
  const appended: QuestionAnsweredEvent[] = [];
  const service = new AnswerPersistenceService({
    queue: new MutationQueue(),
    readState: () => state,
    swapState: (next) => {
      calls.push('swap');
      state = next;
    },
    append: async (event) => {
      calls.push('append');
      appended.push(event);
      return options.append?.(event) ?? succeed(undefined);
    },
    refresh: async () => {
      calls.push('refresh');
      await options.refresh?.();
    },
    ...(options.afterMutationLocked === undefined
      ? {}
      : { afterMutationLocked: options.afterMutationLocked }),
    clock: new FakeClock(ANSWERED_AT),
    ids,
  });
  return { service, ids, calls, appended, state: () => state };
}

function command(
  kind: ResponseKind,
  source: AnswerSource = 'manual',
  overrides: Partial<PersistAnswerCommand> = {},
): PersistAnswerCommand {
  return {
    commandId: 'ui:answer-36',
    questionId: QUESTION_ID,
    expectedRevision: 3,
    source,
    value: valueFor(kind, source),
    ...overrides,
  };
}

function createdEvent(kind: ResponseKind): QuestionCreatedEvent {
  const item = question(kind, { revision: 1, displayId: 'Q-1' });
  return {
    schemaVersion: 1,
    eventId: CREATED_EVENT,
    eventType: 'question.created',
    occurredAt: item.createdAt,
    actor: 'agent',
    commandId: 'tool:create-36',
    payload: {
      questionId: item.id,
      displayId: 'Q-1',
      revision: 1,
      createdAt: item.createdAt,
      spec: {
        question: item.question,
        reason: item.reason,
        class: item.class,
        response: item.response,
        recommendedOptionIds: item.recommendedOptionIds,
        ...(item.recommendedText === undefined ? {} : { recommendedText: item.recommendedText }),
        priority: item.priority,
        blockingPolicy: item.blockingPolicy,
        deliveryMode: item.deliveryMode,
        affectedWork: [],
        continuingWork: [],
        attachments: [],
      },
    },
  };
}

describe('SB-036 answer persistence writer boundary', () => {
  it.each(
    (['single', 'multiple', 'text', 'single_or_text', 'multiple_or_text'] as const).flatMap(
      (kind) => (['manual', 'recommendation'] as const).map((source) => [kind, source] as const),
    ),
  )('persists exact %s %s answer data', async (kind, source) => {
    const item = question(kind);
    const target = fixture({ state: initialState(item) });
    const result = await target.service.answerQuestion(command(kind, source));

    expect(result).toMatchObject({
      ok: true,
      value: {
        noOp: false,
        answer: {
          id: ANSWER_1,
          questionId: QUESTION_ID,
          questionRevision: 3,
          source,
          deliveryStatus: 'recorded',
        },
        delivery: {
          answerId: ANSWER_1,
          questionId: QUESTION_ID,
          questionRevision: 3,
          source,
          status: 'recorded',
          mode: 'steer',
        },
      },
    });
    expect(target.appended).toHaveLength(1);
    expect(target.appended[0]).toEqual(
      (result as { ok: true; value: { event: unknown } }).value.event,
    );
    expect(target.calls).toEqual(['append', 'swap', 'refresh']);
    expect(target.ids.calls).toEqual(['answer', 'event']);
    expect(target.state().questions.get(QUESTION_ID)?.status).toBe('answered');
  });

  it('creates the exact immutable event snapshot and normalizes text and option order again', async () => {
    const target = fixture({ state: initialState(question('multiple_or_text')) });
    const mutableIds = ['three', 'one'] as const;
    const mutable: {
      kind: 'multiple_or_text';
      optionIds: Array<'one' | 'three'>;
      text: string;
    } = {
      kind: 'multiple_or_text',
      optionIds: [...mutableIds],
      text: '  first\r\nsecond  ',
    };
    const result = await target.service.answerQuestion(
      command('multiple_or_text', 'manual', { value: mutable as unknown as AnswerValue }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        answer: {
          id: ANSWER_1,
          questionId: QUESTION_ID,
          questionDisplayId: 'Q-36',
          questionRevision: 3,
          source: 'manual',
          value: {
            kind: 'multiple_or_text',
            optionIds: ['one', 'three'],
            text: 'first\nsecond',
          },
          answeredAt: ANSWERED_AT,
          deliveryStatus: 'recorded',
          deliveryAttempts: [],
          lastEventId: EVENT_1,
        },
        event: {
          schemaVersion: 1,
          eventId: EVENT_1,
          eventType: 'question.answered',
          occurredAt: ANSWERED_AT,
          actor: 'user',
          commandId: 'ui:answer-36',
          payload: {
            questionId: QUESTION_ID,
            expectedRevision: 3,
            answer: {
              id: ANSWER_1,
              questionId: QUESTION_ID,
              questionDisplayId: 'Q-36',
              questionRevision: 3,
              source: 'manual',
              value: {
                kind: 'multiple_or_text',
                optionIds: ['one', 'three'],
                text: 'first\nsecond',
              },
              answeredAt: ANSWERED_AT,
            },
          },
        },
        delivery: {
          answerId: ANSWER_1,
          questionId: QUESTION_ID,
          questionRevision: 3,
          value: {
            kind: 'multiple_or_text',
            optionIds: ['one', 'three'],
            text: 'first\nsecond',
          },
          source: 'manual',
          status: 'recorded',
          mode: 'steer',
        },
        noOp: false,
      },
    });
    expect(Object.isFrozen((result as { ok: true; value: object }).value)).toBe(true);
    mutable.optionIds.reverse();
    mutable.text = 'changed';
    expect(target.state().answers.get(ANSWER_1)?.value).toMatchObject({
      optionIds: ['one', 'three'],
      text: 'first\nsecond',
    });
  });

  it.each([
    ['wrong kind', { kind: 'text', text: 'x' }, 'SB_INVALID_ARGUMENT'],
    ['unknown option', { kind: 'single', optionId: 'secret-board-content' }, 'SB_INVALID_ARGUMENT'],
    [
      'extra property',
      { kind: 'single', optionId: 'one', secret: 'private' },
      'SB_INVALID_ARGUMENT',
    ],
    ['invalid source', { kind: 'single', optionId: 'one' }, 'SB_INVALID_ARGUMENT'],
  ] as const)('rejects %s without allocation or append', async (label, value, code) => {
    const target = fixture();
    const source = label === 'invalid source' ? ('other' as AnswerSource) : 'manual';
    const result = await target.service.answerQuestion(
      command('single', source, { value: value as AnswerValue }),
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(target.ids.calls).toEqual([]);
    expect(target.appended).toEqual([]);
  });

  it('enforces one answer and makes same-intent retries duplicate-safe across command IDs', async () => {
    const target = fixture();
    const first = await target.service.answerQuestion(command('single'));
    const retry = await target.service.answerQuestion(command('single'));
    const newCommandRetry = await target.service.answerQuestion(
      command('single', 'manual', { commandId: 'ui:answer-retry-36' }),
    );
    const conflict = await target.service.answerQuestion(
      command('single', 'manual', {
        commandId: 'ui:answer-conflict-36',
        value: { kind: 'single', optionId: 'one' },
      }),
    );

    expect(first).toMatchObject({ ok: true, value: { noOp: false } });
    expect(retry).toMatchObject({ ok: true, value: { noOp: true, event: { eventId: EVENT_1 } } });
    expect(newCommandRetry).toMatchObject({
      ok: true,
      value: { noOp: true, event: { eventId: EVENT_1, commandId: 'ui:answer-36' } },
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
    expect(target.appended).toHaveLength(1);
    expect(target.ids.calls).toEqual(['answer', 'event']);
  });

  it.each([
    ['missing', initialState(), 'missing', 'SB_NOT_FOUND'],
    [
      'stale revision',
      initialState(question('single', { revision: 4 })),
      'stale',
      'SB_REVISION_MISMATCH',
    ],
    [
      'dismissed',
      initialState(question('single', { status: 'dismissed' })),
      'dismissed',
      'SB_STATE_CONFLICT',
    ],
    [
      'expired',
      initialState(question('single', { status: 'stale' })),
      'expired',
      'SB_STATE_CONFLICT',
    ],
    [
      'cancelled',
      initialState(question('single', { status: 'cancelled' })),
      'cancelled',
      'SB_STATE_CONFLICT',
    ],
  ] as const)('rejects %s current state without allocation', async (_label, state, mode, code) => {
    const actual = mode === 'missing' ? { ...state, questions: new Map() } : state;
    const target = fixture({ state: actual });
    expect(await target.service.answerQuestion(command('single'))).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(target.ids.calls).toEqual([]);
    expect(target.appended).toEqual([]);
  });

  it('leaves no visible answer on append rejection and allocates fresh IDs on retry', async () => {
    let attempts = 0;
    const ids = new ScriptedIds([ANSWER_1, ANSWER_2], [EVENT_1, EVENT_2]);
    const target = fixture({
      ids,
      append: async () => {
        attempts += 1;
        return attempts === 1
          ? (fail(signalBoardError('SB_PERSISTENCE_FAILED')) as ReturnType<typeof succeed<void>>)
          : succeed(undefined);
      },
    });
    const rejected = await target.service.answerQuestion(command('single'));
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'SB_PERSISTENCE_FAILED',
        message: 'Signals could not save the change. No success was recorded.',
      },
    });
    expect(target.state().answers.size).toBe(0);
    expect(target.state().questions.get(QUESTION_ID)?.status).toBe('pending');

    const accepted = await target.service.answerQuestion(command('single'));
    expect(accepted).toMatchObject({
      ok: true,
      value: { answer: { id: ANSWER_2 }, event: { eventId: EVENT_2 } },
    });
    expect(ids.calls).toEqual(['answer', 'event', 'answer', 'event']);
    expect(target.appended).toHaveLength(2);
  });

  it('skips replay-state ID collisions only after all preconditions pass', async () => {
    const collisionAnswer = {
      id: ANSWER_1,
      questionId: QUESTION_ID,
      questionDisplayId: 'Q-36',
      questionRevision: 2,
      source: 'manual',
      value: { kind: 'single', optionId: 'one' },
      answeredAt: '2026-08-12T15:20:00.000Z',
      deliveryStatus: 'recorded',
      deliveryAttempts: [],
      lastEventId: EVENT_2,
    } as AnswerRecord;
    const state = {
      ...initialState(),
      answers: new Map([[ANSWER_1, collisionAnswer]]),
      acceptedEventIds: new Map([[EVENT_1, 'collision']]),
    };
    const ids = new ScriptedIds([ANSWER_1, ANSWER_2], [EVENT_1, EVENT_2]);
    const target = fixture({ state, ids });
    expect(await target.service.answerQuestion(command('single'))).toMatchObject({
      ok: true,
      value: { answer: { id: ANSWER_2 }, event: { eventId: EVENT_2 } },
    });
    expect(ids.calls).toEqual(['answer', 'answer', 'event', 'event']);
  });

  it('replays the persisted projection exactly', async () => {
    const created = createdEvent('single');
    const reduced = reduceBoardEvent(createEmptyBoardState(), created);
    expect(reduced.ok).toBe(true);
    const target = fixture({ state: (reduced as { ok: true; state: BoardState }).state });
    const result = await target.service.answerQuestion(
      command('single', 'manual', { expectedRevision: 1 }),
    );
    expect(result).toMatchObject({ ok: true });
    const answered = (result as { ok: true; value: { event: QuestionAnsweredEvent } }).value.event;
    const replay = replayBranch([
      { type: 'custom', customType: 'pi-signal-board/event', data: created },
      { type: 'custom', customType: 'pi-signal-board/event', data: answered },
    ]);
    expect(replay.skippedEvents).toBe(0);
    expect(replay.state.answers.get(ANSWER_1)).toEqual(target.state().answers.get(ANSWER_1));
    expect(replay.state.questions.get(QUESTION_ID)).toEqual(
      target.state().questions.get(QUESTION_ID),
    );
  });

  it('serializes concurrent attempts with barriers and appends exactly once', async () => {
    const entered = createDeferred<void>('append-entered');
    const release = createDeferred<void>('append-release');
    let appendCount = 0;
    const target = fixture({
      append: async () => {
        appendCount += 1;
        entered.resolve();
        await release.promise;
        return succeed(undefined);
      },
    });
    const first = target.service.answerQuestion(command('single'));
    await entered.promise;
    const second = target.service.answerQuestion(
      command('single', 'manual', { commandId: 'ui:concurrent-36' }),
    );
    expect(appendCount).toBe(1);
    release.resolve();
    expect(await first).toMatchObject({ ok: true, value: { noOp: false } });
    expect(await second).toMatchObject({ ok: true, value: { noOp: true } });
    expect(appendCount).toBe(1);
    expect(target.calls.indexOf('append')).toBeLessThan(target.calls.indexOf('swap'));
  });

  it('uses content-free stable diagnostics for a conflicting duplicate', async () => {
    const target = fixture();
    await target.service.answerQuestion(command('single'));
    const result = await target.service.answerQuestion(
      command('single', 'manual', {
        commandId: 'ui:private-conflict',
        value: { kind: 'single', optionId: 'one' },
      }),
    );
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
    expect(serialized).not.toContain('Synthetic decision');
    expect(serialized).not.toContain('private-conflict');
    expect(serialized).not.toContain('optionId');
  });

  it('rejects a non-matching recommendation before allocation', async () => {
    const target = fixture();
    expect(
      await target.service.answerQuestion(
        command('single', 'recommendation', {
          value: { kind: 'single', optionId: 'two' },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });
    expect(target.ids.calls).toEqual([]);
  });

  it.each([
    ['commandId', { commandId: 'tool:not-user' }],
    ['questionId', { questionId: 'qst_invalid' }],
    ['expectedRevision', { expectedRevision: 0 }],
  ] as const)('revalidates invalid %s at the service boundary', async (_label, override) => {
    const target = fixture();
    expect(
      await target.service.answerQuestion(
        command('single', 'manual', override as Partial<PersistAnswerCommand>),
      ),
    ).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });
    expect(target.ids.calls).toEqual([]);
  });

  it.each([
    ['multiple empty', 'multiple', { kind: 'multiple', optionIds: [] }],
    ['multiple duplicate', 'multiple', { kind: 'multiple', optionIds: ['one', 'one'] }],
    ['multiple non-array', 'multiple', { kind: 'multiple', optionIds: 'one' }],
    ['text empty', 'text', { kind: 'text', text: '   ' }],
    ['text wrong type', 'text', { kind: 'text', text: 7 }],
    ['single hybrid empty', 'single_or_text', { kind: 'single_or_text' }],
    ['single hybrid wrong option type', 'single_or_text', { kind: 'single_or_text', optionId: 7 }],
    ['multiple hybrid empty', 'multiple_or_text', { kind: 'multiple_or_text', optionIds: [] }],
    [
      'multiple hybrid unknown option',
      'multiple_or_text',
      { kind: 'multiple_or_text', optionIds: ['unknown'] },
    ],
  ] as const)('rejects malformed %s schema without allocation', async (_label, kind, value) => {
    const target = fixture({ state: initialState(question(kind as ResponseKind)) });
    expect(
      await target.service.answerQuestion(
        command(kind as ResponseKind, 'manual', { value: value as unknown as AnswerValue }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });
    expect(target.ids.calls).toEqual([]);
  });

  it.each([
    ['single option only', 'single_or_text', { kind: 'single_or_text', optionId: 'two' }],
    [
      'multiple options only',
      'multiple_or_text',
      { kind: 'multiple_or_text', optionIds: ['three', 'one'] },
    ],
  ] as const)('accepts and normalizes %s hybrid form', async (_label, kind, value) => {
    const target = fixture({ state: initialState(question(kind as ResponseKind)) });
    expect(
      await target.service.answerQuestion(
        command(kind as ResponseKind, 'manual', { value: value as unknown as AnswerValue }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('converts thrown append and ID adapter failures to stable content-free errors', async () => {
    const appendTarget = fixture({
      append: async () => {
        throw new Error('private append exception');
      },
    });
    expect(await appendTarget.service.answerQuestion(command('single'))).toMatchObject({
      ok: false,
      error: { code: 'SB_PERSISTENCE_FAILED' },
    });
    expect(appendTarget.state().answers.size).toBe(0);

    const ids = new ScriptedIds([], []);
    const idTarget = fixture({ ids });
    const result = await idTarget.service.answerQuestion(command('single'));
    expect(result).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(idTarget.appended).toEqual([]);
  });

  it('keeps a durable answer when refresh and post-mutation work reject', async () => {
    const target = fixture({
      refresh: () => {
        throw new Error('private UI content');
      },
      afterMutationLocked: () => {
        throw new Error('private lifecycle content');
      },
    });
    expect(await target.service.answerQuestion(command('single'))).toMatchObject({
      ok: false,
      error: { code: 'SB_UI_UNAVAILABLE' },
    });
    expect(target.appended).toHaveLength(1);
    expect(target.state().answers.has(ANSWER_1)).toBe(true);
  });

  it('rejects a conflicting reuse of the accepted command ID', async () => {
    const target = fixture();
    await target.service.answerQuestion(command('single'));
    expect(
      await target.service.answerQuestion(
        command('single', 'manual', { value: { kind: 'single', optionId: 'one' } }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
    expect(target.appended).toHaveLength(1);
  });

  it('prints the fixed property seed while checking normalization and immutability', async () => {
    const seed = 0x5b036;
    let randomState = seed;
    const next = () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState;
    };
    try {
      for (let run = 0; run < 100; run += 1) {
        const order = (next() & 1) === 0 ? ['three', 'one'] : ['one', 'three'];
        const target = fixture({
          state: initialState(question('multiple')),
          ids: new ScriptedIds(
            [`ans_36000000-0000-4000-8000-${(run + 10).toString().padStart(12, '0')}` as AnswerId],
            [`evt_36000000-0000-4000-8000-${(run + 10).toString().padStart(12, '0')}` as EventId],
          ),
        });
        const result = await target.service.answerQuestion(
          command('multiple', 'manual', {
            value: { kind: 'multiple', optionIds: order as ['one', 'three'] },
          }),
        );
        expect(result, `seed=${seed} case=${run}`).toMatchObject({
          ok: true,
          value: { answer: { value: { optionIds: ['one', 'three'] } } },
        });
        expect(
          Object.isFrozen(target.state().answers.values().next().value),
          `seed=${seed} case=${run}`,
        ).toBe(true);
      }
    } catch (error) {
      console.error(`answer-persistence property seed=${seed} state=${randomState}`);
      throw error;
    }
  });
});
