/**
 * Invariantes de la migración embedded→collection (TER-462) contra Mongo
 * REAL (MONGODB_URI del entorno; :27019 contenedor teros-mongodb-test en local) — la migración es
 * IRREVERSIBLE y de alto blast-radius.
 *
 * Incluye regression de 2 fixes de pérdida de datos:
 *   F1 — mensajes malformados se descartaban en el filter pero el $unset
 *        borraba los embedded igualmente → pérdida silenciosa. Ahora la
 *        sesión se SKIPEA entera con warning.
 *   F2 — un crash entre insertMany y $unset dejaba la sesión half-migrated
 *        y el re-run la skipeaba para siempre (embedded nunca limpiados).
 *        Ahora el re-run COMPLETA la limpieza si los counts cuadran.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import { MongoSessionStore } from '../../src/session/MongoSessionStore';

const DB_NAME = `teros_test_ter462_${process.pid}`;
// El entorno inyecta MONGODB_URI (CI: mongodb://mongodb:27017). Fallback :27019
// para el contenedor de dev local. Sin el env var el CI conectaba a un puerto
// inexistente → 30s de timeout → "Unhandled error between tests".
const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27019', {
  serverSelectionTimeoutMS: 3000,
});
await client.connect();
const db: Db = client.db(DB_NAME);
const store = new MongoSessionStore(db);

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

beforeEach(async () => {
  await db.collection('sessions').deleteMany({});
  await db.collection('session_messages').deleteMany({});
  await db.collection('compactions').deleteMany({});
});

function msg(role: string, parts: unknown[] = [{ type: 'text', text: 'hola' }]) {
  return { info: { role, id: `msg_${Math.random().toString(36).slice(2, 8)}` }, parts };
}

async function seedSession(id: string, messages: unknown[], compaction?: unknown) {
  await db.collection('sessions').insertOne({
    id,
    channelId: 'ch_1',
    messages,
    ...(compaction ? { compaction } : {}),
  } as never);
}

describe('migrateSession — migración feliz', () => {
  it('mueve los mensajes 1:1 (info/parts EXACTOS, orden preservado) y limpia los embedded', async () => {
    const m1 = msg('user', [{ type: 'text', text: 'pregunta' }]);
    const m2 = msg('assistant', [{ type: 'text', text: 'respuesta' }]);
    const m3 = msg('user', [{ type: 'text', text: 'gracias' }]);
    await seedSession('session_a', [m1, m2, m3]);

    expect(await store.migrateSession('session_a')).toBe(true);

    const migrated = await db
      .collection('session_messages')
      .find({ sessionId: 'session_a' })
      .sort({ _id: 1 })
      .toArray();
    expect(migrated.length).toBe(3);
    expect(migrated.map((d) => ({ info: d.info, parts: d.parts }))).toEqual([
      { info: m1.info, parts: m1.parts },
      { info: m2.info, parts: m2.parts },
      { info: m3.info, parts: m3.parts },
    ]);

    const session = await db.collection('sessions').findOne({ id: 'session_a' } as never);
    expect(session?.messages).toBeUndefined();
    expect(session?.compaction).toBeUndefined();
  });

  it('INV-1: los pares tool_use/tool_result migran intactos y en orden', async () => {
    const toolUse = msg('assistant', [
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
    ]);
    const toolResult = msg('user', [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'archivos...' },
    ]);
    await seedSession('session_inv1', [msg('user'), toolUse, toolResult]);

    await store.migrateSession('session_inv1');

    const migrated = await db
      .collection('session_messages')
      .find({ sessionId: 'session_inv1' })
      .sort({ _id: 1 })
      .toArray();
    // Todo tool_use tiene su tool_result a continuación — sin orphans
    const uses = migrated.flatMap((d) =>
      (d.parts as Array<{ type: string; id?: string }>).filter((p) => p.type === 'tool_use'),
    );
    const results = migrated.flatMap((d) =>
      (d.parts as Array<{ type: string; tool_use_id?: string }>).filter(
        (p) => p.type === 'tool_result',
      ),
    );
    expect(uses.length).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0].tool_use_id).toBe(uses[0].id as string);
  });

  it('migra la compaction con su summary y cuenta de mensajes compactados', async () => {
    await seedSession('session_c', [msg('user'), msg('assistant')], {
      summary: 'resumen previo',
      compactedMessageIds: ['a', 'b', 'c'],
    });

    await store.migrateSession('session_c');

    const compaction = await db
      .collection('compactions')
      .findOne({ sessionId: 'session_c' } as never);
    expect(compaction?.summary).toBe('resumen previo');
    expect((compaction?.stats as { messagesCompacted: number }).messagesCompacted).toBe(3);
  });

  it('mensaje válido SIN parts → migra con parts: [] (gap G6: undefined no debe persistirse)', async () => {
    await seedSession('session_noparts', [{ info: { role: 'user', id: 'msg_np' } }]);
    expect(await store.migrateSession('session_noparts')).toBe(true);
    const doc = await db
      .collection('session_messages')
      .findOne({ sessionId: 'session_noparts' } as never);
    expect(doc?.parts).toEqual([]);
  });

  it('sesión sin messages o inexistente → false sin escribir nada', async () => {
    await seedSession('session_empty', []);
    expect(await store.migrateSession('session_empty')).toBe(false);
    expect(await store.migrateSession('session_ghost')).toBe(false);
    expect(await db.collection('session_messages').countDocuments()).toBe(0);
  });
});

describe('F1 — guard de pérdida de datos con shapes inesperados', () => {
  it('un mensaje malformado → sesión SKIPEADA entera, embedded INTACTOS (antes: pérdida silenciosa)', async () => {
    const good = msg('user');
    const malformed = { parts: [{ type: 'text', text: 'sin info.role' }] };
    await seedSession('session_bad', [good, malformed]);

    expect(await store.migrateSession('session_bad')).toBe(false);

    // NADA migrado, NADA borrado
    expect(await db.collection('session_messages').countDocuments({ sessionId: 'session_bad' })).toBe(0);
    const session = await db.collection('sessions').findOne({ id: 'session_bad' } as never);
    expect((session?.messages as unknown[]).length).toBe(2);
  });

  it.each([[null], [{ info: {} }], [{ info: { role: '' } }]])(
    'shape inválido %p también dispara el guard',
    async (bad) => {
      await seedSession('session_shapes', [msg('user'), bad]);
      expect(await store.migrateSession('session_shapes')).toBe(false);
      expect((await db.collection('sessions').findOne({ id: 'session_shapes' } as never))?.messages).toHaveLength(2);
    },
  );
});

describe('F2 — resume tras crash entre insertMany y $unset', () => {
  it('half-migrated (crash ANTES de createCompaction) → el re-run COMPLETA mensajes Y compaction', async () => {
    const m1 = msg('user');
    const m2 = msg('assistant');
    await seedSession('session_half', [m1, m2], { summary: 'residuo', compactedMessageIds: [] });
    // Crash tras insertMany, ANTES de createCompaction: mensajes en collection,
    // embedded (incl. compaction) aún presentes, compaction NO en su colección.
    await db.collection('session_messages').insertMany([
      { sessionId: 'session_half', info: m1.info, parts: m1.parts },
      { sessionId: 'session_half', info: m2.info, parts: m2.parts },
    ] as never[]);

    expect(await store.migrateSession('session_half')).toBe(true);

    const session = await db.collection('sessions').findOne({ id: 'session_half' } as never);
    expect(session?.messages).toBeUndefined();
    expect(session?.compaction).toBeUndefined(); // el embedded se limpia…
    // …PERO la compaction se migra a su colección, no se pierde (blocker TER-462 F2).
    expect((await db.collection('compactions').findOne({ sessionId: 'session_half' } as never))?.summary).toBe('residuo');
    expect(await db.collection('session_messages').countDocuments({ sessionId: 'session_half' })).toBe(2);
  });

  it('half-migrated (crash DESPUÉS de createCompaction) → completa sin DUPLICAR la compaction', async () => {
    const m1 = msg('user');
    const m2 = msg('assistant');
    await seedSession('session_half2', [m1, m2], { summary: 'residuo2', compactedMessageIds: [] });
    await db.collection('session_messages').insertMany([
      { sessionId: 'session_half2', info: m1.info, parts: m1.parts },
      { sessionId: 'session_half2', info: m2.info, parts: m2.parts },
    ] as never[]);
    // La compaction YA aterrizó en su colección antes del crash (createCompaction
    // es append-only → re-crear duplicaría).
    await db.collection('compactions').insertOne({
      sessionId: 'session_half2',
      summary: 'residuo2',
      lastMessageId: 'x',
      stats: { messagesCompacted: 0, tokensBefore: 0, tokensAfter: 0 },
    } as never);

    expect(await store.migrateSession('session_half2')).toBe(true);

    // Exactamente UNA compaction, no dos.
    expect(await db.collection('compactions').countDocuments({ sessionId: 'session_half2' })).toBe(1);
    expect((await db.collection('sessions').findOne({ id: 'session_half2' } as never))?.compaction).toBeUndefined();
  });

  it('counts DISTINTOS (conflicto real, emb<col) → no toca nada y false', async () => {
    await seedSession('session_conflict', [msg('user'), msg('assistant')]);
    await db
      .collection('session_messages')
      .insertOne({ sessionId: 'session_conflict', info: { role: 'user' }, parts: [] } as never);

    expect(await store.migrateSession('session_conflict')).toBe(false);

    const session = await db.collection('sessions').findOne({ id: 'session_conflict' } as never);
    expect((session?.messages as unknown[]).length).toBe(2);
    expect(await db.collection('session_messages').countDocuments({ sessionId: 'session_conflict' })).toBe(1);
  });

  it('counts DISTINTOS dirección col>emb (3 en collection, 2 embedded) → conflicto, false', async () => {
    // Fixture ASIMÉTRICO en la otra dirección: caza un swap de los operandos del
    // gate existingCount===validMessages.length (la memoria avisa: con simétricos
    // un swap es invisible).
    await seedSession('session_asym', [msg('user'), msg('assistant')]);
    await db.collection('session_messages').insertMany([
      { sessionId: 'session_asym', info: { role: 'user' }, parts: [] },
      { sessionId: 'session_asym', info: { role: 'assistant' }, parts: [] },
      { sessionId: 'session_asym', info: { role: 'user' }, parts: [] },
    ] as never[]);

    expect(await store.migrateSession('session_asym')).toBe(false);

    const session = await db.collection('sessions').findOne({ id: 'session_asym' } as never);
    expect((session?.messages as unknown[]).length).toBe(2); // embedded intactos
    expect(await db.collection('session_messages').countDocuments({ sessionId: 'session_asym' })).toBe(3);
  });
});

describe('idempotencia y migrateAllSessions', () => {
  it('re-run tras migración completa → skip sin duplicar', async () => {
    await seedSession('session_re', [msg('user')]);
    expect(await store.migrateSession('session_re')).toBe(true);
    // segunda pasada: la sesión ya no tiene embedded → false
    expect(await store.migrateSession('session_re')).toBe(false);
    expect(await db.collection('session_messages').countDocuments({ sessionId: 'session_re' })).toBe(1);
  });

  it('migrateAllSessions cuenta migrated/skipped EXACTOS (asimétricos: un swap sería invisible con 2=2)', async () => {
    await seedSession('session_m1', [msg('user')]);
    await seedSession('session_m5', [msg('assistant')]);
    await seedSession('session_m2', [msg('user'), msg('assistant')]);
    await seedSession('session_m3', []); // vacía → skipped
    await seedSession('session_m4', [msg('user'), { broken: true }]); // F1 → skipped

    const result = await store.migrateAllSessions();
    expect(result).toEqual({ migrated: 3, skipped: 2 });

    expect(await db.collection('session_messages').countDocuments()).toBe(4);
  });
});
