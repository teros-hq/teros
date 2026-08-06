/**
 * Handlers de las tools. MUERDEN: afirman el payload exacto (no "se llamó"),
 * cubren el path de error (topic inválido / ausente) y el shape del índice
 * (list NO debe filtrar el body — es lo que mantiene el índice barato).
 */

import { describe, expect, test } from 'bun:test';
import { GUIDE_TOPICS } from '../../src/content/topics';
import { getGuideSection } from '../../src/tools/get-section';
import { healthCheck } from '../../src/tools/health-check';
import { listGuideTopics } from '../../src/tools/list-topics';

// Estas tools no usan el ToolContext (sin secrets/red). Un stub vacío basta.
// biome-ignore lint/suspicious/noExplicitAny: context no usado por estos handlers
const CTX: any = {};

describe('list-guide-topics', () => {
  test('devuelve el índice completo: id+title+summary, count correcto, SIN body', async () => {
    // El handler devuelve los DATOS planos (lo que el backend serializa como
    // output que ve el agente — NO un wrapper {content, structuredContent}).
    const sc = (await listGuideTopics.handler({}, CTX)) as {
      topics: Array<{ id: string; title: string; summary: string; body?: unknown }>;
      count: number;
    };
    expect(sc.count).toBe(GUIDE_TOPICS.length);
    expect(sc.topics).toHaveLength(GUIDE_TOPICS.length);
    for (const entry of sc.topics) {
      expect(typeof entry.id).toBe('string');
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      // el índice debe ser barato: NO arrastra el body
      expect(entry.body).toBeUndefined();
    }
    // ids del índice == ids del contenido
    expect(sc.topics.map((t) => t.id).sort()).toEqual(GUIDE_TOPICS.map((t) => t.id).sort());
  });
});

describe('get-guide-section', () => {
  test('topic válido → body sustancial + metadata correcta', async () => {
    const sc = (await getGuideSection.handler({ topic: 'agents' }, CTX)) as {
      id: string;
      title: string;
      body: string;
      related: string[];
    };
    expect(sc.id).toBe('agents');
    expect(sc.body).toContain('Create Agent');
    expect(sc.body.length).toBeGreaterThan(100);
    expect(Array.isArray(sc.related)).toBe(true);
  });

  test('todos los topics del contenido son recuperables', async () => {
    for (const t of GUIDE_TOPICS) {
      const sc = (await getGuideSection.handler({ topic: t.id }, CTX)) as {
        id: string;
        body: string;
      };
      expect(sc.id).toBe(t.id);
      expect(sc.body).toBe(t.body);
    }
  });

  test('topic inválido → lanza error que LISTA los válidos (fail-loud)', async () => {
    await expect(getGuideSection.handler({ topic: 'does-not-exist' }, CTX)).rejects.toThrow(
      /Unknown guide topic.*agents/s,
    );
  });

  test('topic ausente → lanza error (required)', async () => {
    await expect(getGuideSection.handler({}, CTX)).rejects.toThrow(/required/);
  });
});

describe('-health-check', () => {
  test('ready con version y uptime, sin issues (contenido cargado)', async () => {
    const result = (await healthCheck.handler({}, CTX)) as {
      status: string;
      version?: string;
      uptime?: number;
      issues?: unknown[];
    };
    expect(result.status).toBe('ready');
    expect(result.version).toBe('1.0.0');
    expect(typeof result.uptime).toBe('number');
    expect(result.issues).toBeUndefined();
  });
});
