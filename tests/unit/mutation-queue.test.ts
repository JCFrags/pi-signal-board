import { describe, expect, it } from 'vitest';

import { MutationQueue } from '../../src/services/mutation-queue.js';
import { createDeferred } from '../helpers/deferred.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MutationQueue', () => {
  it('runs parallel callers in FIFO call order and returns each result', async () => {
    const queue = new MutationQueue();
    const firstBarrier = createDeferred<void>('first');
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push('first:start');
      await firstBarrier.promise;
      order.push('first:end');
      return 11;
    });
    const second = queue.run(async () => {
      order.push('second');
      return 22;
    });
    const third = queue.run(() => {
      order.push('third');
      return 33;
    });

    await flushMicrotasks();
    expect(order).toEqual(['first:start']);
    firstBarrier.resolve();

    await expect(Promise.all([first, second, third])).resolves.toEqual([11, 22, 33]);
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  it('recovers its tail after a synchronous throw', async () => {
    const queue = new MutationQueue();
    const order: string[] = [];

    const failed = queue.run(() => {
      order.push('failed');
      throw new TypeError('synthetic sync failure');
    });
    const recovered = queue.run(() => {
      order.push('recovered');
      return 'ok';
    });

    await expect(failed).rejects.toThrow('synthetic sync failure');
    await expect(recovered).resolves.toBe('ok');
    expect(order).toEqual(['failed', 'recovered']);
  });

  it('recovers its tail after an asynchronous rejection without an unhandled tail', async () => {
    const queue = new MutationQueue();
    const rejection = createDeferred<void>('rejection');
    const failed = queue.run(() => rejection.promise);
    const recovered = queue.run(() => 'later');

    rejection.reject(new Error('synthetic async failure'));
    await expect(failed).rejects.toThrow('synthetic async failure');
    await expect(recovered).resolves.toBe('later');
    await expect(queue.run(() => 'final')).resolves.toBe('final');
  });
});
