/**
 * Tests de la señal de readiness a PM2 (TER-418, bootstrap/process-manager.ts).
 *
 * El bug que arregla: `ecosystem.prod.config.cjs` pide `wait_ready: true` pero el
 * backend nunca llamaba `process.send('ready')` → PM2 agotaba `listen_timeout`
 * (10 s) en cada restart. El único branch que de verdad importa es el guard: bajo
 * PM2 hay canal IPC (`send` definido) y debe enviarse `ready`; standalone (`tsx`
 * en local) `send` es undefined y NO debe petar. Se inyecta un `proc` falso para
 * morder ambos lados sin depender del entorno real.
 */
import { describe, expect, it } from 'bun:test';
import { notifyProcessManagerReady } from '../../../packages/backend/src/bootstrap/process-manager';

describe('notifyProcessManagerReady — señal de readiness a PM2 (TER-418)', () => {
  it('envía exactamente "ready" cuando hay canal IPC (proceso bajo PM2)', () => {
    const calls: unknown[] = [];
    notifyProcessManagerReady({
      send: (m: unknown) => {
        calls.push(m);
        return true;
      },
    });
    expect(calls).toEqual(['ready']);
  });

  it('es no-op (no lanza) sin canal IPC — standalone `tsx src/index.ts`', () => {
    expect(() => notifyProcessManagerReady({ send: undefined })).not.toThrow();
  });

  it('ignora el retorno de send (backpressure del IPC no es un error)', () => {
    const calls: unknown[] = [];
    notifyProcessManagerReady({
      send: (m: unknown) => {
        calls.push(m);
        return false;
      },
    });
    expect(calls).toEqual(['ready']);
  });
});
