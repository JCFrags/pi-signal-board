import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { EVENT_CUSTOM_TYPE } from '../../src/constants.js';
import type { BoardEvent } from '../../src/domain/events.js';
import { type ReplayEntry, replayBranch } from '../../src/persistence/replay.js';

const time = '2026-08-12T09:00:00.000Z';
const DISTINCT_ACTIVE_UPDATES = 100;

function updateEvent(sequence: number): BoardEvent {
  const suffix = String(sequence).padStart(12, '0');
  return {
    schemaVersion: 1,
    eventId: `evt_aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
    eventType: 'update.upserted',
    occurredAt: time,
    actor: 'agent',
    commandId: `tool:performance-update-${sequence}`,
    payload: {
      updateId: `upd_11111111-1111-4111-8111-${suffix}`,
      displayId: `U-${sequence}`,
      revision: 1,
      createdAt: time,
      updatedAt: time,
      fields: { kind: 'working', title: `Replay fixture ${sequence}`, attachments: [] },
    },
  };
}

function replayFixture(size: number): readonly ReplayEntry[] {
  const eventPool = Array.from({ length: DISTINCT_ACTIVE_UPDATES }, (_, index) =>
    updateEvent(index + 1),
  );
  return Array.from({ length: size }, (_, index) => ({
    id: `entry-${index}`,
    type: 'custom',
    customType: EVENT_CUSTOM_TYPE,
    data: eventPool[index % eventPool.length],
  }));
}

function percentile(samples: readonly number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('replay performance', () => {
  it('NFR-001 replays 2,000 deterministic events within the normative limit plus documented CI variance', () => {
    const fixture = replayFixture(2_000);
    replayBranch(fixture);
    const samples = Array.from({ length: 30 }, () => {
      const start = performance.now();
      const outcome = replayBranch(fixture);
      const elapsed = performance.now() - start;
      expect(outcome.acceptedEvents).toBe(2_000);
      expect(outcome.state.updates.size).toBe(DISTINCT_ACTIVE_UPDATES);
      return elapsed;
    });
    const median = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.info(`replay-2000 median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    // V8 coverage instrumentation changes this timing by design. Shared CI hosts can pause a
    // process between samples and Windows runners are slower, so CI allows 2x variance on the
    // median. A local normal test continues to enforce the normative 120 ms p95 limit.
    if (process.env.npm_lifecycle_event !== 'test:coverage') {
      expect(process.env.CI === 'true' ? median : p95).toBeLessThanOrEqual(
        process.env.CI === 'true' ? 240 : 120,
      );
    }
  });

  it('NFR-020 provides a deterministic scalable 10,000-event fixture', () => {
    const fixture = replayFixture(10_000);
    expect(fixture).toHaveLength(10_000);
    const outcome = replayBranch(fixture);
    expect(outcome).toMatchObject({ acceptedEvents: 10_000, skippedEvents: 0 });
    expect(outcome.state.updates.size).toBe(DISTINCT_ACTIVE_UPDATES);
  });
});
