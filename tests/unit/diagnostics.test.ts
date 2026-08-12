import { describe, expect, it } from 'vitest';

import { convertUnexpectedError } from '../../src/domain/errors.js';
import {
  createDiagnostics,
  DIAGNOSTIC_CAPACITY,
  type DiagnosticRecord,
} from '../../src/services/diagnostics.js';

const START = Date.parse('2026-08-12T08:00:00.000Z');

function timestamp(index: number): string {
  return new Date(START + index * 1_000).toISOString();
}

function record(index: number): DiagnosticRecord {
  return {
    at: timestamp(index),
    code: 'SB_REPLAY_SKIPPED',
    severity: 'warning',
    area: 'replay',
    category: 'decode_rejected',
  };
}

describe('bounded redacted diagnostics', () => {
  it('uses an exact 100-record capacity', () => {
    expect(DIAGNOSTIC_CAPACITY).toBe(100);
  });

  it('retains the newest 100 records in chronological insertion order', () => {
    const diagnostics = createDiagnostics();
    for (let index = 0; index < 101; index += 1) {
      diagnostics.record(record(index));
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot.records).toHaveLength(100);
    expect(snapshot.records[0]?.at).toBe(timestamp(1));
    expect(snapshot.records.at(-1)?.at).toBe(timestamp(100));
    expect(snapshot.retained).toBe(100);
    expect(snapshot.totalRecorded).toBe(101);
    expect(snapshot.counts.SB_REPLAY_SKIPPED).toBe(101);
    expect(diagnostics.count()).toBe(101);
    expect(diagnostics.count('SB_REPLAY_SKIPPED')).toBe(101);
  });

  it('copies, freezes, and strips fields that could contain sensitive content', () => {
    const diagnostics = createDiagnostics();
    const unsafe = {
      ...record(0),
      message: 'SECRET question text',
      stack: 'STACK_MARKER',
      path: '/home/alice/private/project.ts',
      boardContent: 'PRIVATE_ANSWER',
    } as DiagnosticRecord;

    diagnostics.record(unsafe);
    const snapshot = diagnostics.snapshot();
    const serialized = JSON.stringify(snapshot);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(serialized).not.toMatch(/SECRET|STACK_MARKER|PRIVATE_ANSWER|\/home\/alice/u);
    expect(snapshot.records[0]).toEqual(record(0));
  });

  it('keeps replay and delivery aggregates needed by doctor', () => {
    const diagnostics = createDiagnostics();
    diagnostics.setReplayCounts(23, 4);
    diagnostics.record({
      at: timestamp(0),
      code: 'SB_DELIVERY_FAILED',
      severity: 'error',
      area: 'delivery',
      category: 'host_rejected',
    });
    for (let index = 1; index <= 100; index += 1) {
      diagnostics.record(record(index));
    }

    expect(diagnostics.snapshot()).toMatchObject({
      replay: { accepted: 23, skipped: 4 },
      deliveryFailureCount: 1,
      latestDeliveryFailure: {
        at: timestamp(0),
        code: 'SB_DELIVERY_FAILED',
        category: 'host_rejected',
      },
    });
    expect(diagnostics.snapshot().records.some((item) => item.code === 'SB_DELIVERY_FAILED')).toBe(
      false,
    );
  });

  it('normalizes invalid primitive metadata rather than retaining it', () => {
    const diagnostics = createDiagnostics();
    diagnostics.record({
      at: 'question text instead of a timestamp',
      code: 'SECRET_CODE',
      severity: 'SECRET_SEVERITY',
      area: '/home/private',
      category: 'exception message',
      correlationId: 'answer text\nstack',
    } as unknown as DiagnosticRecord);
    diagnostics.setReplayCounts(-1, Number.NaN);

    expect(diagnostics.snapshot()).toMatchObject({
      records: [
        {
          at: '1970-01-01T00:00:00.000Z',
          code: 'SB_INTERNAL',
          severity: 'error',
          area: 'lifecycle',
          category: 'unexpected',
          correlationId: 'sb-invalid-correlation-id',
        },
      ],
      replay: { accepted: 0, skipped: 0 },
    });
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(
      /question text|SECRET|\/home\/private/u,
    );
  });

  it('accepts unexpected-error records without receiving the raw cause', () => {
    const diagnostics = createDiagnostics();
    const error = convertUnexpectedError(new Error('secret exception content'), {
      correlationIds: { nextCorrelationId: () => 'corr-42' },
      at: timestamp(2),
      area: 'persistence',
      category: 'io_failure',
      diagnostics,
    });

    expect(error.correlationId).toBe('corr-42');
    expect(diagnostics.snapshot().records).toEqual([
      {
        at: timestamp(2),
        code: 'SB_INTERNAL',
        severity: 'error',
        area: 'persistence',
        category: 'io_failure',
        correlationId: 'corr-42',
      },
    ]);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('secret exception content');
  });
});
