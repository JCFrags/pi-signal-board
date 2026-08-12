import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENT_CUSTOM_TYPE } from '../../src/constants.js';
import type { BoardEvent } from '../../src/domain/events.js';
import { type ReplayEntry, replayBranch } from '../../src/persistence/replay.js';

const time = '2026-08-12T09:00:00.000Z';

function update(sequence: number, title = `Update ${sequence}`): BoardEvent {
  const suffix = String(sequence).padStart(12, '0');
  return {
    schemaVersion: 1,
    eventId: `evt_aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    eventType: 'update.upserted',
    occurredAt: time,
    actor: 'agent',
    commandId: `tool:update-${sequence}`,
    payload: {
      updateId: `upd_11111111-1111-4111-8111-${suffix}`,
      displayId: `U-${sequence}`,
      revision: 1,
      createdAt: time,
      updatedAt: time,
      fields: { kind: 'working', title, attachments: [] },
    },
  } as BoardEvent;
}

function reset(sequence: number): BoardEvent {
  const suffix = String(sequence).padStart(12, '0');
  return {
    schemaVersion: 1,
    eventId: `evt_bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
    eventType: 'board.reset',
    occurredAt: time,
    actor: 'user',
    commandId: `ui:reset-${sequence}`,
    payload: { resetAt: time, reason: 'Reset board.' },
  };
}

function entry(data: unknown, index: number, id: unknown = `entry-${index}`): ReplayEntry {
  return { id, type: 'custom', customType: EVENT_CUSTOM_TYPE, data };
}

describe('branch replay', () => {
  it('FR-010 consumes only the supplied root-to-leaf branch and ignores unrelated or compaction entries', () => {
    const branch = [
      { id: 'message', type: 'message', data: update(9) },
      { id: 'compact', type: 'compaction', data: update(9) },
      { id: 'other', type: 'custom', customType: 'other/entry', data: update(9) },
      entry(update(1), 1),
      entry(update(2), 2),
    ];
    const outcome = replayBranch(branch);
    expect(outcome.state.updates.size).toBe(2);
    expect(outcome).toMatchObject({ acceptedEvents: 2, skippedEvents: 0, warnings: [] });
  });

  it('NFR-010 skips malformed and invariant-breaking events and applies a later valid event', () => {
    const malformed = structuredClone(update(2)) as unknown as Record<string, unknown>;
    malformed.schemaVersion = 2;
    const outcome = replayBranch([
      entry({ nope: true }, 0, '<secret content>'),
      entry(malformed, 1),
      entry(update(1), 2),
      entry(update(3), 3),
    ]);
    expect(outcome.state.updates.size).toBe(1);
    expect(outcome.acceptedEvents).toBe(1);
    expect(outcome.skippedEvents).toBe(3);
    expect(outcome.warnings).toEqual([
      { entryIndex: 0, code: 'SB_REPLAY_DECODE_INVALID' },
      { entryIndex: 1, entryId: 'entry-1', code: 'SB_REPLAY_UNSUPPORTED_VERSION' },
      { entryIndex: 3, entryId: 'entry-3', code: 'SB_REPLAY_REDUCER_REJECTED' },
    ]);
    expect(JSON.stringify(outcome.warnings)).not.toContain('secret');
    expect(outcome.state.replay).toEqual({
      acceptedEvents: 1,
      skippedEvents: 3,
      warnings: outcome.warnings,
    });
  });

  it('FR-180 applies valid reset, skips malformed reset, and preserves whole-branch evidence', () => {
    const badReset = structuredClone(reset(2)) as unknown as Record<string, unknown>;
    (badReset.payload as Record<string, unknown>).resetAt = 'bad';
    const outcome = replayBranch([
      entry(update(1), 0),
      entry(badReset, 1),
      entry(reset(3), 2),
      entry(update(1), 3),
      entry(reset(4), 4),
      entry(update(1), 5),
    ]);
    expect(outcome.state.updates.size).toBe(1);
    expect(outcome.state.resetEventId).toBe(reset(4).eventId);
    expect(outcome).toMatchObject({ acceptedEvents: 5, skippedEvents: 1 });
    expect(outcome.state.replay.acceptedEvents).toBe(5);
    expect(outcome.state.replay.skippedEvents).toBe(1);
  });

  it('counts exact duplicates consistently without changing projection', () => {
    const one = update(1);
    const single = replayBranch([entry(one, 0)]);
    const duplicate = replayBranch([entry(one, 0), entry(structuredClone(one), 1)]);
    expect(duplicate.acceptedEvents).toBe(2);
    expect([...duplicate.state.updates]).toEqual([...single.state.updates]);
  });

  it('fully isolates alternate branch calls and returns immutable results', () => {
    const first = replayBranch([entry(update(1), 0)]);
    const second = replayBranch([entry(update(1, 'Alternate'), 0)]);
    expect(first.state.updates.values().next().value?.title).toBe('Update 1');
    expect(second.state.updates.values().next().value?.title).toBe('Alternate');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.state)).toBe(true);
    expect(Object.isFrozen(first.warnings)).toBe(true);
    expect(() => (first.state.updates as Map<unknown, unknown>).clear()).toThrow();
  });

  it('is deterministic and has no getEntries source use', () => {
    const branch = [entry(update(1), 0), entry(update(2), 1)];
    const left = replayBranch(branch);
    const right = replayBranch(structuredClone(branch));
    expect([...left.state.updates]).toEqual([...right.state.updates]);
    const source = readFileSync(
      new URL('../../src/persistence/replay.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('get' + 'Entries');
    expect(source).not.toContain('sessionManager');
  });

  it('bounds warning retention while retaining complete skipped metrics', () => {
    const branch = Array.from({ length: 150 }, (_, index) => entry({}, index));
    const outcome = replayBranch(branch);
    expect(outcome.skippedEvents).toBe(150);
    expect(outcome.warnings).toHaveLength(100);
  });
});
