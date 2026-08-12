export interface TestClock {
  now(): Date;
}

export class FakeClock implements TestClock {
  private currentMs: number;

  constructor(initial = '2026-01-02T03:04:05.000Z') {
    this.currentMs = new Date(initial).getTime();
    if (!Number.isFinite(this.currentMs)) throw new TypeError('FakeClock requires a valid date.');
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  set(value: Date | string | number): void {
    const next = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(next)) throw new TypeError('FakeClock requires a valid date.');
    this.currentMs = next;
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) throw new TypeError('Milliseconds must be finite.');
    this.currentMs += milliseconds;
  }
}

export type IdKind = 'event' | 'update' | 'question' | 'answer' | 'command' | 'entry';

const ID_PREFIXES: Readonly<Record<IdKind, string>> = {
  event: 'evt',
  update: 'upd',
  question: 'qst',
  answer: 'ans',
  command: 'cmd',
  entry: 'ent',
};

export class DeterministicIds {
  private readonly counters = new Map<IdKind, number>();
  private readonly scripted = new Map<IdKind, string[]>();

  seed(kind: IdKind, values: readonly string[]): void {
    this.scripted.set(kind, [...values]);
  }

  next(kind: IdKind): string {
    const values = this.scripted.get(kind);
    const scripted = values?.shift();
    if (scripted !== undefined) return scripted;

    const counter = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, counter);
    return `${ID_PREFIXES[kind]}_${counter.toString().padStart(4, '0')}`;
  }

  event = (): string => this.next('event');
  update = (): string => this.next('update');
  question = (): string => this.next('question');
  answer = (): string => this.next('answer');
  command = (): string => this.next('command');
}

export interface FakeTimerHandle {
  readonly id: number;
}

type TimerCallback = () => void | Promise<void>;

interface PendingTimer {
  readonly handle: FakeTimerHandle;
  readonly callback: TimerCallback;
  readonly dueAt: number;
  unrefed: boolean;
}

export class FakeTimers {
  private nextId = 1;
  private readonly timers = new Map<number, PendingTimer>();
  readonly calls: Array<
    | { operation: 'set'; id: number; delayMs: number }
    | { operation: 'clear' | 'unref' | 'fire'; id: number }
  > = [];

  constructor(readonly clock: FakeClock) {}

  setTimeout(callback: TimerCallback, delayMs: number): FakeTimerHandle {
    const handle = { id: this.nextId++ };
    this.timers.set(handle.id, {
      handle,
      callback,
      dueAt: this.clock.now().getTime() + Math.max(0, delayMs),
      unrefed: false,
    });
    this.calls.push({ operation: 'set', id: handle.id, delayMs });
    return handle;
  }

  clearTimeout(handle: FakeTimerHandle): void {
    this.timers.delete(handle.id);
    this.calls.push({ operation: 'clear', id: handle.id });
  }

  unref(handle: FakeTimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer) timer.unrefed = true;
    this.calls.push({ operation: 'unref', id: handle.id });
  }

  pending(): readonly { id: number; dueAt: number; unrefed: boolean }[] {
    return [...this.timers.values()]
      .sort((left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id)
      .map((timer) => ({ id: timer.handle.id, dueAt: timer.dueAt, unrefed: timer.unrefed }));
  }

  async advanceBy(milliseconds: number): Promise<void> {
    const target = this.clock.now().getTime() + milliseconds;
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id)[0];
      if (!next) break;
      this.clock.set(next.dueAt);
      await this.fire(next.handle);
    }
    this.clock.set(target);
  }

  async fire(handle: FakeTimerHandle): Promise<void> {
    const timer = this.timers.get(handle.id);
    if (!timer) return;
    this.timers.delete(handle.id);
    this.calls.push({ operation: 'fire', id: handle.id });
    await timer.callback();
  }
}
