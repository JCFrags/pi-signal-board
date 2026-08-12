import { describe, expect, it } from 'vitest';

import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type { BoardEvent, BoardViewedEvent, UpdateUpsertedEvent } from '../../src/domain/events.js';
import type { EventId, UiCommandId } from '../../src/domain/ids.js';
import { createEmptyBoardState, reduceBoardEvent } from '../../src/domain/reducer.js';
import { selectCatchUp } from '../../src/domain/selectors.js';
import type { BoardState } from '../../src/domain/types.js';
import { replayBranch } from '../../src/persistence/replay.js';
import { BoardViewCheckpointService } from '../../src/services/board-view-checkpoint-service.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { makeCustomEntry } from '../helpers/fake-pi.js';

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
] as const;
const T0 = '2030-01-01T00:00:00.000Z';
const T1 = '2030-01-01T01:00:00.000Z';
const T2 = '2030-01-01T02:00:00.000Z';
const T3 = '2030-01-01T03:00:00.000Z';
const T4 = '2030-01-01T04:00:00.000Z';

interface FixtureOptions {
  readonly initial?: BoardState;
  readonly closeAt?: string;
  readonly throwClock?: boolean;
  readonly throwCommandId?: boolean;
  readonly throwEventId?: boolean;
  readonly refreshFailure?: boolean;
  readonly throwAppend?: boolean;
  readonly eventId?: EventId;
}

function fixture(options: FixtureOptions = {}) {
  let state = options.initial ?? createEmptyBoardState();
  let appendFailure = false;
  let commandCalls = 0;
  let eventCalls = 0;
  let refreshCalls = 0;
  const appended: BoardViewedEvent[] = [];
  const service = new BoardViewCheckpointService({
    queue: new MutationQueue(),
    readState: () => state,
    swapState: (next) => {
      state = next;
    },
    append: async (event) => {
      if (options.throwAppend) throw new Error('synthetic append throw');
      if (appendFailure) return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      appended.push(event);
      return succeed(undefined);
    },
    refresh: () => {
      refreshCalls += 1;
      if (options.refreshFailure) throw new Error('synthetic refresh failure');
    },
    clock: {
      now: () => {
        if (options.throwClock) throw new Error('synthetic clock failure');
        return new Date(options.closeAt ?? T4);
      },
    },
    ids: {
      command: () => {
        commandCalls += 1;
        if (options.throwCommandId) throw new Error('synthetic command ID failure');
        return `ui:00000000-0000-4000-8000-${(200 + commandCalls).toString().padStart(12, '0')}` as UiCommandId;
      },
      event: () => {
        eventCalls += 1;
        if (options.throwEventId) throw new Error('synthetic event ID failure');
        return (
          options.eventId ??
          (`evt_00000000-0000-4000-8000-${(100 + eventCalls).toString().padStart(12, '0')}` as EventId)
        );
      },
    },
  });
  return {
    service,
    appended,
    state: () => state,
    ids: () => ({ commandCalls, eventCalls }),
    refreshCalls: () => refreshCalls,
    failAppend: (value: boolean) => {
      appendFailure = value;
    },
  };
}

function update(state: BoardState, occurredAt: string, sequence: number): BoardState {
  const uuid = UUIDS[sequence - 1] as string;
  const event: UpdateUpsertedEvent = {
    schemaVersion: 1,
    eventId: `evt_${uuid}`,
    eventType: 'update.upserted',
    occurredAt,
    actor: 'agent',
    commandId: `tool:update-${sequence}`,
    payload: {
      updateId: `upd_${uuid}`,
      displayId: `U-${state.counters.nextUpdate}`,
      revision: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      fields: { kind: 'working', title: `Update ${sequence}`, attachments: [] },
    },
  };
  const reduced = reduceBoardEvent(state, event);
  if (!reduced.ok) throw new Error(`Fixture update rejected: ${reduced.code}`);
  return reduced.state;
}

function viewed(
  state: BoardState,
  cutoffAt: string,
  occurredAt: string,
  sequence: number,
): BoardState {
  const event: BoardViewedEvent = {
    schemaVersion: 1,
    eventId: `evt_${UUIDS[sequence - 1]}`,
    eventType: 'board.viewed',
    occurredAt,
    actor: 'user',
    commandId: `ui:${UUIDS[sequence]}`,
    payload: { cutoffAt },
  };
  const reduced = reduceBoardEvent(state, event);
  if (!reduced.ok) throw new Error(`Fixture checkpoint rejected: ${reduced.code}`);
  return reduced.state;
}

describe('SB-030 board view checkpoint service', () => {
  it('writes the first checkpoint with fixed open cutoff and fresh close time', async () => {
    const harness = fixture({ initial: update(createEmptyBoardState(), T2, 1), closeAt: T3 });
    const result = await harness.service.markViewed({ cutoffAt: T2 });

    expect(result).toMatchObject({ ok: true, value: { cutoffAt: T2, noOp: false } });
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]).toMatchObject({
      eventType: 'board.viewed',
      occurredAt: T3,
      actor: 'user',
      commandId: 'ui:00000000-0000-4000-8000-000000000201',
      payload: { cutoffAt: T2 },
    });
    expect(harness.state().lastViewedAt).toBe(T2);
    expect(harness.refreshCalls()).toBe(1);
  });

  it('acknowledges only changes strictly after the old cutoff and at or before openedAt', async () => {
    let state = update(createEmptyBoardState(), T0, 1);
    state = viewed(state, T0, T0, 2);
    state = update(state, T1, 3);
    state = update(state, T3, 4);
    const harness = fixture({ initial: state, closeAt: T4 });

    await harness.service.markViewed({ cutoffAt: T2 });

    expect(selectCatchUp(harness.state(), T4).items.map((item) => item.occurredAt)).toEqual([T3]);
    expect(harness.state().lastViewedAt).toBe(T2);
  });

  it('rejects a malformed cutoff without allocation or append', async () => {
    const harness = fixture({ initial: update(createEmptyBoardState(), T1, 1) });
    expect(await harness.service.markViewed({ cutoffAt: 'not-a-time' })).toMatchObject({
      ok: false,
      error: { code: 'SB_INVALID_ARGUMENT' },
    });
    expect(harness.ids()).toEqual({ commandCalls: 0, eventCalls: 0 });
    expect(harness.appended).toHaveLength(0);
  });

  it('allocates no identifier for empty, unchanged, equal, older, or repeated checkpoints', async () => {
    const empty = fixture();
    expect(await empty.service.markViewed({ cutoffAt: T2 })).toMatchObject({
      ok: true,
      value: { noOp: true },
    });
    expect(empty.ids()).toEqual({ commandCalls: 0, eventCalls: 0 });

    let state = update(createEmptyBoardState(), T1, 1);
    state = viewed(state, T2, T3, 2);
    const existing = fixture({ initial: state });
    for (const cutoffAt of [T1, T2, T3]) {
      expect(await existing.service.markViewed({ cutoffAt })).toMatchObject({
        ok: true,
        value: { noOp: true },
      });
    }
    expect(existing.appended).toHaveLength(0);
    expect(existing.ids()).toEqual({ commandCalls: 0, eventCalls: 0 });
  });

  it('keeps state unread on append failure and reuses both reserved identifiers on retry', async () => {
    const initial = update(createEmptyBoardState(), T1, 1);
    const harness = fixture({ initial, closeAt: T3 });
    harness.failAppend(true);

    const failed = await harness.service.markViewed({ cutoffAt: T2 });
    expect(failed).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(harness.state()).toBe(initial);
    expect(selectCatchUp(harness.state(), T2).items).toHaveLength(1);
    expect(harness.ids()).toEqual({ commandCalls: 1, eventCalls: 1 });

    harness.failAppend(false);
    const retried = await harness.service.markViewed({ cutoffAt: T2 });
    expect(retried).toMatchObject({ ok: true, value: { noOp: false } });
    expect(harness.ids()).toEqual({ commandCalls: 1, eventCalls: 1 });
    expect(harness.appended[0]?.commandId).toBe('ui:00000000-0000-4000-8000-000000000201');
    expect(harness.appended[0]?.eventId).toBe('evt_00000000-0000-4000-8000-000000000101');
  });

  it.each([
    ['clock', { throwClock: true }, { commandCalls: 0, eventCalls: 0 }],
    ['command ID', { throwCommandId: true }, { commandCalls: 1, eventCalls: 0 }],
    ['event ID', { throwEventId: true }, { commandCalls: 1, eventCalls: 1 }],
  ] as const)(
    'contains a %s failure without append or state change',
    async (_label, options, ids) => {
      const initial = update(createEmptyBoardState(), T1, 1);
      const harness = fixture({ initial, ...options });
      const result = await harness.service.markViewed({ cutoffAt: T2 });
      expect(result).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
      expect(harness.state()).toBe(initial);
      expect(harness.appended).toHaveLength(0);
      expect(harness.ids()).toEqual(ids);
    },
  );

  it('maps an append throw to the stable persistence error without a state swap', async () => {
    const initial = update(createEmptyBoardState(), T1, 1);
    const harness = fixture({ initial, throwAppend: true });
    expect(await harness.service.markViewed({ cutoffAt: T2 })).toMatchObject({
      ok: false,
      error: { code: 'SB_PERSISTENCE_FAILED' },
    });
    expect(harness.state()).toBe(initial);
  });

  it('rejects an event ID collision before append', async () => {
    const initial = update(createEmptyBoardState(), T1, 1);
    const harness = fixture({
      initial,
      eventId: 'evt_00000000-0000-4000-8000-000000000001',
    });
    expect(await harness.service.markViewed({ cutoffAt: T2 })).toMatchObject({
      ok: false,
      error: { code: 'SB_STATE_CONFLICT' },
    });
    expect(harness.appended).toHaveLength(0);
    expect(harness.state()).toBe(initial);
  });

  it('contains refresh failure after the accepted state swap and makes retry a no-op', async () => {
    const harness = fixture({
      initial: update(createEmptyBoardState(), T1, 1),
      refreshFailure: true,
    });
    expect(await harness.service.markViewed({ cutoffAt: T2 })).toMatchObject({
      ok: false,
      error: { code: 'SB_UI_UNAVAILABLE' },
    });
    expect(harness.state().lastViewedAt).toBe(T2);
    expect(harness.appended).toHaveLength(1);
    expect(await harness.service.markViewed({ cutoffAt: T2 })).toMatchObject({
      ok: true,
      value: { noOp: true },
    });
    expect(harness.appended).toHaveLength(1);
  });

  it('keeps the maximum cutoff for concurrent and reversed closes without duplicates', async () => {
    const initial = update(createEmptyBoardState(), T1, 1);
    const reversed = fixture({ initial, closeAt: T4 });
    const later = reversed.service.markViewed({ cutoffAt: T3 });
    const earlier = reversed.service.markViewed({ cutoffAt: T2 });
    await Promise.all([later, earlier]);
    expect(reversed.state().lastViewedAt).toBe(T3);
    expect(reversed.appended.map((event) => event.payload.cutoffAt)).toEqual([T3]);

    const equivalent = fixture({ initial, closeAt: T4 });
    await Promise.all([
      equivalent.service.markViewed({ cutoffAt: T2 }),
      equivalent.service.markViewed({ cutoffAt: T2 }),
    ]);
    expect(equivalent.appended).toHaveLength(1);
  });

  it('replays the accepted checkpoint identically and leaves a later event unread', async () => {
    const before = update(createEmptyBoardState(), T1, 1);
    const harness = fixture({ initial: before, closeAt: T3 });
    await harness.service.markViewed({ cutoffAt: T2 });
    const after = update(harness.state(), T4, 2);
    const events: BoardEvent[] = [
      eventForUpdate(T1, 1),
      harness.appended[0] as BoardViewedEvent,
      eventForUpdate(T4, 2),
    ];
    const replayed = replayBranch(
      events.map((event, index) =>
        makeCustomEntry({
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          data: event,
        }),
      ),
    );
    expect(normalize(replayed.state)).toEqual(normalize(after));
    expect(selectCatchUp(replayed.state, T4).items.map((item) => item.occurredAt)).toEqual([T4]);
  });

  it('preserves monotonic fixed-seed ordering and prints the seed on failure', async () => {
    const seed = 0x5b030;
    let randomState = seed;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    try {
      for (let run = 0; run < 100; run += 1) {
        const initial = update(createEmptyBoardState(), T0, 1);
        const harness = fixture({ initial, closeAt: T4 });
        const cutoffs = Array.from({ length: 5 }, () =>
          new Date(Date.parse(T1) + Math.floor(random() * 7_200_000)).toISOString(),
        );
        for (const cutoffAt of cutoffs) await harness.service.markViewed({ cutoffAt });
        const written = harness.appended.map((event) => event.payload.cutoffAt);
        expect(written).toEqual([...written].sort());
        expect(harness.state().lastViewedAt).toBe(written.at(-1));
      }
    } catch (error) {
      console.error(`board-view-checkpoint property seed=${seed} state=${randomState}`);
      throw error;
    }
  });
});

function eventForUpdate(occurredAt: string, sequence: number): UpdateUpsertedEvent {
  const state = sequence === 1 ? createEmptyBoardState() : update(createEmptyBoardState(), T1, 1);
  const uuid = UUIDS[sequence - 1] as string;
  return {
    schemaVersion: 1,
    eventId: `evt_${uuid}`,
    eventType: 'update.upserted',
    occurredAt,
    actor: 'agent',
    commandId: `tool:update-${sequence}`,
    payload: {
      updateId: `upd_${uuid}`,
      displayId: `U-${state.counters.nextUpdate}`,
      revision: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      fields: { kind: 'working', title: `Update ${sequence}`, attachments: [] },
    },
  };
}

function normalize(state: BoardState): unknown {
  return {
    ...state,
    updates: [...state.updates],
    questions: [...state.questions],
    answers: [...state.answers],
    acknowledgements: [...state.acknowledgements],
    commandResults: [...state.commandResults],
    acceptedEventIds: [...state.acceptedEventIds],
  };
}
