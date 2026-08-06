/**
 * Contract de la capa de procesamiento VIVA de shared/memory (TER-486).
 *
 * Re-censo: el único consumidor externo es mca.teros.memory → lo VIVO es
 * context.ts (getRelevantContext + formatContextForPrompt, producción vía
 * memory-get-context-for-query) y tasks.searchTasks (llamada por
 * getRelevantContext). memory-processor / agent-integration /
 * knowledge-extractor / consolidation tienen 0 callers (filas en TER-478;
 * consolidation "Dreaming" es probablemente el target aspiracional de
 * TER-370) — NO se testean (regla feedback_dead_code_accumulative_issue).
 *
 * FakeQdrantClient + embeddings deterministas copiados del PR #179
 * (qdrant-memory.test.ts, rama TER-470) — unificar en un helper compartido
 * cuando ambos PRs estén en dev.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Fake del boundary Qdrant (superficie exacta que consume shared/memory)
// ---------------------------------------------------------------------------

interface FakePoint {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantFilter {
  must?: Array<{ key: string; match?: { value: unknown }; range?: { gte?: string } }>;
}

function matchesFilter(payload: Record<string, unknown>, filter?: QdrantFilter): boolean {
  if (!filter?.must) return true;
  return filter.must.every((cond) => {
    const value = payload[cond.key];
    if (cond.match) return value === cond.match.value;
    if (cond.range?.gte !== undefined) {
      return typeof value === 'string' && value >= cond.range.gte;
    }
    return true;
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class FakeQdrantClient {
  collections = new Map<
    string,
    { config: unknown; indexes: Array<Record<string, unknown>>; points: Map<string | number, FakePoint> }
  >();

  constructor(public config: { url: string; apiKey: string }) {}

  async getCollections() {
    return { collections: [...this.collections.keys()].map((name) => ({ name })) };
  }

  async createCollection(name: string, config: unknown) {
    this.collections.set(name, { config, indexes: [], points: new Map() });
  }

  async createPayloadIndex(name: string, spec: Record<string, unknown>) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    col.indexes.push(spec);
  }

  async getCollection(name: string) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    return { points_count: col.points.size };
  }

  async upsert(name: string, args: { points: FakePoint[] }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    for (const p of args.points) col.points.set(p.id, p);
  }

  async search(name: string, args: { vector: number[]; limit: number; filter?: QdrantFilter }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    return [...col.points.values()]
      .filter((p) => matchesFilter(p.payload, args.filter))
      .map((p) => ({ id: p.id, score: cosine(args.vector, p.vector), payload: p.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);
  }

  async scroll(name: string, args: { limit: number; filter?: QdrantFilter }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    return {
      points: [...col.points.values()]
        .filter((p) => matchesFilter(p.payload, args.filter))
        .slice(0, args.limit),
    };
  }

  // searchKnowledge actualiza last_accessed tras cada search — sin setPayload
  // en el fake, el TypeError caía al catch defensivo y devolvía [] (falso 0).
  async setPayload(
    name: string,
    args: { points: Array<string | number>; payload: Record<string, unknown> },
  ) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    for (const id of args.points) {
      const point = col.points.get(id);
      if (point) Object.assign(point.payload, args.payload);
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: passthrough del módulo real
const realQdrantModule = { ...(await import('@qdrant/js-client-rest')) } as any;

mock.module('@qdrant/js-client-rest', () => ({
  ...realQdrantModule,
  QdrantClient: FakeQdrantClient,
}));

// Embeddings deterministas: mismo texto → mismo vector (coseno 1.0); textos
// distintos → cosenos lejos de 1 (componentes con signo).
function fakeEmbedding(text: string): number[] {
  const v = Array.from({ length: 8 }, (_, i) => {
    let acc = 1;
    for (let j = 0; j < text.length; j++) {
      acc += text.charCodeAt(j) * (((j + i + 1) % 7) + 1);
    }
    return Math.sin(acc * (i + 1));
  });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

mock.module('./embeddings-lazy.js', () => ({
  generateEmbedding: async (text: string) => fakeEmbedding(text),
  generateEmbeddings: async (texts: string[]) => texts.map(fakeEmbedding),
  initEmbeddings: async () => {},
}));

afterAll(() => {
  mock.module('@qdrant/js-client-rest', () => realQdrantModule);
});

import { COLLECTION_TYPES, getAgentCollection, getQdrant, initializeQdrant } from './qdrant-client.js';
import { saveKnowledge } from './knowledge.js';
import { saveConversation } from './conversation.js';
import { formatContextForPrompt, getRelevantContext } from './context.js';
import { searchTasks } from './tasks.js';

const AGENT = 'agent_ctx0011223344ff';

beforeAll(async () => {
  initializeQdrant({ url: 'http://fake:6333', apiKey: 'k' });
  // Seed real por las funciones vivas
  await saveConversation('cómo desplegar a prod', 'usa deploy-server.sh', {
    agentId: AGENT,
    importance: 0.8,
  });
  await saveKnowledge(AGENT, 'el backend corre en :10001', 'test', 'project_data', {
    confidence: 0.9,
  });
  // saveTask es dead code (solo lo llamaba agent-integration, también dead) —
  // se siembra la colección de tasks directo al fake con el shape TaskMemory
  // para ejercitar el path VIVO searchTasks → getRelevantContext.
  const fake = getQdrant() as unknown as FakeQdrantClient;
  const tasksCol = getAgentCollection(AGENT, COLLECTION_TYPES.TASKS);
  if (!fake.collections.has(tasksCol)) await fake.createCollection(tasksCol, {});
  await fake.upsert(tasksCol, {
    points: [
      {
        id: 'task-1',
        // mismo embedding que la query combinada del test happy-path
        vector: fakeEmbedding('User: cómo desplegar a prod\nAssistant: usa deploy-server.sh'),
        payload: {
          id: 'task-1',
          description: 'desplegar backend a prod',
          files_modified: ['deploy.sh'],
          commands_run: ['./deploy-server.sh'],
          outcome: 'success',
          timestamp: '2026-06-01T00:00:00.000Z',
          agentId: AGENT,
        },
      },
      {
        id: 'task-2',
        vector: fakeEmbedding('otra cosa totalmente distinta xyz'),
        payload: {
          id: 'task-2',
          description: 'tarea fallida',
          outcome: 'failure',
          timestamp: '2026-06-02T00:00:00.000Z',
          agentId: AGENT,
        },
      },
    ],
  });
});

describe('getRelevantContext — lo VIVO de producción', () => {
  it('query idéntica al seed → los 3 tipos con mapping snake→camel exacto', async () => {
    // saveConversation embebe el COMBINADO `User: X\nAssistant: Y` — la query
    // con coseno 1.0 es ese string exacto (verificado en conversation.ts:65)
    const ctx = await getRelevantContext(
      AGENT,
      'User: cómo desplegar a prod\nAssistant: usa deploy-server.sh',
      { minRelevanceScore: 0.99 },
    );
    expect(ctx.conversations.length).toBe(1);
    expect(ctx.conversations[0].userMessage).toBe('cómo desplegar a prod');
    expect(ctx.conversations[0].assistantResponse).toBe('usa deploy-server.sh');
    expect(ctx.conversations[0].score).toBeCloseTo(1.0, 5);

    expect(ctx.tasks.length).toBe(1);
    expect(ctx.tasks[0]).toEqual({
      description: 'desplegar backend a prod',
      outcome: 'success',
      filesModified: ['deploy.sh'],
      commandsRun: ['./deploy-server.sh'],
      score: ctx.tasks[0].score,
    });
  })

  it('minRelevanceScore filtra por debajo del umbral (0 → todo pasa)', async () => {
    const strict = await getRelevantContext(AGENT, 'consulta sin relación qqq', {
      minRelevanceScore: 0.999,
    });
    expect(strict.conversations).toEqual([]);
    expect(strict.knowledge).toEqual([]);
    expect(strict.tasks).toEqual([]);

    const lax = await getRelevantContext(AGENT, 'consulta sin relación qqq', {
      minRelevanceScore: -1,
    });
    expect(lax.conversations.length).toBeGreaterThan(0);
    expect(lax.knowledge.length).toBeGreaterThan(0);
    expect(lax.tasks.length).toBeGreaterThan(0);
  })

  it('payloads incompletos → defaults ("" y []) sin crash', async () => {
    const fake = getQdrant() as unknown as FakeQdrantClient;
    const convCol = getAgentCollection(AGENT, COLLECTION_TYPES.CONVERSATIONS);
    await fake.upsert(convCol, {
      points: [{ id: 'conv-rota', vector: fakeEmbedding('payload roto zz'), payload: {} }],
    });
    const tasksCol = getAgentCollection(AGENT, COLLECTION_TYPES.TASKS);
    await fake.upsert(tasksCol, {
      points: [
        {
          id: 'task-rota',
          vector: fakeEmbedding('payload roto zz'),
          payload: { description: 'sin arrays', outcome: 'partial' },
        },
      ],
    });
    const ctx = await getRelevantContext(AGENT, 'payload roto zz', { minRelevanceScore: 0.99 });
    expect(ctx.conversations[0].userMessage).toBe('');
    expect(ctx.conversations[0].assistantResponse).toBe('');
    const broken = ctx.tasks.find((t) => t.description === 'sin arrays');
    expect(broken?.filesModified).toEqual([]);
    expect(broken?.commandsRun).toEqual([]);
  })

  it('el umbral es INCLUSIVO: score === minRelevanceScore pasa (gap C1, >= no >)', async () => {
    const lax = await getRelevantContext(AGENT, 'fact adicional uno', { minRelevanceScore: -1 })
    const exactScore = lax.knowledge[0].score as number
    const atThreshold = await getRelevantContext(AGENT, 'fact adicional uno', {
      minRelevanceScore: exactScore,
    })
    expect(atThreshold.knowledge.some((k) => k.score === exactScore)).toBe(true)
  })

  it('default conversationLimit = 1: con 2 conversaciones solo entra una (gap C2)', async () => {
    await saveConversation('segunda conversación distinta', 'otra respuesta', {
      agentId: AGENT,
      importance: 0.7,
    })
    const ctx = await getRelevantContext(AGENT, 'cualquier consulta', { minRelevanceScore: -1 })
    expect(ctx.conversations.length).toBe(1)
  })

  it('los límites custom viajan a los searches (knowledgeLimit acota)', async () => {
    await saveKnowledge(AGENT, 'fact adicional uno', 'test', 'commands', { confidence: 0.5 });
    await saveKnowledge(AGENT, 'fact adicional dos', 'test', 'commands', { confidence: 0.5 });
    const ctx = await getRelevantContext(AGENT, 'fact adicional uno', {
      minRelevanceScore: -1,
      knowledgeLimit: 1,
    });
    expect(ctx.knowledge.length).toBe(1);
  })
})

describe('searchTasks — el path vivo desde context', () => {
  it('colección inexistente → [] sin throw (catch defensivo)', async () => {
    expect(await searchTasks('agent_sin_memoria_99', 'lo que sea')).toEqual([]);
  })

  it('outcomeFilter aplica el filter de Qdrant (solo success)', async () => {
    const results = await searchTasks(AGENT, 'User: cómo desplegar a prod\nAssistant: usa deploy-server.sh', 5, 'success');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect((r.payload as { outcome: string }).outcome).toBe('success');
    }
  })

  it('shape del resultado {id, score, payload}', async () => {
    const results = await searchTasks(AGENT, 'User: cómo desplegar a prod\nAssistant: usa deploy-server.sh', 1);
    expect(Object.keys(results[0]).sort()).toEqual(['id', 'payload', 'score']);
  })
})

describe('formatContextForPrompt — string exacto (patrón TER-477)', () => {
  it('contexto vacío → "" (el caller aplica su fallback)', () => {
    expect(formatContextForPrompt({ conversations: [], knowledge: [], tasks: [] })).toBe('');
  })

  it('contexto completo → formato EXACTO con porcentajes redondeados', () => {
    const result = formatContextForPrompt({
      conversations: [
        { userMessage: 'u1', assistantResponse: 'a1', score: 0.875, timestamp: 't' },
      ],
      knowledge: [{ fact: 'f1', category: 'commands', confidence: 0.8, score: 0.7 }],
      tasks: [
        {
          description: 'd1',
          outcome: 'success',
          filesModified: ['x.ts'],
          commandsRun: ['ls'],
          score: 0.9,
        },
      ],
    });
    expect(result).toBe(
      [
        '---',
        '# 🧠 MEMORY CONTEXT',
        '',
        'The following information was automatically retrieved from your memory based on the current query:',
        '',
        '## 💬 Relevant Past Conversations\n',
        '### Conversation 1 (relevance: 88%)',
        '**User:** u1',
        '**Assistant:** a1',
        '',
        '## 📚 Relevant Knowledge\n',
        '1. [commands] f1 (confidence: 80%, relevance: 70%)',
        '',
        '## ✅ Relevant Past Tasks\n',
        '### Task 1 (success)',
        '**Description:** d1',
        '**Files:** x.ts',
        '**Commands:** ls',
        '',
        '---',
        '',
      ].join('\n'),
    );
  })

  it('task sin files ni commands → esas líneas se OMITEN', () => {
    const result = formatContextForPrompt({
      conversations: [],
      knowledge: [],
      tasks: [{ description: 'd', outcome: 'partial', filesModified: [], commandsRun: [], score: 0.5 }],
    });
    expect(result).not.toContain('**Files:**');
    expect(result).not.toContain('**Commands:**');
    expect(result).toContain('### Task 1 (partial)');
  })
})
