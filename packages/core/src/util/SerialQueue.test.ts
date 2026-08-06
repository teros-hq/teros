/**
 * SerialQueue tests (Phase 2.1 — TER-348 foundation).
 */

import { describe, expect, it } from 'bun:test';
import { SerialQueue } from './SerialQueue';

describe('SerialQueue', () => {
  it('executes a single operation and returns its result', async () => {
    const q = new SerialQueue();
    const result = await q.add(async () => 42);
    expect(result).toBe(42);
  });

  it('executes operations strictly in FIFO order', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const p1 = q.add(async () => {
      await sleep(20);
      order.push(1);
    });
    const p2 = q.add(async () => {
      await sleep(5);
      order.push(2);
    });
    const p3 = q.add(async () => {
      order.push(3);
    });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('an operation that throws does NOT block the queue', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const p1 = q.add(async () => {
      order.push('start');
      throw new Error('op1 failed');
    });
    const p2 = q.add(async () => {
      order.push('after-failure');
      return 'ok';
    });

    let thrown: unknown;
    try {
      await p1;
    } catch (e) {
      thrown = e;
    }

    const result = await p2;
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('op1 failed');
    expect(result).toBe('ok');
    expect(order).toEqual(['start', 'after-failure']);
  });

  it('error in one op does not poison other ops', async () => {
    const q = new SerialQueue();
    const results: Array<string | Error> = [];
    const tasks = [
      q.add(async () => 'a'),
      q.add(async () => {
        throw new Error('b-failed');
      }),
      q.add(async () => 'c'),
      q.add(async () => {
        throw new Error('d-failed');
      }),
      q.add(async () => 'e'),
    ];

    for (const t of tasks) {
      try {
        results.push(await t);
      } catch (e) {
        results.push(e as Error);
      }
    }

    expect(results[0]).toBe('a');
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as Error).message).toBe('b-failed');
    expect(results[2]).toBe('c');
    expect(results[3]).toBeInstanceOf(Error);
    expect((results[3] as Error).message).toBe('d-failed');
    expect(results[4]).toBe('e');
  });

  it('a SYNCHRONOUSLY throwing fn rejects its own promise without poisoning the queue (TER-469)', async () => {
    const q = new SerialQueue();
    // fn no-async que lanza antes de devolver una promesa: .then() lo captura.
    const p1 = q.add((() => {
      throw new Error('sync-boom');
    }) as unknown as () => Promise<never>);
    const p2 = q.add(async () => 'ok');

    let thrown: unknown;
    try {
      await p1;
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe('sync-boom');
    expect(await p2).toBe('ok');
  });

  it('does not start the second op until the first has resolved', async () => {
    const q = new SerialQueue();
    let firstResolved = false;
    let secondStartedBeforeFirstResolved = false;

    q.add(async () => {
      await sleep(30);
      firstResolved = true;
    });
    await q.add(async () => {
      if (!firstResolved) {
        secondStartedBeforeFirstResolved = true;
      }
    });

    expect(secondStartedBeforeFirstResolved).toBe(false);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
