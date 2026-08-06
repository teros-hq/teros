/**
 * MongoSessionStore — contract contra Mongo REAL (TER-454).
 *
 * Es el ÚNICO SessionStore de producción (DI container + migrate-messages +
 * TestServer); InMemorySessionStore tiene 0 instanciaciones (→ TER-478).
 * Cubre el boundary de compaction de getMessagesForLLM (la ventana que ve el
 * LLM), el upsert de streaming de writePart y los touch implícitos.
 *
 * Requiere el Mongo efímero de test en :27019 (bun test carga .env.test):
 *   docker run --rm -d --name teros-mongodb-test -p 127.0.0.1:27019:27017 --tmpfs /data/db mongo:7
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { Message, Part, Session } from "@teros/core"
import { type Db, MongoClient } from "mongodb"
import { MongoSessionStore } from "../../src/session/MongoSessionStore"

let client: MongoClient
let db: Db
let store: MongoSessionStore

const SID = "session_ter454_contract"

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SID,
    userId: "user_ter454",
    channelId: "ch_ter454",
    title: "contract test",
    time: { created: 1000, updated: 1000 },
    transportType: "channel",
    transportData: { channelId: "ch_ter454" },
    ...overrides,
  }
}

function userMsg(
  id: string,
  created: number,
  queueState?: "pending" | "running" | "done",
): Message {
  return {
    id,
    sessionID: SID,
    role: "user",
    time: { created },
    ...(queueState ? { meta: { queueState } } : {}),
  }
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: SID, messageID, type: "text", text }
}

beforeAll(async () => {
  client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27019", {
    serverSelectionTimeoutMS: 3000,
  })
  await client.connect()
  db = client.db(process.env.MONGODB_DATABASE ?? "teros_test")
  store = new MongoSessionStore(db)
})

beforeEach(async () => {
  await Promise.all([
    db.collection("sessions").deleteMany({ id: SID }),
    db.collection("session_messages").deleteMany({ sessionId: SID }),
    db.collection("compactions").deleteMany({ sessionId: SID }),
  ])
})

afterAll(async () => {
  await db.collection("sessions").deleteMany({ id: SID })
  await db.collection("session_messages").deleteMany({ sessionId: SID })
  await db.collection("compactions").deleteMany({ sessionId: SID })
  await client.close()
})

// ============================================================================
// Sesiones
// ============================================================================

describe("writeSession / getSession", () => {
  it("roundtrip preserva el shape del Session (CHARACTERIZATION: añade _id de Mongo)", async () => {
    const session = makeSession()
    await store.writeSession(session)
    const read = await store.getSession(SID)
    // El doc vuelve con el _id del driver — los consumers no lo declaran en
    // el tipo Session pero viaja; fijado aquí para que un cambio sea visible.
    const { _id, ...clean } = read as any
    expect(_id).toBeDefined()
    expect(clean).toEqual(session)
  })

  it("getSession de sesión inexistente → undefined (no null)", async () => {
    expect(await store.getSession("session_no_existe")).toBeUndefined()
  })

  it("writeSession es upsert: re-escribir actualiza sin duplicar", async () => {
    await store.writeSession(makeSession())
    await store.writeSession(makeSession({ title: "actualizado" }))
    const count = await db.collection("sessions").countDocuments({ id: SID })
    expect(count).toBe(1)
    expect((await store.getSession(SID))?.title).toBe("actualizado")
  })

  it("writeSession descarta el campo legacy `messages` embebido", async () => {
    await store.writeSession({ ...makeSession(), messages: [{ legacy: true }] } as any)
    const raw = await db.collection("sessions").findOne({ id: SID })
    expect(raw).not.toHaveProperty("messages")
  })

  it("touchSession actualiza SOLO time.updated", async () => {
    await store.writeSession(makeSession())
    const before = Date.now()
    await store.touchSession(SID)
    const read = await store.getSession(SID)
    expect(read?.time.updated).toBeGreaterThanOrEqual(before)
    expect(read?.time.created).toBe(1000)
    expect(read?.title).toBe("contract test")
  })

  it("listSessions filtra por userId y ordena por time.updated desc", async () => {
    await store.writeSession(makeSession({ time: { created: 1, updated: 50 } }))
    await store.writeSession(
      makeSession({ id: "session_ter454_b", time: { created: 1, updated: 200 } }),
    )
    await store.writeSession(makeSession({ id: "session_ter454_otro_user", userId: "user_otro" }))
    try {
      const sessions = await store.listSessions("user_ter454")
      expect(sessions.map((s) => s.id)).toEqual(["session_ter454_b", SID])
    } finally {
      await db
        .collection("sessions")
        .deleteMany({ id: { $in: ["session_ter454_b", "session_ter454_otro_user"] } })
    }
  })
})

// ============================================================================
// Mensajes y parts
// ============================================================================

describe("writeMessage / writePart", () => {
  it("writeMessage persiste y hace touch implícito de la sesión", async () => {
    await store.writeSession(makeSession())
    const before = Date.now()
    await store.writeMessage(userMsg("message_t1", 100))
    const msgs = await store.getMessagesWithParts(SID)
    expect(msgs).toEqual([{ info: userMsg("message_t1", 100), parts: [] }])
    expect((await store.getSession(SID))?.time.updated).toBeGreaterThanOrEqual(before)
  })

  it("writePart nuevo hace push; mismo id ACTUALIZA in place (streaming upsert)", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_t1", 100))
    await store.writePart(textPart("part_a", "message_t1", "v1"))
    await store.writePart(textPart("part_a", "message_t1", "v2 streaming"))
    await store.writePart(textPart("part_b", "message_t1", "otro"))
    expect(await store.listParts("message_t1")).toEqual([
      textPart("part_a", "message_t1", "v2 streaming"),
      textPart("part_b", "message_t1", "otro"),
    ])
  })

  it("writePart también hace touch implícito de la sesión", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_t1", 100))
    const before = Date.now()
    await store.writePart(textPart("part_a", "message_t1", "x"))
    expect((await store.getSession(SID))?.time.updated).toBeGreaterThanOrEqual(before)
  })

  it("listParts de mensaje inexistente → []", async () => {
    expect(await store.listParts("message_no_existe")).toEqual([])
  })

  it("getMessagesWithParts devuelve los mensajes en orden de inserción", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_t1", 300)) // created NO determina orden
    await store.writeMessage(userMsg("message_t2", 100))
    const msgs = await store.getMessagesWithParts(SID)
    expect(msgs.map((m) => m.info.id)).toEqual(["message_t1", "message_t2"])
  })
})

// ============================================================================
// Queue state
// ============================================================================

describe("updateUserMessageQueueState / listPendingQueueMessages", () => {
  it("actualiza el queueState de un user message", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_q1", 100, "pending"))
    await store.updateUserMessageQueueState("message_q1", "done")
    const msgs = await store.getMessagesWithParts(SID)
    expect((msgs[0].info as any).meta.queueState).toBe("done")
  })

  it("role guard: NO toca mensajes assistant aunque el id coincida", async () => {
    await store.writeSession(makeSession())
    const assistant = {
      id: "message_asst",
      sessionID: SID,
      role: "assistant",
      time: { created: 100 },
    } as unknown as Message
    await store.writeMessage(assistant)
    await store.updateUserMessageQueueState("message_asst", "done")
    const msgs = await store.getMessagesWithParts(SID)
    expect(msgs[0].info).not.toHaveProperty("meta")
  })

  it("no-op silencioso si el mensaje no existe", async () => {
    await expect(
      store.updateUserMessageQueueState("message_ghost", "done"),
    ).resolves.toBeUndefined()
  })

  it("lista pending+running ordenados por time.created; done y sin-meta quedan fuera", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_done", 50, "done"))
    await store.writeMessage(userMsg("message_run", 300, "running"))
    await store.writeMessage(userMsg("message_pend", 100, "pending"))
    await store.writeMessage(userMsg("message_legacy", 10)) // sin meta
    const pending = await store.listPendingQueueMessages([SID])
    expect(pending.map((m) => m.info.id)).toEqual(["message_pend", "message_run"])
    expect(pending[0].parts).toEqual([])
  })

  it("channelIds vacío → [] sin tocar la DB", async () => {
    expect(await store.listPendingQueueMessages([])).toEqual([])
  })
})

// ============================================================================
// Compaction boundary — la ventana que ve el LLM
// ============================================================================

describe("getMessagesForLLM + compaction", () => {
  it("sin compaction: summary undefined y TODOS los mensajes", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_1", 100))
    await store.writeMessage(userMsg("message_2", 200))
    const result = await store.getMessagesForLLM(SID)
    expect(result.summary).toBeUndefined()
    expect(result.messages.map((m) => m.info.id)).toEqual(["message_1", "message_2"])
  })

  it("tras updateCompactionSummary: solo mensajes POSTERIORES al boundary + summary", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_old1", 100))
    await store.writeMessage(userMsg("message_old2", 200))
    await store.updateCompactionSummary(SID, "resumen de lo viejo", [
      "message_old1",
      "message_old2",
    ])
    await store.writeMessage(userMsg("message_new", 300))

    const result = await store.getMessagesForLLM(SID)
    expect(result.summary).toBe("resumen de lo viejo")
    expect(result.messages.map((m) => m.info.id)).toEqual(["message_new"])

    // getMessagesWithParts (interfaz legacy) respeta el MISMO boundary
    const withParts = await store.getMessagesWithParts(SID)
    expect(withParts.map((m) => m.info.id)).toEqual(["message_new"])

    // pero getAllMessages (migración) sigue viendo la historia completa
    const all = await store.getAllMessages(SID)
    expect(all.map((m) => m.info.id)).toEqual(["message_old1", "message_old2", "message_new"])
  })

  it("compactions sucesivas: gana el boundary MÁS RECIENTE", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_a", 100))
    await store.updateCompactionSummary(SID, "primer resumen", ["message_a"])
    await store.writeMessage(userMsg("message_b", 200))
    await store.updateCompactionSummary(SID, "segundo resumen", ["message_b"])
    await store.writeMessage(userMsg("message_c", 300))

    const result = await store.getMessagesForLLM(SID)
    expect(result.summary).toBe("segundo resumen")
    expect(result.messages.map((m) => m.info.id)).toEqual(["message_c"])
  })

  it("updateCompactionSummary sin mensajes → no-op (no crea compaction ni lanza)", async () => {
    await store.writeSession(makeSession())
    await store.updateCompactionSummary(SID, "resumen huérfano", [])
    expect(await db.collection("compactions").countDocuments({ sessionId: SID })).toBe(0)
  })

  it("updateCompactionSummary marca hasCompaction en la sesión", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_1", 100))
    await store.updateCompactionSummary(SID, "r", ["message_1"])
    const raw = await db.collection("sessions").findOne({ id: SID })
    expect(raw?.hasCompaction).toBe(true)
  })

  it("getCompactionSummary devuelve el último summary", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_1", 100))
    await store.updateCompactionSummary(SID, "el resumen", ["message_1"])
    expect(await store.getCompactionSummary(SID)).toBe("el resumen")
  })

  // REGRESIÓN CTX-002 (pérdida silenciosa de contexto): la compactación resume
  // solo los mensajes VIEJOS y protege los recientes; el boundary debe quedar en
  // el último COMPACTADO, no en el último de la sesión. Con el bug, el boundary
  // caía en el último mensaje → getMessagesForLLM (_id > boundary) devolvía los
  // protegidos ausentes del summary Y de la recarga = perdidos. Verificado en
  // datos reales: una compactación real perdió 51 mensajes protegidos.
  // Este test MUERDE: con el código viejo el expected [p1,p2] daba [] (rojo).
  it("CTX-002: preserva los mensajes recientes protegidos (no compactados)", async () => {
    await store.writeSession(makeSession())
    // 3 viejos (se resumen) + 2 recientes PROTEGIDOS (no van en compactedIds)
    await store.writeMessage(userMsg("message_c1", 100))
    await store.writeMessage(userMsg("message_c2", 200))
    await store.writeMessage(userMsg("message_c3", 300))
    await store.writeMessage(userMsg("message_p1", 400))
    await store.writeMessage(userMsg("message_p2", 500))

    // La compactación resume SOLO los 3 viejos (como hace splitMessages).
    await store.updateCompactionSummary(SID, "resumen de c1..c3", [
      "message_c1",
      "message_c2",
      "message_c3",
    ])

    const result = await store.getMessagesForLLM(SID)
    expect(result.summary).toBe("resumen de c1..c3")
    // Los 2 protegidos DEBEN sobrevivir (con el bug se perdían).
    expect(result.messages.map((m) => m.info.id)).toEqual(["message_p1", "message_p2"])
  })

  it("CTX-002: tras compactar, protegidos + mensajes nuevos conviven en la ventana", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_c1", 100))
    await store.writeMessage(userMsg("message_p1", 200)) // protegido
    await store.updateCompactionSummary(SID, "resumen de c1", ["message_c1"])
    await store.writeMessage(userMsg("message_new", 300)) // turno siguiente

    const result = await store.getMessagesForLLM(SID)
    expect(result.summary).toBe("resumen de c1")
    expect(result.messages.map((m) => m.info.id)).toEqual(["message_p1", "message_new"])
  })

  it("boundary = ObjectId del último mensaje COMPACTADO, no el último de la sesión", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_c1", 100))
    await store.writeMessage(userMsg("message_p1", 200)) // protegido, posterior
    await store.updateCompactionSummary(SID, "r", ["message_c1"])

    const c1 = await db.collection("session_messages").findOne({ sessionId: SID, "info.id": "message_c1" })
    const compaction = await db.collection("compactions").findOne({ sessionId: SID })
    expect(compaction?.lastMessageId?.toString()).toBe(c1?._id?.toString())
  })
})

// ============================================================================
// deleteSession — cascade
// ============================================================================

describe("deleteSession", () => {
  it("borra sesión + mensajes + compactions en cascada", async () => {
    await store.writeSession(makeSession())
    await store.writeMessage(userMsg("message_1", 100))
    await store.updateCompactionSummary(SID, "r", ["message_1"])
    await store.writeMessage(userMsg("message_2", 200))

    await store.deleteSession(SID)

    expect(await store.getSession(SID)).toBeUndefined()
    expect(await db.collection("session_messages").countDocuments({ sessionId: SID })).toBe(0)
    expect(await db.collection("compactions").countDocuments({ sessionId: SID })).toBe(0)
  })
})
