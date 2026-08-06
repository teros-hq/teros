/**
 * Properties fast-check de mca.teros.datetime (TER-503).
 *
 * Las tools son funciones puras de datos sobre luxon — postcondiciones:
 *   P1 add/subtract son inversas para durations de TIEMPO PURO (sin
 *      months/years: el clamping de fin de mes rompe la inversa).
 *   P2 diff es antisimétrico: diff(a,b) === -diff(b,a).
 *   P3 roundtrip: todo ISO emitido por add parsea valid:true.
 * Cada propiedad se demostró falsable con mutación dirigida (hunt P*).
 */

import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import { handleToolCall } from "../../mcp/src/handlers"

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = (await handleToolCall(name, args)) as {
    content: Array<{ text: string }>
    isError?: boolean
  }
  expect(result.isError).toBeUndefined()
  return JSON.parse(result.content[0].text)
}

// Instantes en rango seguro (2000–2100) y durations de tiempo puro
const arbInstant = fc
  .integer({ min: 946684800000, max: 4102444800000 })
  .map((ms) => new Date(ms).toISOString())

const arbDuration = fc.record({
  days: fc.integer({ min: 0, max: 400 }),
  hours: fc.integer({ min: 0, max: 48 }),
  minutes: fc.integer({ min: 0, max: 120 }),
  seconds: fc.integer({ min: 0, max: 120 }),
})

describe("properties", () => {
  it("P1: subtract(add(dt, dur), dur) === dt (inversa exacta en tiempo puro)", async () => {
    await fc.assert(
      fc.asyncProperty(arbInstant, arbDuration, async (iso, duration) => {
        const added = await call("add", { datetime: iso, duration })
        const back = await call("subtract", { datetime: added.result, duration })
        expect(back.result).toBe(added.original)
      }),
      { numRuns: 50 },
    )
  })

  it("P2: diff(a,b).milliseconds === -diff(b,a).milliseconds", async () => {
    await fc.assert(
      fc.asyncProperty(arbInstant, arbInstant, async (a, b) => {
        const ab = (await call("diff", { start: a, end: b })) as {
          difference: { milliseconds: number }
        }
        const ba = (await call("diff", { start: b, end: a })) as {
          difference: { milliseconds: number }
        }
        expect(ab.difference.milliseconds).toBe(-ba.difference.milliseconds)
      }),
      { numRuns: 50 },
    )
  })

  it("P3: roundtrip — el result de add siempre parsea valid", async () => {
    await fc.assert(
      fc.asyncProperty(arbInstant, arbDuration, async (iso, duration) => {
        const added = await call("add", { datetime: iso, duration })
        const parsed = await call("parse", { datetime: added.result })
        expect(parsed.valid).toBe(true)
      }),
      { numRuns: 50 },
    )
  })

  it("P4: diff(start, add(start, dur), 'milliseconds') === duración total en ms", async () => {
    await fc.assert(
      fc.asyncProperty(arbInstant, arbDuration, async (iso, duration) => {
        const added = await call("add", { datetime: iso, duration })
        const d = (await call("diff", { start: iso, end: added.result })) as {
          difference: { milliseconds: number }
        }
        const expectedMs =
          duration.days * 86400000 +
          duration.hours * 3600000 +
          duration.minutes * 60000 +
          duration.seconds * 1000
        expect(d.difference.milliseconds).toBe(expectedMs)
      }),
      { numRuns: 50 },
    )
  })
})
