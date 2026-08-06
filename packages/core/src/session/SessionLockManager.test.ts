/**
 * SessionLockManager — unit (TER-454).
 *
 * Previene ejecución concurrente sobre la misma sesión. El caso fino es
 * `unset` con identidad de controller: un handle viejo (huérfano tras un
 * abort + re-acquire) NO debe liberar el lock del dueño nuevo — la misma
 * clase de carrera que el close stale del socket MCA (TER-456).
 */

import { describe, expect, it } from "bun:test"
import { SessionLockedError, SessionLockManager } from "./SessionLockManager"

const SID = "session_test_1"

describe("acquire / dispose", () => {
  it("acquire marca busy y dispose libera", () => {
    const mgr = new SessionLockManager()
    const lock = mgr.acquire(SID)
    expect(mgr.isBusy(SID)).toBe(true)
    expect(mgr.getLockedSessions()).toEqual([SID])
    lock[Symbol.dispose]()
    expect(mgr.isBusy(SID)).toBe(false)
    expect(mgr.getLockedSessions()).toEqual([])
  })

  it("doble acquire lanza SessionLockedError con el sessionID y la edad", () => {
    const mgr = new SessionLockManager()
    mgr.acquire(SID)
    let caught: unknown
    try {
      mgr.acquire(SID)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SessionLockedError)
    expect((caught as Error).name).toBe("SessionLockedError")
    expect((caught as Error).message).toMatch(
      new RegExp(`^Session ${SID} is locked \\(acquired \\d+ms ago\\)$`),
    )
  })

  it("sesiones distintas no se bloquean entre sí", () => {
    const mgr = new SessionLockManager()
    mgr.acquire("session_a")
    expect(() => mgr.acquire("session_b")).not.toThrow()
    expect(mgr.getLockedSessions().sort()).toEqual(["session_a", "session_b"])
  })

  it("la signal del handle empieza sin abortar y dispose NO la aborta", () => {
    // dispose = salida limpia del scope: las operaciones en vuelo no se cancelan
    const mgr = new SessionLockManager()
    const lock = mgr.acquire(SID)
    expect(lock.signal.aborted).toBe(false)
    lock[Symbol.dispose]()
    expect(lock.signal.aborted).toBe(false)
  })

  it("doble dispose es no-op (no revienta ni toca otros locks)", () => {
    const mgr = new SessionLockManager()
    const lock = mgr.acquire(SID)
    lock[Symbol.dispose]()
    expect(() => lock[Symbol.dispose]()).not.toThrow()
    expect(mgr.isBusy(SID)).toBe(false)
  })
})

describe("abort", () => {
  it("handle.abort() aborta la signal Y libera el lock", () => {
    const mgr = new SessionLockManager()
    const lock = mgr.acquire(SID)
    lock.abort()
    expect(lock.signal.aborted).toBe(true)
    expect(mgr.isBusy(SID)).toBe(false)
  })

  it("manager.abort(sessionID) → true, aborta y libera; sobre no-locked → false", () => {
    const mgr = new SessionLockManager()
    const lock = mgr.acquire(SID)
    expect(mgr.abort(SID)).toBe(true)
    expect(lock.signal.aborted).toBe(true)
    expect(mgr.isBusy(SID)).toBe(false)
    expect(mgr.abort(SID)).toBe(false)
    expect(mgr.abort("session_never_locked")).toBe(false)
  })
})

describe("handle huérfano (identidad de controller en unset)", () => {
  it("el dispose de un handle VIEJO no libera el lock re-adquirido por otro", () => {
    const mgr = new SessionLockManager()
    const stale = mgr.acquire(SID)
    mgr.abort(SID) // crash/interrupt: el lock se va, el handle queda huérfano
    const fresh = mgr.acquire(SID) // nuevo dueño
    stale[Symbol.dispose]() // cleanup tardío del scope viejo
    expect(mgr.isBusy(SID)).toBe(true) // el dueño nuevo NO pierde su lock
    expect(fresh.signal.aborted).toBe(false)
  })

  it("el abort() de un handle VIEJO tampoco libera el lock del dueño nuevo", () => {
    const mgr = new SessionLockManager()
    const stale = mgr.acquire(SID)
    mgr.abort(SID)
    const fresh = mgr.acquire(SID)
    stale.abort() // aborta SU controller (ya muerto), no el del nuevo
    expect(mgr.isBusy(SID)).toBe(true)
    expect(fresh.signal.aborted).toBe(false)
  })

  it("CHARACTERIZATION: un lock sin dispose queda huérfano para siempre (sin TTL) — abort() es el único rescate", () => {
    // El manager es in-memory: un crash del PROCESO lo limpia todo; el
    // huérfano real es intra-proceso (un handler que lanza sin `using`).
    // No hay expiración: assertUnlocked seguirá lanzando hasta un abort.
    const mgr = new SessionLockManager()
    mgr.acquire(SID) // nunca se libera
    expect(mgr.isBusy(SID)).toBe(true)
    expect(() => mgr.assertUnlocked(SID)).toThrow(SessionLockedError)
    expect(mgr.abort(SID)).toBe(true) // rescate
    expect(() => mgr.assertUnlocked(SID)).not.toThrow()
  })
})

describe("assertUnlocked / getLockInfo / unlockAll", () => {
  it("assertUnlocked lanza solo si está locked", () => {
    const mgr = new SessionLockManager()
    expect(() => mgr.assertUnlocked(SID)).not.toThrow()
    const lock = mgr.acquire(SID)
    expect(() => mgr.assertUnlocked(SID)).toThrow(SessionLockedError)
    lock[Symbol.dispose]()
    expect(() => mgr.assertUnlocked(SID)).not.toThrow()
  })

  it("getLockInfo: null sin lock; created/age coherentes con lock", () => {
    const mgr = new SessionLockManager()
    expect(mgr.getLockInfo(SID)).toBeNull()
    const before = Date.now()
    mgr.acquire(SID)
    const info = mgr.getLockInfo(SID)
    expect(info).not.toBeNull()
    expect(info!.created).toBeGreaterThanOrEqual(before)
    expect(info!.created).toBeLessThanOrEqual(Date.now())
    expect(info!.age).toBeGreaterThanOrEqual(0)
  })

  it("unlockAll aborta TODAS las signals y vacía el manager", () => {
    const mgr = new SessionLockManager()
    const a = mgr.acquire("session_a")
    const b = mgr.acquire("session_b")
    mgr.unlockAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(mgr.getLockedSessions()).toEqual([])
  })

  it("tras unlockAll se puede re-adquirir", () => {
    const mgr = new SessionLockManager()
    mgr.acquire(SID)
    mgr.unlockAll()
    expect(() => mgr.acquire(SID)).not.toThrow()
  })
})
