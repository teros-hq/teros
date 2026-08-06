/**
 * Unit — Clock (TER-563).
 *
 * `FixedClock` es lo que estabiliza el timestamp del `[Current Context]` en
 * replay/record para que el hash del input del LLM coincida entre ejecuciones.
 */

import { describe, expect, it } from "bun:test"
import { FixedClock, SystemClock } from "./Clock"

describe("FixedClock", () => {
  it("congelado por defecto: now() devuelve siempre el mismo instante", () => {
    const clock = new FixedClock(1_700_000_000_000)
    expect(clock.now()).toBe(1_700_000_000_000)
    expect(clock.now()).toBe(1_700_000_000_000)
    expect(clock.now()).toBe(1_700_000_000_000)
  })

  it("con stepMs avanza monotónicamente por llamada", () => {
    const clock = new FixedClock(1000, 5)
    expect(clock.now()).toBe(1000)
    expect(clock.now()).toBe(1005)
    expect(clock.now()).toBe(1010)
  })
})

describe("SystemClock", () => {
  it("now() cae dentro de un Date.now() real", () => {
    const clock = new SystemClock()
    const before = Date.now()
    const t = clock.now()
    const after = Date.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })
})
