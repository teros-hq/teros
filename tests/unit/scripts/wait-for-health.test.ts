/**
 * Tests del health-polling del deploy (TER-519, scripts/wait-for-health.mjs).
 *
 * Este es el componente con el branch que de verdad puede fallar en el deploy:
 * decidir "backend listo" vs "reintentar/abortar". Si esta decisión se equivoca,
 * el deploy o bien continúa contra un backend roto (falso positivo, oculta un
 * deploy malo) o bien aborta+rollback con el backend sano (falso negativo, el
 * incidente 2026-05-28). El bash que lo invoca no es unit-testeable; esta lógica
 * extraída sí, y se muerde con fetch/sleep inyectados (ni red ni esperas reales).
 */
import { describe, expect, it } from 'bun:test';
// @ts-expect-error — .mjs sin tipos; es un script de deploy, no parte del bundle.
import { isHealthy, parseCliArgs, pollHealth } from '../../../scripts/wait-for-health.mjs';

// --- fakes fieles al boundary de fetch: { status, json() } ---
function makeRes(status: number, body: unknown) {
  return { status, json: async () => body };
}
function makeBadJsonRes(status: number) {
  return {
    status,
    json: async () => {
      throw new Error('invalid json');
    },
  };
}

/** fetch que devuelve SIEMPRE la misma respuesta; cuenta invocaciones. */
function alwaysFetch(status: number, body: unknown) {
  const fn: any = async () => {
    fn.count++;
    return makeRes(status, body);
  };
  fn.count = 0;
  return fn;
}

/** fetch que consume `items` en orden (un Error se lanza, simulando ECONNREFUSED). */
function sequenceFetch(items: unknown[]) {
  const fn: any = async () => {
    const item = items[fn.count];
    fn.count++;
    if (item instanceof Error) throw item;
    return item;
  };
  fn.count = 0;
  return fn;
}

/** sleep falso: no espera, solo cuenta — mantiene el test síncrono y rápido. */
function sleepSpy() {
  const fn: any = async () => {
    fn.count++;
  };
  fn.count = 0;
  return fn;
}

describe('isHealthy — listo exige HTTP 200 Y status:ok', () => {
  it('200 + {status:"ok"} → listo', () => {
    expect(isHealthy(200, { status: 'ok' })).toBe(true);
  });

  it('503 + {status:"degraded"} → no listo (Mongo caída en el /health profundo)', () => {
    expect(isHealthy(503, { status: 'degraded' })).toBe(false);
  });

  it('200 + {status:"degraded"} → no listo (el código 200 solo no basta)', () => {
    expect(isHealthy(200, { status: 'degraded' })).toBe(false);
  });

  it('500 + {status:"ok"} → no listo (un body "ok" tras un 5xx no cuenta)', () => {
    expect(isHealthy(500, { status: 'ok' })).toBe(false);
  });

  it('200 + null body → no listo', () => {
    expect(isHealthy(200, null)).toBe(false);
  });

  it('200 + {} sin campo status → no listo', () => {
    expect(isHealthy(200, {})).toBe(false);
  });
});

describe('pollHealth — sondea hasta listo o agotar intentos', () => {
  it('listo al primer intento → 1 fetch, 0 sleeps', async () => {
    const fetchImpl = alwaysFetch(200, { status: 'ok' });
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 5, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r).toEqual({ ok: true, attempts: 1, lastError: '' });
    expect(fetchImpl.count).toBe(1);
    expect(sleepImpl.count).toBe(0);
  });

  it('listo al tercer intento tras dos 503 → 3 fetches, 2 sleeps', async () => {
    const fetchImpl = sequenceFetch([
      makeRes(503, { status: 'degraded' }),
      makeRes(503, { status: 'degraded' }),
      makeRes(200, { status: 'ok' }),
    ]);
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 10, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r).toEqual({ ok: true, attempts: 3, lastError: '' });
    expect(fetchImpl.count).toBe(3);
    expect(sleepImpl.count).toBe(2);
  });

  it('nunca listo (503 siempre) → ok:false, agota intentos, N-1 sleeps, lastError exacto', async () => {
    const fetchImpl = alwaysFetch(503, { status: 'degraded' });
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 4, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r).toEqual({ ok: false, attempts: 4, lastError: 'HTTP 503 status=degraded' });
    expect(fetchImpl.count).toBe(4);
    expect(sleepImpl.count).toBe(3);
  });

  it('backend inalcanzable (fetch lanza) → reintenta y reporta el mensaje del error', async () => {
    const fetchImpl = sequenceFetch([
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
    ]);
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 3, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r).toEqual({ ok: false, attempts: 3, lastError: 'ECONNREFUSED' });
    expect(sleepImpl.count).toBe(2);
  });

  it('inalcanzable y luego sano → se recupera (caso real del restart)', async () => {
    const fetchImpl = sequenceFetch([new Error('ECONNREFUSED'), makeRes(200, { status: 'ok' })]);
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 5, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r).toEqual({ ok: true, attempts: 2, lastError: '' });
    expect(sleepImpl.count).toBe(1);
  });

  it('attempts=1 y no listo → 1 fetch, 0 sleeps (boundary, no duerme tras el último)', async () => {
    const fetchImpl = alwaysFetch(503, { status: 'degraded' });
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 1, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(fetchImpl.count).toBe(1);
    expect(sleepImpl.count).toBe(0);
  });

  it('body no parseable como JSON no rompe el loop (se trata como no listo)', async () => {
    const fetchImpl: any = async () => {
      fetchImpl.count++;
      return makeBadJsonRes(200);
    };
    fetchImpl.count = 0;
    const sleepImpl = sleepSpy();
    const r = await pollHealth({ url: 'u', attempts: 2, intervalMs: 1, fetchImpl, sleepImpl });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.lastError).toBe('HTTP 200');
  });
});

describe('parseCliArgs — el intervalo es SEGUNDOS, no ms (regresión TER-519)', () => {
  const ARGV = ['node', 'wait-for-health.mjs'];

  it('`30 2` → 30 intentos × 2000ms (2s), NO 2ms — el bug era que deploy-server pasaba `2`', () => {
    expect(parseCliArgs([...ARGV, 'https://be.teros.ai/health', '30', '2'])).toEqual({
      url: 'https://be.teros.ai/health',
      attempts: 30,
      intervalMs: 2000,
    });
  });

  it('sin arg de intervalo → default 2s (2000ms)', () => {
    expect(parseCliArgs([...ARGV, 'https://x/health'])).toEqual({
      url: 'https://x/health',
      attempts: 30,
      intervalMs: 2000,
    });
  });

  it('intervalo 5 → 5000ms', () => {
    expect(parseCliArgs([...ARGV, 'u', '10', '5']).intervalMs).toBe(5000);
  });

  it('url ausente → url null (main hace exit 2)', () => {
    expect(parseCliArgs([...ARGV]).url).toBeNull();
  });
});
