import { fail, type Result, signalBoardError, succeed } from '../domain/errors.js';

/** Runtime-owned committed acknowledgement count for the current assistant turn. */
export class TurnAcknowledgementRateCounter {
  #committed = 0;

  get committed(): number {
    return this.#committed;
  }

  check(limit: number): Result<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || this.#committed >= limit) {
      return fail(signalBoardError('SB_LIMIT_EXCEEDED'));
    }
    return succeed(undefined);
  }

  /** Call only after append and state swap both succeed. */
  commit(): void {
    this.#committed += 1;
  }

  reset(): void {
    this.#committed = 0;
  }
}
