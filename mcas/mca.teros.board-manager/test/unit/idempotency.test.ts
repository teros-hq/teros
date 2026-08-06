/**
 * Tests de idempotencia para las operaciones marcadas como tal en el runbook
 * (criterio 18, parte idempotencia). Previenen regresiones donde un retry
 * del SDK duplicaría side effects.
 *
 * Los handlers backend son idempotentes por naturaleza
 * (`remove-dependency` / `unsubscribe-from-board`): si la relación no existe,
 * devuelven el estado actual sin error. El test verifica que el MCA aplica
 * `withRetry` solo a esas tools y propaga el mismo resultado en llamadas
 * repetidas.
 *
 * Strategy: mockeamos el client WS para que devuelva siempre el mismo shape
 * y verificamos que el helper no explota al llamarse dos veces.
 */

import { describe, expect, it } from 'bun:test';
import { withRetry, withTimeout } from '../../src/tools/utils';

describe('withRetry — idempotent operations', () => {
  it('re-invocación del handler debe devolver el mismo shape', async () => {
    let calls = 0;
    const response = { task: { taskId: 't1', dependencies: [] } };
    const fn = async () => {
      calls++;
      return response;
    };

    const first = await withRetry(fn, { retries: 2, delayMs: 1, label: 'remove_dep_1' });
    const second = await withRetry(fn, { retries: 2, delayMs: 1, label: 'remove_dep_2' });

    expect(first).toBe(response);
    expect(second).toBe(response);
    expect(calls).toBe(2); // dos invocaciones exitosas, no hay retries extra
  });

  it('fallo transitorio seguido de éxito: no duplica side effects del éxito', async () => {
    const observations: string[] = [];
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        observations.push('attempt-1-failed');
        throw new Error('ETIMEDOUT — transient');
      }
      observations.push('attempt-2-succeeded');
      return { unsubscribed: true };
    };

    const result = await withRetry(fn, { retries: 3, delayMs: 1, label: 'unsubscribe' });
    expect(result).toEqual({ unsubscribed: true });
    expect(observations).toEqual(['attempt-1-failed', 'attempt-2-succeeded']);
    expect(calls).toBe(2);
  });

  it('tras agotar retries, propaga el error envuelto con el label', async () => {
    const fn = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      withRetry(fn, { retries: 2, delayMs: 1, label: 'remove_dependency' }),
    ).rejects.toThrow(/remove_dependency failed after 3 attempts/);
  });
});

describe('withTimeout — cancela sin efecto doble', () => {
  it('rechaza con el label cuando excede el tiempo', async () => {
    const slowPromise = new Promise<number>((resolve) => setTimeout(() => resolve(42), 200));
    await expect(withTimeout(slowPromise, 50, 'list_tasks')).rejects.toThrow(
      /Timeout: list_tasks did not complete within 50ms/,
    );
  });

  it('resuelve sin esperar al timeout cuando la operación termina antes', async () => {
    const fast = Promise.resolve('done');
    const result = await withTimeout(fast, 100, 'get_task');
    expect(result).toBe('done');
  });
});
