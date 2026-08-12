/** Source of time for domain and service operations. */
export interface Clock {
  now(): Date;
}

/** Production clock. Construct it per runtime and inject it into consumers. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for tests and other controlled adapters. */
export class FixedClock implements Clock {
  readonly #instantMs: number;

  constructor(instant: Date | string | number) {
    this.#instantMs = toValidInstant(instant, 'FixedClock requires a valid instant.');
  }

  now(): Date {
    return new Date(this.#instantMs);
  }
}

/**
 * Read a clock once and return its canonical UTC ISO 8601 timestamp.
 * Invalid injected values fail at this narrow boundary.
 */
export function utcNow(clock: Clock): string {
  let value: unknown;
  try {
    value = clock.now();
  } catch {
    throw new TypeError('Clock failed to provide a valid Date.');
  }

  if (!(value instanceof Date)) {
    throw new TypeError('Clock must provide a Date.');
  }

  const instantMs = value.getTime();
  if (!Number.isFinite(instantMs)) {
    throw new TypeError('Clock must provide a valid Date.');
  }

  return new Date(instantMs).toISOString();
}

function toValidInstant(value: Date | string | number, message: string): number {
  const instantMs = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(instantMs)) {
    throw new TypeError(message);
  }
  return instantMs;
}
