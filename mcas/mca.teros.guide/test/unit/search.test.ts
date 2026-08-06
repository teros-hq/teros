/**
 * search-guide ranking. MUERDE: afirma el TOP-1 esperado para queries reales
 * (si el ranking se rompe — orden fijo, pesos planos — el top-1 cambia y falla),
 * el shape plano, el fail-loud en query vacía, y el orden estable por score.
 */

import { describe, expect, test } from 'bun:test';
import { searchGuide, type SearchGuideOutput } from '../../src/tools/search-guide';

// biome-ignore lint/suspicious/noExplicitAny: el handler no usa el ToolContext
const CTX: any = {};
const run = (query: string, limit?: number) =>
  searchGuide.handler({ query, limit }, CTX) as Promise<SearchGuideOutput>;

describe('search-guide — ranking', () => {
  test('"how do I create an agent" → top-1 es el topic agents', async () => {
    const out = await run('how do I create an agent');
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0].id).toBe('agents');
    expect(out.count).toBe(out.results.length);
  });

  test('"connect gmail" → top-1 es apps-and-providers', async () => {
    const out = await run('connect gmail');
    expect(out.results[0].id).toBe('apps-and-providers');
  });

  test('"kanban board autorun" → top-1 es boards-and-autorun', async () => {
    const out = await run('kanban board autorun');
    expect(out.results[0].id).toBe('boards-and-autorun');
  });

  test('resultados ordenados por score descendente', async () => {
    const out = await run('agent app workspace');
    const scores = out.results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(out.results.every((r) => r.score > 0)).toBe(true);
  });

  test('shape plano + snippet presente (no {content,structuredContent})', async () => {
    const out = (await run('create an agent')) as unknown as Record<string, unknown>;
    expect(out.content).toBeUndefined();
    expect(out.structuredContent).toBeUndefined();
    const first = (out.results as SearchGuideOutput['results'])[0];
    expect(typeof first.snippet).toBe('string');
    expect(first.snippet.length).toBeGreaterThan(0);
  });

  test('limit acota el número de resultados', async () => {
    const out = await run('agent app workspace board file', 2);
    expect(out.results.length).toBeLessThanOrEqual(2);
  });

  test('query sin coincidencias → count 0', async () => {
    const out = await run('zzzqqxnomatchwhatsoever');
    expect(out.count).toBe(0);
    expect(out.results).toEqual([]);
  });

  test('query vacía → lanza (fail-loud)', async () => {
    await expect(run('   ')).rejects.toThrow(/required/);
  });
});
