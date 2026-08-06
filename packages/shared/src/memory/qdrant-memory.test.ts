/**
 * Contract — memoria vectorial per-agente sobre Qdrant (TER-470).
 *
 * Mock FIEL del boundary: un FakeQdrantClient in-memory con similitud coseno
 * REAL (search ordena por score de verdad) inyectado vía mock.module de
 * `@qdrant/js-client-rest` (con restore en afterAll — los module mocks de bun
 * persisten entre archivos). Embeddings deterministas: mismo texto → mismo
 * vector → coseno 1.0 (ejercita la deduplicación real).
 *
 * El AISLAMIENTO per-agente es estructural (colección `agent_{id}_{type}`) —
 * el invariante se prueba con dos agentes reales sobre el mismo fake.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

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
  static instances: FakeQdrantClient[] = [];
  collections = new Map<
    string,
    { config: unknown; indexes: Array<Record<string, unknown>>; points: Map<string | number, FakePoint> }
  >();

  constructor(public config: { url: string; apiKey: string }) {
    FakeQdrantClient.instances.push(this);
  }

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

  async deleteCollection(name: string) {
    if (!this.collections.delete(name)) throw new Error(`Collection ${name} not found`);
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

  async search(
    name: string,
    args: { vector: number[]; limit: number; filter?: QdrantFilter },
  ) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    return [...col.points.values()]
      .filter((p) => matchesFilter(p.payload, args.filter))
      .map((p) => ({ id: p.id, score: cosine(args.vector, p.vector), payload: p.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);
  }

  async setPayload(name: string, args: { points: Array<string | number>; payload: Record<string, unknown> }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection ${name} not found`);
    for (const id of args.points) {
      const point = col.points.get(id);
      if (point) Object.assign(point.payload, args.payload);
    }
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
}

// biome-ignore lint/suspicious/noExplicitAny: passthrough del módulo real
const realQdrantModule = { ...(await import('@qdrant/js-client-rest')) } as any;

mock.module('@qdrant/js-client-rest', () => ({
  ...realQdrantModule,
  QdrantClient: FakeQdrantClient,
}));

// Embeddings deterministas: mismo texto → mismo vector (coseno 1.0). Las
// componentes llevan SIGNO (sin) para que textos distintos den cosenos lejos
// de 1 — con componentes todas positivas dos textos cualesquiera superaban el
// umbral de dedup 0.95 y el segundo save se descartaba como duplicado.
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

import {
  COLLECTION_TYPES,
  deleteAgentCollections,
  ensureAgentCollections,
  getAgentCollection,
  getAgentMemoryStats,
  getQdrant,
  initializeQdrant,
  listAgentsWithMemory,
  VECTOR_SIZE,
} from './qdrant-client.js';
import { getKnowledgeByCategory, saveKnowledge, searchKnowledge } from './knowledge.js';
import { getRecentConversations, saveConversation, searchConversations } from './conversation.js';

const AGENT_A = 'agent_aaaa111122223333';
const AGENT_B = 'agent_bbbb444455556666';

function currentFake(): FakeQdrantClient {
  return getQdrant() as unknown as FakeQdrantClient;
}

// ===========================================================================
// Inicialización — el invariante pre-init exige un módulo VIRGEN: otro
// archivo de la suite (context.test.ts) inicializa el singleton en este
// mismo proceso antes de que este archivo cargue, así que se prueba en un
// proceso hijo con import fresco (independiente del orden de la suite).
// ===========================================================================

describe('initializeQdrant / getQdrant', () => {
  it('getQdrant sin inicializar lanza (fail loud, no fallback)', () => {
    const clientPath = new URL('./qdrant-client.ts', import.meta.url).pathname;
    const probe = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `try { require('${clientPath}').getQdrant(); console.log('NO_THROW'); } catch (e) { console.log('THREW ' + e.message); }`,
      ],
    });
    const out = probe.stdout.toString();
    expect(out).toContain('THREW');
    expect(out).toContain('not initialized');
  });

  it('exige url y apiKey', () => {
    expect(() => initializeQdrant({ url: '', apiKey: 'k' })).toThrow('URL is required');
    expect(() => initializeQdrant({ url: 'http://q:6333', apiKey: '' })).toThrow('API key is required');
  });

  it('inicializa con la config dada', () => {
    initializeQdrant({ url: 'http://qdrant.test:6333', apiKey: 'test-key' });
    expect(currentFake().config).toEqual({ url: 'http://qdrant.test:6333', apiKey: 'test-key' });
  });
});

// A partir de aquí cada test parte de una instancia fresca.
beforeEach(() => {
  initializeQdrant({ url: 'http://qdrant.test:6333', apiKey: 'test-key' });
});

// ===========================================================================
// getAgentCollection — el MECANISMO de aislamiento
// ===========================================================================

describe('getAgentCollection', () => {
  it('formato agent_{id}_{type} con strip del prefijo agent_', () => {
    expect(getAgentCollection('agent_abc123', 'conversations')).toBe('agent_abc123_conversations');
    expect(getAgentCollection('abc123', 'knowledge')).toBe('agent_abc123_knowledge');
  });

  it('sanitiza caracteres fuera de [a-zA-Z0-9_-]', () => {
    expect(getAgentCollection('agent:iria', 'tasks')).toBe('agent_iria_tasks');
    expect(getAgentCollection('agent_x/../y', 'knowledge')).toBe('agent_x____y_knowledge');
  });

  it('CHARACTERIZATION: la sanitización puede COLISIONAR ids distintos', () => {
    // `agent:iria` y `agent_iria` mapean a la MISMA colección. Con los ids
    // canónicos de producción (agent_<16-hex>, solo [0-9a-f]) no hay colisión
    // posible, pero el riesgo existe para ids no canónicos. Documentado aquí;
    // cambel mapeo exigiría migrar todas las colecciones existentes.
    expect(getAgentCollection('agent:iria', 'knowledge')).toBe(
      getAgentCollection('agent_iria', 'knowledge'),
    );
    // Los ids canónicos NUNCA colisionan entre sí (inyectividad en su dominio)
    expect(getAgentCollection('agent_aaaa111122223333', 'knowledge')).not.toBe(
      getAgentCollection('agent_bbbb444455556666', 'knowledge'),
    );
  });
});

// ===========================================================================
// ensureAgentCollections / delete / stats / list
// ===========================================================================

describe('ensureAgentCollections', () => {
  it('crea las 3 colecciones con la config exacta (1536 dims, Cosine) e índices por tipo', async () => {
    await ensureAgentCollections(AGENT_A);
    const fake = currentFake();

    expect([...fake.collections.keys()].sort()).toEqual([
      'agent_aaaa111122223333_conversations',
      'agent_aaaa111122223333_knowledge',
      'agent_aaaa111122223333_tasks',
    ]);

    const conv = fake.collections.get('agent_aaaa111122223333_conversations')!;
    // Literal 1536, NO la constante importada — assert con VECTOR_SIZE sería
    // tautológico (gap Q4 del hunt: mutar la constante pasaba verde).
    expect(conv.config).toEqual({
      vectors: { size: 1536, distance: 'Cosine' },
      optimizers_config: { default_segment_number: 2 },
      on_disk_payload: true,
    });
    // conversations: timestamp + userId + channelId
    expect(conv.indexes.map((i) => i.field_name).sort()).toEqual(['channelId', 'timestamp', 'userId']);
    // knowledge: timestamp + category
    const know = fake.collections.get('agent_aaaa111122223333_knowledge')!;
    expect(know.indexes.map((i) => i.field_name).sort()).toEqual(['category', 'timestamp']);
    // tasks: solo timestamp
    const tasks = fake.collections.get('agent_aaaa111122223333_tasks')!;
    expect(tasks.indexes.map((i) => i.field_name)).toEqual(['timestamp']);
  });

  it('es idempotente: NO recrea colecciones existentes (no pisa puntos)', async () => {
    await ensureAgentCollections(AGENT_A);
    const fake = currentFake();
    const col = fake.collections.get('agent_aaaa111122223333_knowledge')!;
    col.points.set('p1', { id: 'p1', vector: [1], payload: {} });

    await ensureAgentCollections(AGENT_A);
    expect(fake.collections.get('agent_aaaa111122223333_knowledge')!.points.size).toBe(1);
  });
});

describe('deleteAgentCollections / listAgentsWithMemory / getAgentMemoryStats', () => {
  it('delete borra las 3 y tolera inexistentes; SOLO las del agente', async () => {
    await ensureAgentCollections(AGENT_A);
    await ensureAgentCollections(AGENT_B);

    await deleteAgentCollections(AGENT_A);
    const names = [...currentFake().collections.keys()];
    expect(names.filter((n) => n.includes('aaaa111122223333'))).toEqual([]);
    expect(names.filter((n) => n.includes('bbbb444455556666'))).toHaveLength(3);

    // Segunda pasada (ya no existen) no lanza
    await deleteAgentCollections(AGENT_A);
  });

  it('listAgentsWithMemory extrae los ids e ignora colecciones ajenas al patrón', async () => {
    await ensureAgentCollections(AGENT_A);
    await ensureAgentCollections(AGENT_B);
    currentFake().collections.set('otra_cosa', { config: {}, indexes: [], points: new Map() });
    // agent_* con sufijo NO válido — un regex laxo (gap Q6) extraería 'xyz'
    currentFake().collections.set('agent_xyz_backups', { config: {}, indexes: [], points: new Map() });

    const agents = await listAgentsWithMemory();
    expect(agents.sort()).toEqual(['aaaa111122223333', 'bbbb444455556666']);
  });

  it('stats cuenta por tipo y trata colección faltante como 0', async () => {
    await ensureAgentCollections(AGENT_A);
    const fake = currentFake();
    fake.collections.get('agent_aaaa111122223333_knowledge')!.points.set('k1', { id: 'k1', vector: [1], payload: {} });
    fake.collections.get('agent_aaaa111122223333_conversations')!.points.set('c1', { id: 'c1', vector: [1], payload: {} });
    fake.collections.get('agent_aaaa111122223333_conversations')!.points.set('c2', { id: 'c2', vector: [1], payload: {} });
    fake.collections.delete('agent_aaaa111122223333_tasks');

    expect(await getAgentMemoryStats(AGENT_A)).toEqual({
      conversations: 2,
      knowledge: 1,
      tasks: 0,
      totalPoints: 3,
    });
  });
});

// ===========================================================================
// knowledge — contract + scoping
// ===========================================================================

describe('knowledge', () => {
  it('saveKnowledge exige agentId y persiste el payload EXACTO en LA colección del agente', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: validación del guard
    await expect(saveKnowledge('' as any, 'f', 's', 'c')).rejects.toThrow('agentId is required');

    const id = await saveKnowledge(AGENT_A, 'A Antonio le gusta el café', 'chat', 'user_preferences', {
      userId: 'user_1',
    });

    const col = currentFake().collections.get('agent_aaaa111122223333_knowledge')!;
    const point = col.points.get(id)!;
    expect(point.payload).toEqual({
      id,
      fact: 'A Antonio le gusta el café',
      source: 'chat',
      category: 'user_preferences',
      confidence: 0.8, // default
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      agentId: AGENT_A,
      userId: 'user_1',
    });
    expect(point.vector).toEqual(fakeEmbedding('A Antonio le gusta el café'));
  });

  it('searchKnowledge ordena por similitud REAL y respeta limit', async () => {
    await saveKnowledge(AGENT_A, 'el café es de Colombia', 'chat', 'general');
    await saveKnowledge(AGENT_A, 'temas totalmente distintos sobre barcos veleros', 'chat', 'general');

    const results = await searchKnowledge(AGENT_A, 'el café es de Colombia', 1);
    expect(results).toHaveLength(1);
    expect(results[0].payload.fact).toBe('el café es de Colombia');
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  it('searchKnowledge marca last_accessed en los resultados devueltos', async () => {
    const id = await saveKnowledge(AGENT_A, 'dato', 'chat', 'general');
    await searchKnowledge(AGENT_A, 'dato', 5);
    const point = currentFake().collections.get('agent_aaaa111122223333_knowledge')!.points.get(id)!;
    expect(typeof point.payload.last_accessed).toBe('string');
  });

  it('filtro por category + colección inexistente devuelve []', async () => {
    await saveKnowledge(AGENT_A, 'comando útil', 'chat', 'commands');
    await saveKnowledge(AGENT_A, 'preferencia', 'chat', 'user_preferences');

    const commands = await searchKnowledge(AGENT_A, 'comando útil', 5, 'commands');
    expect(commands.map((r) => r.payload.category)).toEqual(['commands']);

    expect(await searchKnowledge('agent_sin_memoria_x1', 'lo que sea', 5)).toEqual([]);
    expect(await getKnowledgeByCategory('agent_sin_memoria_x1', 'commands')).toEqual([]);
  });

  it('INVARIANTE de scoping: la búsqueda de B JAMÁS devuelve memoria de A', async () => {
    await saveKnowledge(AGENT_A, 'secreto del agente A', 'chat', 'general');
    await ensureAgentCollections(AGENT_B);

    const results = await searchKnowledge(AGENT_B, 'secreto del agente A', 10);
    expect(results).toEqual([]);

    // Y getKnowledgeByCategory tampoco cruza
    expect(await getKnowledgeByCategory(AGENT_B, 'general')).toEqual([]);
  });
});

// ===========================================================================
// conversation — dedup + filtros + scoping
// ===========================================================================

describe('conversation', () => {
  it('saveConversation persiste el payload exacto con defaults (importance 0.5)', async () => {
    const id = await saveConversation('hola agente', 'hola humano', {
      agentId: AGENT_A,
      userId: 'user_1',
      channelId: 'ch_1',
    });

    expect(id).not.toBeNull();
    const point = currentFake()
      .collections.get('agent_aaaa111122223333_conversations')!
      .points.get(id!)!;
    expect(point.payload).toEqual({
      id,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      user_message: 'hola agente',
      assistant_response: 'hola humano',
      context: undefined,
      importance: 0.5,
      agentId: AGENT_A,
      userId: 'user_1',
      sessionId: undefined,
      channelId: 'ch_1',
    });
  });

  it('DEDUPLICACIÓN: la misma conversación dentro de la ventana se salta (null)', async () => {
    const first = await saveConversation('repite esto', 'vale', { agentId: AGENT_A });
    const dup = await saveConversation('repite esto', 'vale', { agentId: AGENT_A });

    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    expect(currentFake().collections.get('agent_aaaa111122223333_conversations')!.points.size).toBe(1);
  });

  it('dedup con threshold 1.0 y texto idéntico sigue siendo duplicado', async () => {
    // Contrato del límite superior. NOTA (hunt C2): el boundary `>=` vs `>`
    // del threshold NO es cazable de forma robusta — el coseno de un vector
    // consigo mismo da 1.0±2.2e-16 según el texto (verificado con probe), así
    // que la igualdad float exacta es infabricable. Mutante equivalente.
    await saveConversation('texto exacto', 'r', { agentId: AGENT_A });
    const dup = await saveConversation('texto exacto', 'r', {
      agentId: AGENT_A,
      deduplicationThreshold: 1.0,
    });
    expect(dup).toBeNull();
  });

  it('deduplicationThreshold: 0 desactiva la dedup', async () => {
    await saveConversation('repite esto', 'vale', { agentId: AGENT_A });
    const second = await saveConversation('repite esto', 'vale', {
      agentId: AGENT_A,
      deduplicationThreshold: 0,
    });
    expect(second).not.toBeNull();
  });

  it('searchConversations filtra por userId/channelId/since (los 3 must)', async () => {
    await saveConversation('tema uno aaa', 'r1', { agentId: AGENT_A, userId: 'user_1', channelId: 'ch_1' });
    await saveConversation('tema dos bbb', 'r2', { agentId: AGENT_A, userId: 'user_2', channelId: 'ch_2' });

    const byUser = await searchConversations(AGENT_A, 'tema', 10, { userId: 'user_1' });
    expect(byUser.map((r) => r.payload.user_message)).toEqual(['tema uno aaa']);

    const byChannel = await searchConversations(AGENT_A, 'tema', 10, { channelId: 'ch_2' });
    expect(byChannel.map((r) => r.payload.user_message)).toEqual(['tema dos bbb']);

    const since = await searchConversations(AGENT_A, 'tema', 10, { since: '2099-01-01T00:00:00Z' });
    expect(since).toEqual([]);
  });

  it('getRecentConversations ordena por timestamp DESC y filtra', async () => {
    await saveConversation('primera xyz', 'r', { agentId: AGENT_A, userId: 'user_1' });
    // Forzar timestamps distintos: el segundo más nuevo
    const col = currentFake().collections.get('agent_aaaa111122223333_conversations')!;
    for (const p of col.points.values()) p.payload.timestamp = '2026-01-01T00:00:00.000Z';
    await saveConversation('segunda abc', 'r', { agentId: AGENT_A, userId: 'user_1' });

    const recent = await getRecentConversations(AGENT_A, 10, { userId: 'user_1' });
    expect(recent.map((c) => c.user_message)).toEqual(['segunda abc', 'primera xyz']);

    expect(await getRecentConversations('agent_sin_memoria_x1', 10)).toEqual([]);
  });

  it('INVARIANTE de scoping: las conversaciones de A no aparecen para B', async () => {
    await saveConversation('confidencial de A', 'r', { agentId: AGENT_A, userId: 'user_1' });
    await ensureAgentCollections(AGENT_B);

    expect(await searchConversations(AGENT_B, 'confidencial de A', 10)).toEqual([]);
    expect(await getRecentConversations(AGENT_B, 10)).toEqual([]);
  });
});
