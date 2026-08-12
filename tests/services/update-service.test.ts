import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { EffectiveConfig } from '../../src/config/types.js';
import { FixedClock } from '../../src/domain/clock.js';
import { fail, signalBoardError, succeed } from '../../src/domain/errors.js';
import type { UpdateArchivedEvent, UpdateUpsertedEvent } from '../../src/domain/events.js';
import type { EventId, IdGenerator, UpdateId } from '../../src/domain/ids.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import type { BoardState } from '../../src/domain/types.js';
import { MutationQueue } from '../../src/services/mutation-queue.js';
import { TurnUpdateRateCounter } from '../../src/services/update-rate-counter.js';
import {
  type ArchiveUpdateCommand,
  UpdateService,
  type UpsertUpdateCommand,
} from '../../src/services/update-service.js';
import { createDeferred } from '../helpers/deferred.js';

class ServiceIds implements Pick<IdGenerator, 'event' | 'update'> {
  eventCalls = 0;
  updateCalls = 0;

  event(): EventId {
    this.eventCalls += 1;
    return `evt_00000000-0000-4000-8000-${this.eventCalls.toString(16).padStart(12, '0')}`;
  }

  update(): UpdateId {
    this.updateCalls += 1;
    return `upd_00000000-0000-4000-8000-${this.updateCalls.toString(16).padStart(12, '0')}`;
  }
}

type UpdateEvent = UpdateUpsertedEvent | UpdateArchivedEvent;

function config(maxActiveUpdates = 50, maxUpdateMutationsPerTurn = 12): EffectiveConfig {
  return {
    ...DEFAULT_CONFIG,
    limits: { ...DEFAULT_CONFIG.limits, maxActiveUpdates, maxUpdateMutationsPerTurn },
  };
}

function harness(options: { activeLimit?: number; rateLimit?: number } = {}) {
  let state = createEmptyBoardState();
  const events: UpdateEvent[] = [];
  const clock = new FixedClock('2026-08-12T10:00:00.000Z');
  const ids = new ServiceIds();
  const rateCounter = new TurnUpdateRateCounter();
  let appendBehavior: 'ok' | 'throw' | 'failure' = 'ok';
  let refreshBehavior: 'ok' | 'throw' = 'ok';
  const service = new UpdateService({
    queue: new MutationQueue(),
    readState: () => state,
    swapState: (next) => {
      state = next;
    },
    append: async (event) => {
      if (appendBehavior === 'throw') throw new Error('private append detail');
      if (appendBehavior === 'failure') return fail(signalBoardError('SB_PERSISTENCE_FAILED'));
      events.push(event);
      return succeed(undefined);
    },
    refresh: () => {
      if (refreshBehavior === 'throw') throw new Error('private refresh detail');
    },
    clock,
    ids,
    cwd: '/work/project',
    config: config(options.activeLimit, options.rateLimit),
    rateCounter,
  });
  return {
    service,
    events,
    ids,
    rateCounter,
    state: () => state,
    setAppend: (behavior: typeof appendBehavior) => {
      appendBehavior = behavior;
    },
    setRefresh: (behavior: typeof refreshBehavior) => {
      refreshBehavior = behavior;
    },
  };
}

type UpsertOverrides = {
  readonly [Key in keyof UpsertUpdateCommand]?: UpsertUpdateCommand[Key] | undefined;
};

function upsert(commandId: string, values: UpsertOverrides = {}): UpsertUpdateCommand {
  return {
    commandId: `tool:${commandId}`,
    key: 'work',
    kind: 'working',
    title: 'Work item',
    ...values,
  } as UpsertUpdateCommand;
}

function resultValue<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected synthetic service success.');
  return result.value;
}

function errorCode(result: Awaited<ReturnType<UpdateService['upsertUpdate']>>): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected synthetic service failure.');
  return result.error.code;
}

describe('UpdateService', () => {
  it('creates and revises one same-key update with exact deterministic complete events', async () => {
    const test = harness();
    const first = resultValue(await test.service.upsertUpdate(upsert('one')));
    const second = resultValue(
      await test.service.upsertUpdate(upsert('two', { kind: 'finding', title: 'Finding' })),
    );
    const third = resultValue(
      await test.service.upsertUpdate(upsert('three', { kind: 'completed', title: 'Done' })),
    );

    expect([first.item.revision, second.item.revision, third.item.revision]).toEqual([1, 2, 3]);
    expect(test.state().updates.size).toBe(1);
    expect(third.item).toMatchObject({ displayId: 'U-1', kind: 'completed', stage: 'complete' });
    expect(third.item.completedAt).toBe('2026-08-12T10:00:00.000Z');
    expect(test.events).toEqual([
      {
        schemaVersion: 1,
        eventId: 'evt_00000000-0000-4000-8000-000000000001',
        eventType: 'update.upserted',
        occurredAt: '2026-08-12T10:00:00.000Z',
        actor: 'agent',
        commandId: 'tool:one',
        payload: {
          updateId: 'upd_00000000-0000-4000-8000-000000000001',
          displayId: 'U-1',
          revision: 1,
          createdAt: '2026-08-12T10:00:00.000Z',
          updatedAt: '2026-08-12T10:00:00.000Z',
          fields: {
            key: 'work',
            kind: 'working',
            title: 'Work item',
            attachments: [],
          },
        },
      },
      expect.objectContaining({
        eventType: 'update.upserted',
        commandId: 'tool:two',
        payload: expect.objectContaining({ revision: 2 }),
      }),
      expect.objectContaining({
        eventType: 'update.upserted',
        commandId: 'tool:three',
        payload: expect.objectContaining({
          revision: 3,
          completedAt: '2026-08-12T10:00:00.000Z',
          fields: expect.objectContaining({ kind: 'completed', stage: 'complete' }),
        }),
      }),
    ]);
  });

  it('serializes parallel sibling same-key calls without a lost revision', async () => {
    const test = harness();
    const first = test.service.upsertUpdate(upsert('parallel-one', { title: 'One' }));
    const second = test.service.upsertUpdate(upsert('parallel-two', { title: 'Two' }));
    const results = await Promise.all([first, second]);

    expect(results.map((result) => resultValue(result).item.revision)).toEqual([1, 2]);
    expect(test.state().updates.values().next().value).toMatchObject({ revision: 2, title: 'Two' });
  });

  it('resolves internal ID, display ID, key, and detects conflicting ID/key targets', async () => {
    const test = harness();
    const one = resultValue(await test.service.upsertUpdate(upsert('create-one', { key: 'one' })));
    const two = resultValue(await test.service.upsertUpdate(upsert('create-two', { key: 'two' })));

    expect(
      resultValue(
        await test.service.upsertUpdate(
          upsert('by-display', { id: one.item.displayId, key: undefined, title: 'Display' }),
        ),
      ).item.id,
    ).toBe(one.item.id);
    expect(
      resultValue(
        await test.service.upsertUpdate(
          upsert('by-internal', { id: one.item.id, key: undefined, title: 'Internal' }),
        ),
      ).item.id,
    ).toBe(one.item.id);
    expect(
      errorCode(
        await test.service.upsertUpdate(
          upsert('conflict', { id: one.item.id, key: 'two', title: 'Conflict' }),
        ),
      ),
    ).toBe('SB_STATE_CONFLICT');
    expect(two.item.revision).toBe(1);
  });

  it('merges omitted fields, clears nullable fields, and replaces attachments', async () => {
    const test = harness();
    const created = resultValue(
      await test.service.upsertUpdate(
        upsert('merge-create', {
          detail: 'Detail',
          stage: 'testing',
          progress: { current: 1, total: 2, unit: ' files ' },
          attachments: [{ kind: 'file', label: ' Source ', path: '@src/main.ts' }],
        }),
      ),
    );
    const preserved = resultValue(
      await test.service.upsertUpdate({
        commandId: 'tool:merge-preserve',
        id: created.item.id,
        title: 'Changed',
      }),
    );
    expect(preserved.item).toMatchObject({
      detail: 'Detail',
      stage: 'testing',
      progress: { current: 1, total: 2, unit: 'files' },
      attachments: [{ kind: 'file', label: 'Source', path: 'src/main.ts' }],
    });

    const cleared = resultValue(
      await test.service.upsertUpdate({
        commandId: 'tool:merge-clear',
        id: created.item.id,
        detail: null,
        stage: null,
        progress: null,
        attachments: [],
      }),
    );
    expect(cleared.item).not.toHaveProperty('detail');
    expect(cleared.item).not.toHaveProperty('stage');
    expect(cleared.item).not.toHaveProperty('progress');
    expect(cleared.item.attachments).toEqual([]);
  });

  it('accepts every kind and stage and clears completedAt on a later nonterminal change', async () => {
    const test = harness();
    for (const [index, kind] of [
      'working',
      'finding',
      'warning',
      'blocked',
      'completed',
      'failed',
    ].entries()) {
      const result = resultValue(
        await test.service.upsertUpdate(
          upsert(`kind-${index}`, { kind: kind as UpsertUpdateCommand['kind'], title: kind }),
        ),
      );
      expect(result.item.kind).toBe(kind);
    }
    for (const [index, stage] of [
      'discovering',
      'implementing',
      'testing',
      'validating',
      'complete',
    ].entries()) {
      const result = resultValue(
        await test.service.upsertUpdate(
          upsert(`stage-${index}`, {
            kind: 'working',
            stage: stage as UpsertUpdateCommand['stage'],
          }),
        ),
      );
      expect(result.item.stage).toBe(stage);
      expect(result.item).not.toHaveProperty('completedAt');
    }
  });

  it('rejects non-finite and out-of-range progress with safe field errors', async () => {
    const cases = [
      [{ current: Number.NaN, total: 1 }, 'progress.current'],
      [{ current: 0, total: Number.POSITIVE_INFINITY }, 'progress.total'],
      [{ current: 0, total: 0 }, 'progress.total'],
      [{ current: -1, total: 1 }, 'progress.current'],
      [{ current: 2, total: 1 }, 'progress.current'],
    ] as const;
    for (const [progress, path] of cases) {
      const test = harness();
      const result = await test.service.upsertUpdate(upsert('invalid-progress', { progress }));
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'SB_INVALID_ARGUMENT', fieldErrors: [{ path }] },
      });
      expect(test.events).toHaveLength(0);
      expect(test.ids.eventCalls).toBe(0);
    }
  });

  it('sanitizes fields and attachments before semantic comparison', async () => {
    const test = harness();
    const created = resultValue(
      await test.service.upsertUpdate(
        upsert('sanitize-create', {
          title: '\u001b[31m  Safe   title \u001b[0m',
          detail: 'one\r\ntwo\u0000',
          progress: { current: 1, total: 2, unit: '\u001b[1mfiles\u001b[0m' },
          attachments: [{ kind: 'note', label: '\u001b[31m note', text: 'a\r\nb' }],
        }),
      ),
    );
    expect(created.item).toMatchObject({
      title: 'Safe title',
      detail: 'one\ntwo',
      progress: { unit: 'files' },
      attachments: [{ kind: 'note', label: 'note', text: 'a\nb' }],
    });
    const noOp = resultValue(
      await test.service.upsertUpdate(
        upsert('sanitize-alias', {
          title: ' Safe title ',
          detail: 'one\ntwo',
          progress: { current: 1, total: 2, unit: 'files' },
          attachments: [{ kind: 'note', label: 'note', text: 'a\nb' }],
        }),
      ),
    );
    expect(noOp.noOp).toBe(true);
    expect(noOp).not.toHaveProperty('event');
    expect(test.events).toHaveLength(1);
    expect(test.rateCounter.committed).toBe(1);
  });

  it('returns prior success for an exact duplicate command and rejects a conflicting duplicate', async () => {
    const test = harness();
    const first = resultValue(await test.service.upsertUpdate(upsert('duplicate')));
    const duplicate = resultValue(
      await test.service.upsertUpdate(
        upsert('duplicate', { id: first.item.displayId, key: undefined, title: ' Work item ' }),
      ),
    );
    expect(duplicate.noOp).toBe(true);
    expect(duplicate.event).toEqual(first.event);
    expect(duplicate.item).toEqual(first.item);
    expect(test.events).toHaveLength(1);
    expect(test.rateCounter.committed).toBe(1);

    expect(
      errorCode(await test.service.upsertUpdate(upsert('duplicate', { title: 'Changed' }))),
    ).toBe('SB_STATE_CONFLICT');
  });

  it('archives with revision checks and makes an archived exact ID idempotent', async () => {
    const test = harness();
    const created = resultValue(await test.service.upsertUpdate(upsert('archive-create')));
    const stale = await test.service.archiveUpdate({
      commandId: 'tool:archive-stale',
      id: created.item.id,
      expectedRevision: 2,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'SB_REVISION_MISMATCH' } });

    const archived = resultValue(
      await test.service.archiveUpdate({
        commandId: 'tool:archive',
        id: created.item.displayId,
        expectedRevision: 1,
      }),
    );
    expect(archived.item).toMatchObject({ archived: true, revision: 2 });
    const again = resultValue(
      await test.service.archiveUpdate({ commandId: 'tool:archive-again', id: created.item.id }),
    );
    expect(again.noOp).toBe(true);
    expect(again).not.toHaveProperty('event');
    expect(test.events).toHaveLength(2);
    expect(
      errorCode(
        await test.service.upsertUpdate(upsert('archived-upsert', { id: created.item.id })),
      ),
    ).toBe('SB_STATE_CONFLICT');
  });

  it('enforces the active limit only for accepted new creation', async () => {
    const test = harness({ activeLimit: 1 });
    const created = resultValue(await test.service.upsertUpdate(upsert('limit-create')));
    const noOp = resultValue(await test.service.upsertUpdate(upsert('limit-no-op')));
    expect(noOp.noOp).toBe(true);
    const revised = resultValue(
      await test.service.upsertUpdate(
        upsert('limit-revise', { id: created.item.id, title: 'Revised' }),
      ),
    );
    expect(revised.item.revision).toBe(2);
    expect(
      errorCode(await test.service.upsertUpdate(upsert('limit-new', { key: 'different' }))),
    ).toBe('SB_LIMIT_EXCEEDED');
  });

  it('commits exactly the configured turn rate and resets exactly on demand', async () => {
    const test = harness({ rateLimit: 2 });
    await test.service.upsertUpdate(upsert('rate-one', { title: 'One' }));
    await test.service.upsertUpdate(upsert('rate-no-op', { title: 'One' }));
    await test.service.upsertUpdate(upsert('rate-two', { title: 'Two' }));
    expect(
      errorCode(await test.service.upsertUpdate(upsert('rate-three', { title: 'Three' }))),
    ).toBe('SB_LIMIT_EXCEEDED');
    expect(test.rateCounter.committed).toBe(2);

    test.rateCounter.reset();
    expect(
      resultValue(await test.service.upsertUpdate(upsert('rate-after-reset', { title: 'Three' })))
        .item.revision,
    ).toBe(3);
    expect(test.rateCounter.committed).toBe(1);
  });

  it('does not consume IDs, display sequence, rate, or state on invalid and append failure', async () => {
    const test = harness();
    await test.service.upsertUpdate(upsert('invalid', { title: '   ' }));
    expect(test.ids).toMatchObject({ eventCalls: 0, updateCalls: 0 });

    test.setAppend('throw');
    const failed = await test.service.upsertUpdate(upsert('append-fail'));
    expect(failed).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(test.state().updates.size).toBe(0);
    expect(test.state().counters.nextUpdate).toBe(1);
    expect(test.rateCounter.committed).toBe(0);

    test.setAppend('ok');
    const accepted = resultValue(await test.service.upsertUpdate(upsert('after-fail')));
    expect(accepted.item).toMatchObject({
      id: 'upd_00000000-0000-4000-8000-000000000001',
      displayId: 'U-1',
    });
    expect(accepted.event?.eventId).toBe('evt_00000000-0000-4000-8000-000000000001');
    expect(test.ids).toMatchObject({ eventCalls: 1, updateCalls: 1 });
  });

  it('keeps append durability and committed rate when refresh fails', async () => {
    const test = harness();
    test.setRefresh('throw');
    const failed = await test.service.upsertUpdate(upsert('refresh-fail'));
    expect(failed).toMatchObject({ ok: false, error: { code: 'SB_UI_UNAVAILABLE' } });
    expect(test.events).toHaveLength(1);
    expect(test.state().updates.size).toBe(1);
    expect(test.rateCounter.committed).toBe(1);

    test.setRefresh('ok');
    const retry = resultValue(await test.service.upsertUpdate(upsert('refresh-fail')));
    expect(retry).toMatchObject({ noOp: true });
    expect(test.events).toHaveLength(1);
  });

  it('returns deeply immutable result copies', async () => {
    const test = harness();
    const result = resultValue(
      await test.service.upsertUpdate(
        upsert('immutable', {
          progress: { current: 1, total: 2 },
          attachments: [{ kind: 'note', label: 'note', text: 'text' }],
        }),
      ),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.item)).toBe(true);
    expect(Object.isFrozen(result.item.attachments)).toBe(true);
    expect(Object.isFrozen(result.event?.payload)).toBe(true);
    expect(() => {
      (result.item.attachments as unknown as { kind: string }[])[0] = { kind: 'command' };
    }).toThrow(TypeError);
  });

  it('holds one shared queue across a delayed append and later sibling lookup', async () => {
    let state: BoardState = createEmptyBoardState();
    const barrier = createDeferred<void>('append');
    const ids = new ServiceIds();
    const events: UpdateEvent[] = [];
    let first = true;
    const service = new UpdateService({
      queue: new MutationQueue(),
      readState: () => state,
      swapState: (next) => {
        state = next;
      },
      append: async (event) => {
        if (first) {
          first = false;
          await barrier.promise;
        }
        events.push(event);
        return succeed(undefined);
      },
      refresh: () => undefined,
      clock: new FixedClock('2026-08-12T10:00:00.000Z'),
      ids,
      cwd: '/work/project',
      config: config(),
      rateCounter: new TurnUpdateRateCounter(),
    });
    const one = service.upsertUpdate(upsert('queued-one', { title: 'One' }));
    const two = service.upsertUpdate(upsert('queued-two', { title: 'Two' }));
    await Promise.resolve();
    expect(events).toHaveLength(0);
    barrier.resolve();
    const values = (await Promise.all([one, two])).map(resultValue);
    expect(values.map((value) => value.item.revision)).toEqual([1, 2]);
    expect(events).toHaveLength(2);
  });

  it('returns exact prior archive success and rejects cross-operation command reuse', async () => {
    const test = harness();
    const created = resultValue(await test.service.upsertUpdate(upsert('cross-create')));
    const archived = resultValue(
      await test.service.archiveUpdate({
        commandId: 'tool:archive-duplicate',
        key: 'work',
        expectedRevision: 1,
      }),
    );
    const duplicate = resultValue(
      await test.service.archiveUpdate({
        commandId: 'tool:archive-duplicate',
        id: created.item.displayId,
        expectedRevision: 1,
      }),
    );
    expect(duplicate).toEqual({ ...archived, noOp: true });
    expect(test.events).toHaveLength(2);
    expect(
      errorCode(
        await test.service.upsertUpdate(upsert('archive-duplicate', { id: created.item.id })),
      ),
    ).toBe('SB_STATE_CONFLICT');
    const crossArchive = await test.service.archiveUpdate({
      commandId: 'tool:cross-create',
      id: created.item.id,
    });
    expect(crossArchive).toMatchObject({ ok: false, error: { code: 'SB_STATE_CONFLICT' } });
  });

  it('validates semantic fields before allocation and returns safe field paths', async () => {
    const cases: readonly UpsertUpdateCommand[] = [
      { commandId: 'bad-command' as `tool:${string}`, kind: 'working', title: 'Title' },
      { commandId: 'tool:missing-kind', title: 'Title' },
      { commandId: 'tool:missing-title', kind: 'working' },
      upsert('bad-key', { key: 'not valid' }),
      upsert('bad-detail', { detail: '   ' }),
      upsert('bad-stage', { stage: 'unknown' as 'testing' }),
      upsert('bad-complete-stage', { kind: 'completed', stage: 'testing' }),
      upsert('bad-progress-shape', {
        progress: [] as unknown as { current: number; total: number },
      }),
      upsert('bad-progress-unit', { progress: { current: 1, total: 2, unit: '   ' } }),
      upsert('bad-attachment', {
        attachments: [{ kind: 'url', label: 'bad', url: 'file:///private' }],
      }),
    ];
    for (const command of cases) {
      const test = harness();
      const result = await test.service.upsertUpdate(command);
      expect(result).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });
      expect(JSON.stringify(result)).not.toMatch(/private|stack/iu);
      expect(test.ids).toMatchObject({ eventCalls: 0, updateCalls: 0 });
    }
  });

  it('validates archive arguments and does not charge failed persistence results', async () => {
    const test = harness();
    const invalidRevision = await test.service.archiveUpdate({
      commandId: 'tool:archive-invalid-revision',
      id: 'U-1',
      expectedRevision: 0,
    });
    expect(invalidRevision).toMatchObject({
      ok: false,
      error: { code: 'SB_INVALID_ARGUMENT', fieldErrors: [{ path: 'expectedRevision' }] },
    });
    const invalidCommand = await test.service.archiveUpdate({
      commandId: 'ui:not-agent' as `tool:${string}`,
      id: 'U-1',
    });
    expect(invalidCommand).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });

    test.setAppend('failure');
    const failed = await test.service.upsertUpdate(upsert('append-result-failure'));
    expect(failed).toMatchObject({ ok: false, error: { code: 'SB_PERSISTENCE_FAILED' } });
    expect(test.rateCounter.committed).toBe(0);
    expect(test.state().updates.size).toBe(0);
  });

  it('enforces the normative twelve accepted update mutations per turn', async () => {
    const test = harness();
    for (let revision = 1; revision <= 12; revision += 1) {
      const accepted = resultValue(
        await test.service.upsertUpdate(
          upsert(`twelve-${revision}`, { title: `Revision ${revision}` }),
        ),
      );
      expect(accepted.item.revision).toBe(revision);
    }
    expect(
      errorCode(await test.service.upsertUpdate(upsert('thirteen', { title: 'Revision 13' }))),
    ).toBe('SB_LIMIT_EXCEEDED');
    expect(test.events).toHaveLength(12);
    expect(test.rateCounter.committed).toBe(12);
  });

  it('returns stable errors for malformed and missing lookups without allocation', async () => {
    const test = harness();
    expect(
      errorCode(await test.service.upsertUpdate(upsert('bad-id', { id: 'U-0', key: undefined }))),
    ).toBe('SB_INVALID_ARGUMENT');
    const missing = await test.service.archiveUpdate({ commandId: 'tool:missing', id: 'U-99' });
    expect(missing).toMatchObject({ ok: false, error: { code: 'SB_NOT_FOUND' } });
    const noLookup = await test.service.archiveUpdate({
      commandId: 'tool:no-lookup',
    } as ArchiveUpdateCommand);
    expect(noLookup).toMatchObject({ ok: false, error: { code: 'SB_INVALID_ARGUMENT' } });
    expect(test.ids).toMatchObject({ eventCalls: 0, updateCalls: 0 });
  });
});
