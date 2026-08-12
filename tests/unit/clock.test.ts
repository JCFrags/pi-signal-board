import { describe, expect, it } from 'vitest';

import { type Clock, FixedClock, SystemClock, utcNow } from '../../src/domain/clock.js';

describe('clock abstractions', () => {
  it('returns a canonical UTC ISO timestamp from an injected clock', () => {
    const clock = new FixedClock('2026-08-12T01:02:03.456-07:00');

    expect(utcNow(clock)).toBe('2026-08-12T08:02:03.456Z');
    expect(clock.now()).not.toBe(clock.now());
  });

  it('supports deterministic Date and epoch fixtures without retaining mutable Dates', () => {
    const source = new Date('2026-01-02T03:04:05.006Z');
    const fromDate = new FixedClock(source);
    const fromEpoch = new FixedClock(source.getTime());
    source.setUTCFullYear(2030);

    expect(utcNow(fromDate)).toBe('2026-01-02T03:04:05.006Z');
    expect(utcNow(fromEpoch)).toBe('2026-01-02T03:04:05.006Z');
  });

  it('rejects invalid fixed clock input', () => {
    expect(() => new FixedClock('not-a-date')).toThrow(TypeError);
    expect(() => new FixedClock(Number.NaN)).toThrow(TypeError);
    expect(() => new FixedClock(new Date(Number.NaN))).toThrow(TypeError);
  });

  it('rejects invalid or failed injected clock results at utcNow', () => {
    const invalidDate: Clock = { now: () => new Date(Number.NaN) };
    const wrongType = { now: () => '2026-01-02T03:04:05.000Z' } as unknown as Clock;
    const failed: Clock = {
      now: () => {
        throw new Error('clock failure');
      },
    };

    expect(() => utcNow(invalidDate)).toThrow(TypeError);
    expect(() => utcNow(wrongType)).toThrow(TypeError);
    expect(() => utcNow(failed)).toThrow(TypeError);
  });

  it('provides valid current UTC time in production', () => {
    const before = Date.now();
    const timestamp = utcNow(new SystemClock());
    const after = Date.now();

    expect(new Date(timestamp).toISOString()).toBe(timestamp);
    expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(timestamp)).toBeLessThanOrEqual(after);
  });
});
