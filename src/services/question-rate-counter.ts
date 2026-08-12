import { fail, type Result, signalBoardError, succeed } from '../domain/errors.js';

/** Runtime-owned committed question mutation count for the current assistant turn. */
export class TurnQuestionRateCounter {
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

  /** Wire this method to the runtime turn_start reset hook. */
  reset(): void {
    this.#committed = 0;
  }
}
