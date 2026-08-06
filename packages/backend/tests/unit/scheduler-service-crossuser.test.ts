/**
 * Regression — cross-user next_run update en el executor (incidente prod
 * 2026-06-03, id=4 corriendo 2.212 veces cada 30s).
 *
 * Root cause: tras TER-358 el `id` de las recurring tasks es un counter
 * PER-USER, así que dos usuarios tienen legítimamente el mismo `id`. Los
 * writes de `processRecurringTask` filtraban por `{ id }` solo → un
 * `updateOne` impactaba la task de OTRO usuario y la nuestra nunca avanzaba
 * `next_run` → re-dispatch en cada tick (bucle infinito).
 *
 * Estos tests insertan DOS tasks con el mismo `id` y distinto `user_id`
 * (insertando primero la víctima para que el bug pre-fix sea determinista) y
 * verifican que cada write toca SOLO la task del usuario correcto.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { RECURRING_FAILURE_CAP } from "@teros/shared"
import { type Db, MongoClient } from "mongodb"
import { SchedulerService } from "../../src/services/scheduler-service"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017"
const DB_NAME = `teros_scheduler_crossuser_test_${Date.now()}`

const USER_A = "user_aaaaaaaaaaaaaaaa"
const USER_B = "user_bbbbbbbbbbbbbbbb"
const CHANNEL_A = "ch_aaaaaaaaaaaaaaaa"
const CHANNEL_B = "ch_bbbbbbbbbbbbbbbb"
const SHARED_ID = 4

const PAST = 1_000_000_000_000 // next_run de A en el pasado → due
const B_FUTURE = 4_000_000_000_000 // next_run de B en el futuro → no due

let client: MongoClient
let db: Db

/** EventHandler stub: el path sin MCAEventSubscriptionService usa este. */
function makeService(dispatchSuccess: boolean, dispatchError?: string): SchedulerService {
  const eventHandler = {
    handleScheduledEvent: async () => ({ success: dispatchSuccess, error: dispatchError }),
    // biome-ignore lint/suspicious/noExplicitAny: stub mínimo para el test
  } as any
  // Sin mcaEventSubscriptionService → usa eventHandler. Sin getChannelOwnerUserIdFn
  // → verifyOwnership devuelve true (Capa 3 skipped). Aísla el path de write-back.
  return new SchedulerService(db, eventHandler)
}

async function seedTwoTasks(opts?: { aConsecutiveFailures?: number }): Promise<void> {
  const tasks = db.collection("scheduler_recurring_tasks")
  // Insertamos B PRIMERO: con el bug, updateOne({ id }) sin sort impacta el
  // primer doc en orden natural (B) y deja A sin avanzar → reproduce el incidente.
  await tasks.insertOne({
    id: SHARED_ID,
    user_id: USER_B,
    channel_id: CHANNEL_B,
    message: "Tarea de B (víctima colateral)",
    cron_expression: "0 10 * * 0",
    timezone: "Europe/Madrid",
    enabled: true,
    next_run: B_FUTURE,
    created_at: PAST,
  })
  await tasks.insertOne({
    id: SHARED_ID,
    user_id: USER_A,
    channel_id: CHANNEL_A,
    message: "Tarea de A (la del bucle)",
    cron_expression: "0 15 * * *",
    timezone: "Europe/Madrid",
    enabled: true,
    next_run: PAST,
    created_at: PAST,
    ...(opts?.aConsecutiveFailures !== undefined
      ? { consecutive_failures: opts.aConsecutiveFailures }
      : {}),
  })
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI)
  await client.connect()
  db = client.db(DB_NAME)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  await db.collection("scheduler_recurring_tasks").deleteMany({})
  await db.collection("scheduler_executions").deleteMany({})
})

describe("processRecurringTask — aislamiento de writes cross-user", () => {
  it("dispatch OK: avanza next_run de A SIN tocar la task de B", async () => {
    await seedTwoTasks()
    const tasks = db.collection("scheduler_recurring_tasks")
    const taskA = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })

    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (makeService(true) as any).processRecurringTask(taskA)

    const a = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })
    const b = await tasks.findOne({ id: SHARED_ID, user_id: USER_B })

    // A avanzó a un next_run futuro (cron computado), no se quedó en el pasado.
    expect(a?.next_run).not.toBe(PAST)
    expect(a?.next_run).toBeGreaterThan(Date.now())
    expect(a?.last_run).toBeGreaterThan(PAST)

    // B intacta: este es el corazón del incidente. Pre-fix, B se llevaba el update.
    expect(b?.next_run).toBe(B_FUTURE)
    expect(b?.last_run).toBeUndefined()
    expect(b?.enabled).toBe(true)
  })

  it("dispatch FALLA: incrementa consecutive_failures de A SIN tocar a B", async () => {
    await seedTwoTasks()
    const tasks = db.collection("scheduler_recurring_tasks")
    const taskA = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })

    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (makeService(false, "boom") as any).processRecurringTask(taskA)

    const a = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })
    const b = await tasks.findOne({ id: SHARED_ID, user_id: USER_B })

    expect(a?.consecutive_failures).toBe(1)
    expect(a?.last_error).toBe("boom")
    expect(a?.next_run).not.toBe(PAST) // avanza igual (no atasco)

    // B no acumula failures ajenos.
    expect(b?.consecutive_failures).toBeUndefined()
    expect(b?.next_run).toBe(B_FUTURE)
    expect(b?.enabled).toBe(true)
  })

  it("auto-disable tras el cap: deshabilita SOLO a A, B sigue enabled", async () => {
    await seedTwoTasks({ aConsecutiveFailures: RECURRING_FAILURE_CAP - 1 })
    const tasks = db.collection("scheduler_recurring_tasks")
    const taskA = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })

    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (makeService(false, "boom") as any).processRecurringTask(taskA)

    const a = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })
    const b = await tasks.findOne({ id: SHARED_ID, user_id: USER_B })

    expect(a?.enabled).toBe(false) // alcanzó el cap → disabled
    expect(b?.enabled).toBe(true) // B jamás se deshabilita por fallos de A
  })
})

describe("processRecurringTask — claim atómico (anti doble-dispatch)", () => {
  it("una segunda ejecución del mismo slot no re-dispatcha (CAS sobre next_run)", async () => {
    await seedTwoTasks()
    const tasks = db.collection("scheduler_recurring_tasks")
    const taskA = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })

    let dispatches = 0
    const eventHandler = {
      handleScheduledEvent: async () => {
        dispatches++
        return { success: true }
      },
      // biome-ignore lint/suspicious/noExplicitAny: stub
    } as any
    const svc = new SchedulerService(db, eventHandler)

    // Dos ejecuciones con el MISMO doc stale (next_run en el pasado) — simula
    // dos instancias/ticks viendo la misma tarea due en la ventana de fallover.
    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (svc as any).processRecurringTask(taskA)
    // biome-ignore lint/suspicious/noExplicitAny: método privado
    await (svc as any).processRecurringTask(taskA)

    // El claim CAS (next_run <= ranAt) solo deja pasar al primero; el segundo
    // encuentra next_run ya avanzado → claim null → no dispatcha.
    expect(dispatches).toBe(1)
    const a = await tasks.findOne({ id: SHARED_ID, user_id: USER_A })
    expect(a?.next_run).not.toBe(PAST)
  })
})
