export interface Deferred<T> {
  readonly label: string;
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export function createDeferred<T>(label = 'deferred'): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    label,
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
  };
}
