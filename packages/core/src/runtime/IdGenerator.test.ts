/**
 * Unit — IdGenerator (TER-563).
 *
 * `SeededIdGenerator` estabiliza el `channelId` del `[Current Context]` en
 * replay/record para que el hash del input del LLM coincida. El aislamiento por
 * namespace evita que el n-ésimo channelId dependa de cuántos ids de otros
 * prefijos se pidieron antes.
 */

import { describe, expect, it } from "bun:test"
import { RandomIdGenerator, SeededIdGenerator } from "./IdGenerator"

describe("SeededIdGenerator", () => {
  it("reproducible: misma (seed, namespace) → misma secuencia entre instancias", () => {
    const a = new SeededIdGenerator("s1", "ch")
    const b = new SeededIdGenerator("s1", "ch")
    expect(a.hex16()).toBe(b.hex16()) // 1º == 1º
    expect(a.hex16()).toBe(b.hex16()) // 2º == 2º
  })

  it("avanza la secuencia sin colisiones dentro del namespace", () => {
    const gen = new SeededIdGenerator("s1", "ch")
    const ids = [gen.hex16(), gen.hex16(), gen.hex16()]
    expect(new Set(ids).size).toBe(3)
  })

  it("formato: 16 hex en minúscula", () => {
    expect(new SeededIdGenerator("s1").hex16()).toMatch(/^[0-9a-f]{16}$/)
  })

  it("namespaces aislados: el 1er 'ch' NO depende de cuántos 'msg' se pidieron antes", () => {
    const gen1 = new SeededIdGenerator("s1")
    const msg = gen1.fork("msg")
    const ch = gen1.fork("ch")
    msg.hex16() // gastar la secuencia de 'msg'…
    msg.hex16()
    const chFirst = ch.hex16() // …no afecta al 1er 'ch'

    const chFresh = new SeededIdGenerator("s1").fork("ch").hex16()
    expect(chFirst).toBe(chFresh)
  })

  it("distinta seed → distinta secuencia", () => {
    expect(new SeededIdGenerator("s1", "ch").hex16()).not.toBe(
      new SeededIdGenerator("s2", "ch").hex16(),
    )
  })
})

describe("RandomIdGenerator", () => {
  it("formato 16 hex + sin colisiones prácticas", () => {
    const gen = new RandomIdGenerator()
    const ids = Array.from({ length: 100 }, () => gen.hex16())
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(new Set(ids).size).toBe(100)
  })
})
