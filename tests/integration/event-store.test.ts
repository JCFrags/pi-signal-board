import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  convertUnexpectedError,
  type Result,
  signalBoardError,
  succeed,
} from '../../src/domain/errors.js';
import type { BoardEvent, UpdateUpsertedEvent } from '../../src/domain/events.js';
import { createEmptyBoardState, reduceBoardEvent } from '../../src/domain/reducer.js';
import type { BoardState } from '../../src/domain/types.js';
import { createPiSessionStore, PiSessionStore } from '../../src/persistence/pi-session-store.js';
import {
  type AcceptedTransaction,
  runLockedAppendTransaction,
} from '../../src/services/append-transaction.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { createDeferred } from '../helpers/deferred.js';
import { FakePiHarness } from '../helpers/fake-pi.js';

const AT = '2026-08-08T20:00:00.000Z';
const UPDATE_ID = 'upd_10000000-0000-4000-8000-000000000001' as const;

class CorrelationIds {
  next = 0;
  nextCorrelationId(): string {
    this.next += 1;
    return `sb-store-${this.next}`;
  }
}

function event(input: {
  sequence: number;
  command: string;
  displayId: `U-${number}`;
  revision?: number;
  title: string;
  key?: string;
  updateId?: `upd_${string}`;
  createdAt?: string;
}): UpdateUpsertedEvent {
  const revision = input.revision ?? 1;
  return {
    schemaVersion: 1,
    eventId: `evt_40000000-0000-4000-8000-${input.sequence.toString().padStart(12, '0')}`,
    eventType: 'update.upserted',
    occurredAt: AT,
    actor: 'agent',
    commandId: `tool:${input.command}`,
    payload: {
      updateId: input.updateId ?? UPDATE_ID,
      displayId: input.displayId,
      revision,
      createdAt: input.createdAt ?? AT,
      updatedAt: AT,
      fields: {
        ...(input.key === undefined ? {} : { key: input.key }),
        kind: 'working',
        title: input.title,
        attachments: [],
      },
    },
  };
}

function internalError(cause: unknown) {
  return convertUnexpectedError(cause, {
    correlationIds: new CorrelationIds(),
    at: AT,
    area: 'ui',
  });
}

interface TransactionHarness {
  readonly queue: MutationQueue;
  state: BoardState;
  readonly refreshLog: string[];
  readonly acceptedByCommand: Map<string, BoardEvent>;
  append: (event: BoardEvent) => Promise<Result<void>>;
  refresh: (state: BoardState) => void | Promise<void>;
}

function transact(
  harness: TransactionHarness,
  create: (state: BoardState) => UpdateUpsertedEvent,
): Promise<Result<AcceptedTransaction<BoardEvent, string>>> {
  return runLockedAppendTransaction<BoardState, BoardEvent, string>({
    queue: harness.queue,
    readState: () => harness.state,
    prepare: (state) => {
      const proposed: BoardEvent = create(state);
      return succeed({ event: proposed, value: proposed.payload.fields.title });
    },
    reduce: (state, proposed) => reduceBoardEvent(state, proposed),
    append: async (accepted) => {
      const result = await harness.append(accepted);
      if (result.ok) harness.acceptedByCommand.set(accepted.commandId, accepted);
      return result;
    },
    swapState: (state) => {
      harness.state = state;
    },
    refresh: (state) => harness.refresh(state),
    resolveIdempotent: (_state, proposed) => {
      const prior = harness.acceptedByCommand.get(proposed.event.commandId);
      return prior === undefined
        ? { ok: false, error: signalBoardError('SB_STATE_CONFLICT') }
        : succeed({ event: prior, value: proposed.value });
    },
    mapRefreshThrow: internalError,
  });
}

function makeTransactionHarness(store: PiSessionStore): TransactionHarness {
  const refreshLog: string[] = [];
  return {
    queue: new MutationQueue(),
    state: createEmptyBoardState(),
    refreshLog,
    acceptedByCommand: new Map(),
    append: (accepted) => store.append(accepted),
    refresh: (state) => {
      refreshLog.push([...state.updates.values()].map((item) => item.title).join(','));
    },
  };
}

function makeStore(harness: FakePiHarness, diagnostics: unknown[] = []): PiSessionStore {
  return new PiSessionStore(harness.api, {
    correlationIds: new CorrelationIds(),
    at: () => AT,
    diagnostics: {
      recordUnexpectedError(record) {
        diagnostics.push(record);
      },
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PiSessionStore', () => {
  it('calls exactly appendEntry with the event custom type and complete event data', async () => {
    const pi = new FakePiHarness();
    const store = makeStore(pi);
    const accepted = event({ sequence: 1, command: 'exact', displayId: 'U-1', title: 'Exact' });

    await expect(store.append(accepted)).resolves.toEqual({ ok: true, value: undefined });
    expect(pi.appendCalls).toEqual([
      { customType: 'pi-signal-board/event', data: accepted, parentId: null },
    ]);
    expect(pi.entriesReads).toBe(0);
  });

  it('constructs the narrow store from the Pi append port', async () => {
    const pi = new FakePiHarness();
    const store = createPiSessionStore(pi.api, {
      correlationIds: new CorrelationIds(),
      at: () => AT,
    });

    await store.append(
      event({ sequence: 1, command: 'factory', displayId: 'U-1', title: 'Factory' }),
    );
    expect(pi.appendCalls).toHaveLength(1);
  });

  it('normalizes a throw-before-record without retaining exception content', async () => {
    const pi = new FakePiHarness();
    const diagnostics: unknown[] = [];
    const store = makeStore(pi, diagnostics);
    pi.failNextAppend(new Error('PRIVATE append details\nSTACK_MARKER'));

    const result = await store.append(
      event({ sequence: 1, command: 'fail', displayId: 'U-1', title: 'Failure' }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'SB_PERSISTENCE_FAILED',
        message: 'Agent Board could not save the change. No success was recorded.',
        retryable: true,
        correlationId: 'sb-store-1',
      },
    });
    expect(pi.appendCalls).toHaveLength(0);
    expect(JSON.stringify({ result, diagnostics })).not.toMatch(
      /PRIVATE|STACK_MARKER|append details/u,
    );
    expect(diagnostics).toEqual([
      {
        at: AT,
        correlationId: 'sb-store-1',
        area: 'persistence',
        category: 'host_rejected',
      },
    ]);
  });

  it.each([
    ['invalid values', (): string => 'unsafe correlation value', (): string => 'not-a-time'],
    ['non-canonical time', (): string => 'sb-valid', (): string => '2026-08-08T20:00:00.001+00:00'],
  ] as const)('uses content-free fallbacks for %s', async (_case, nextCorrelationId, at) => {
    const pi = new FakePiHarness();
    pi.failNextAppend('PRIVATE thrown value');
    const store = new PiSessionStore(pi.api, {
      correlationIds: { nextCorrelationId },
      at,
    });

    const result = await store.append(
      event({ sequence: 1, command: 'invalid-boundary', displayId: 'U-1', title: 'Fallback' }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        correlationId:
          nextCorrelationId() === 'sb-valid'
            ? 'sb-valid'
            : 'sb-persistence-correlation-unavailable',
      },
    });
  });

  it('uses content-free fallbacks when boundary helpers fail', async () => {
    const pi = new FakePiHarness();
    pi.failNextAppend('PRIVATE thrown value');
    const store = new PiSessionStore(pi.api, {
      correlationIds: {
        nextCorrelationId() {
          throw new Error('PRIVATE correlation failure');
        },
      },
      at() {
        throw new Error('PRIVATE clock failure');
      },
      diagnostics: {
        recordUnexpectedError() {
          throw new Error('PRIVATE diagnostics failure');
        },
      },
    });

    const result = await store.append(
      event({ sequence: 1, command: 'fallback', displayId: 'U-1', title: 'Fallback' }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'SB_PERSISTENCE_FAILED',
        correlationId: 'sb-persistence-correlation-unavailable',
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('locked append-before-state transaction', () => {
  it('serializes parallel sibling mutations with no loss or reorder', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));

    const first = transact(harness, (state) =>
      event({
        sequence: 1,
        command: 'first',
        displayId: `U-${state.counters.nextUpdate}`,
        title: 'First',
        updateId: 'upd_10000000-0000-4000-8000-000000000001',
      }),
    );
    const second = transact(harness, (state) =>
      event({
        sequence: 2,
        command: 'second',
        displayId: `U-${state.counters.nextUpdate}`,
        title: 'Second',
        updateId: 'upd_10000000-0000-4000-8000-000000000002',
      }),
    );

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: true, value: { value: 'First', idempotent: false } },
      { ok: true, value: { value: 'Second', idempotent: false } },
    ]);
    expect(
      pi.appendCalls.map((call) => (call.data as UpdateUpsertedEvent).payload.displayId),
    ).toEqual(['U-1', 'U-2']);
    expect([...harness.state.updates.values()].map((item) => item.title)).toEqual([
      'First',
      'Second',
    ]);
    expect(harness.refreshLog).toEqual(['First', 'First,Second']);
  });

  it('reads same-key revision dependencies inside the queue', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));

    const create = transact(harness, () =>
      event({
        sequence: 1,
        command: 'create',
        displayId: 'U-1',
        title: 'Revision 1',
        key: 'build',
      }),
    );
    const revise = transact(harness, (state) => {
      const current = state.updates.get(UPDATE_ID);
      return event({
        sequence: 2,
        command: 'revise',
        displayId: 'U-1',
        revision: (current?.revision ?? 0) + 1,
        title: 'Revision 2',
        key: 'build',
        ...(current === undefined ? {} : { createdAt: current.createdAt }),
      });
    });

    await expect(Promise.all([create, revise])).resolves.toMatchObject([
      { ok: true },
      { ok: true },
    ]);
    expect(harness.state.updates.get(UPDATE_ID)).toMatchObject({
      key: 'build',
      revision: 2,
      title: 'Revision 2',
    });
    expect(pi.appendCalls).toHaveLength(2);
  });

  it('does not expose state or success until append succeeds', async () => {
    const pi = new FakePiHarness();
    const store = makeStore(pi);
    const harness = makeTransactionHarness(store);
    const original = harness.state;
    const afterRecord = createDeferred<void>('after-record');
    const release = createDeferred<void>('release');
    const baseAppend = harness.append;
    harness.append = async (accepted) => {
      const result = await baseAppend(accepted);
      afterRecord.resolve();
      await release.promise;
      return result;
    };

    let settled = false;
    const result = transact(harness, () =>
      event({ sequence: 1, command: 'barrier', displayId: 'U-1', title: 'Barrier' }),
    ).then((value) => {
      settled = true;
      return value;
    });

    await afterRecord.promise;
    expect(pi.appendCalls).toHaveLength(1);
    expect(harness.state).toBe(original);
    expect(harness.refreshLog).toEqual([]);
    expect(settled).toBe(false);

    release.resolve();
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(harness.state).not.toBe(original);
    expect(harness.refreshLog).toEqual(['Barrier']);
  });

  it('preserves exact prior identity, refresh log, counters, and success exposure on append failure', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    const original = harness.state;
    const counters = harness.state.counters;
    let successes = 0;
    pi.failNextAppend(new Error('synthetic'));

    const result = await transact(harness, () =>
      event({ sequence: 1, command: 'fail', displayId: 'U-1', title: 'Rejected' }),
    );
    if (result.ok) successes += 1;

    expect(result).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(harness.state).toBe(original);
    expect(harness.state.counters).toBe(counters);
    expect(harness.refreshLog).toEqual([]);
    expect(pi.appendCalls).toHaveLength(0);
    expect(successes).toBe(0);
  });

  it('keeps durable swapped state and queue recovery when refresh throws', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    let refreshAttempt = 0;
    harness.refresh = (state) => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) throw new Error('PRIVATE render detail');
      harness.refreshLog.push([...state.updates.values()].map((item) => item.title).join(','));
    };

    const first = await transact(harness, () =>
      event({ sequence: 1, command: 'first', displayId: 'U-1', title: 'Persisted' }),
    );
    expect(first).toMatchObject({ ok: false, error: { code: 'SB_INTERNAL' } });
    expect(pi.appendCalls).toHaveLength(1);
    expect(harness.state.updates.get(UPDATE_ID)?.title).toBe('Persisted');

    const second = await transact(harness, (state) =>
      event({
        sequence: 2,
        command: 'second',
        displayId: `U-${state.counters.nextUpdate}`,
        title: 'Later',
        updateId: 'upd_10000000-0000-4000-8000-000000000002',
      }),
    );
    expect(second).toMatchObject({ ok: true });
    expect(pi.appendCalls).toHaveLength(2);
    expect(harness.refreshLog).toEqual(['Persisted,Later']);
  });

  it('returns exact prior success without append for an identical command retry', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    const firstEvent = event({
      sequence: 1,
      command: 'duplicate',
      displayId: 'U-1',
      title: 'Same',
    });
    const first = await transact(harness, () => firstEvent);
    const stateAfterFirst = harness.state;
    const second = await transact(harness, () => ({
      ...firstEvent,
      eventId: event({
        sequence: 2,
        command: 'unused',
        displayId: 'U-1',
        title: 'Same',
      }).eventId,
    }));

    expect(first).toMatchObject({ ok: true, value: { idempotent: false } });
    expect(second).toEqual({
      ok: true,
      value: { event: firstEvent, value: 'Same', idempotent: true },
    });
    expect(pi.appendCalls).toHaveLength(1);
    expect(harness.state).toBe(stateAfterFirst);
    expect(harness.refreshLog).toEqual(['Same']);
  });

  it('rejects a conflicting duplicate command without append or refresh', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    await transact(harness, () =>
      event({ sequence: 1, command: 'duplicate', displayId: 'U-1', title: 'Original' }),
    );
    const stateAfterFirst = harness.state;

    const conflict = await transact(harness, () =>
      event({
        sequence: 2,
        command: 'duplicate',
        displayId: 'U-1',
        title: 'Different',
      }),
    );

    expect(conflict).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
    expect(pi.appendCalls).toHaveLength(1);
    expect(harness.state).toBe(stateAfterFirst);
    expect(harness.refreshLog).toEqual(['Original']);
  });

  it('does not append when preparation rejects', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    const result = await runLockedAppendTransaction<BoardState, BoardEvent, string>({
      queue: harness.queue,
      readState: () => harness.state,
      prepare: () => ({ ok: false, error: signalBoardError('SB_INVALID_ARGUMENT') }),
      reduce: (state) => ({ ok: true, state, idempotent: false }),
      append: (accepted) => harness.append(accepted),
      swapState: (state) => {
        harness.state = state;
      },
      refresh: () => undefined,
      resolveIdempotent: (_state, proposed) => succeed(proposed),
      mapRefreshThrow: internalError,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });
    expect(pi.appendCalls).toHaveLength(0);
  });

  it('fails safely when prior idempotent success cannot be resolved', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    const proposed = event({
      sequence: 1,
      command: 'missing-prior',
      displayId: 'U-1',
      title: 'Prior',
    });
    const result = await runLockedAppendTransaction<BoardState, BoardEvent, string>({
      queue: harness.queue,
      readState: () => harness.state,
      prepare: () => succeed({ event: proposed, value: 'Prior' }),
      reduce: (state) => ({ ok: true, state, idempotent: true }),
      append: (accepted) => harness.append(accepted),
      swapState: (state) => {
        harness.state = state;
      },
      refresh: () => undefined,
      resolveIdempotent: () => ({ ok: false, error: signalBoardError('SB_STATE_CONFLICT') }),
      mapRefreshThrow: internalError,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
    expect(pi.appendCalls).toHaveLength(0);
  });

  it('maps a raw append rejection and keeps the queue usable', async () => {
    const queue = new MutationQueue();
    let state = createEmptyBoardState();
    const proposed = event({ sequence: 1, command: 'raw-throw', displayId: 'U-1', title: 'Raw' });
    const result = await runLockedAppendTransaction<BoardState, BoardEvent, string>({
      queue,
      readState: () => state,
      prepare: () => succeed({ event: proposed, value: 'Raw' }),
      reduce: (current, accepted) => reduceBoardEvent(current, accepted),
      append: async () => {
        throw new Error('PRIVATE raw append failure');
      },
      swapState: (next) => {
        state = next;
      },
      refresh: () => undefined,
      resolveIdempotent: () => succeed({ event: proposed, value: 'Raw' }),
      mapAppendThrow: () => signalBoardError('SB_PERSISTENCE_FAILED'),
      mapRefreshThrow: internalError,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(state.updates.size).toBe(0);
    await expect(queue.run(() => 'usable')).resolves.toBe('usable');
  });

  it('keeps refreshes in accepted queue order', async () => {
    const pi = new FakePiHarness();
    const harness = makeTransactionHarness(makeStore(pi));
    const refreshBarrier = createDeferred<void>('refresh');
    harness.refresh = async (state) => {
      const titles = [...state.updates.values()].map((item) => item.title).join(',');
      harness.refreshLog.push(`start:${titles}`);
      if (state.updates.size === 1) await refreshBarrier.promise;
      harness.refreshLog.push(`end:${titles}`);
    };

    const first = transact(harness, () =>
      event({ sequence: 1, command: 'first', displayId: 'U-1', title: 'First' }),
    );
    const second = transact(harness, (state) =>
      event({
        sequence: 2,
        command: 'second',
        displayId: `U-${state.counters.nextUpdate}`,
        title: 'Second',
        updateId: 'upd_10000000-0000-4000-8000-000000000002',
      }),
    );

    await flushMicrotasks();
    expect(harness.refreshLog).toEqual(['start:First']);
    expect(pi.appendCalls).toHaveLength(1);
    refreshBarrier.resolve();
    await Promise.all([first, second]);
    expect(harness.refreshLog).toEqual([
      'start:First',
      'end:First',
      'start:First,Second',
      'end:First,Second',
    ]);
  });
});

describe('store source boundary', () => {
  it('contains no session scan, session-file write, shell, or network path', () => {
    const source = readFileSync(
      new URL('../../src/persistence/pi-session-store.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(
      /getEntries|session\.jsonl|writeFile|appendFile|child_process|fetch\s*\(/u,
    );
    expect(source.match(/\.appendEntry\(/gu)).toHaveLength(1);
  });
});
