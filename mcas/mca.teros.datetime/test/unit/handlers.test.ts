/**
 * Contract de mca.teros.datetime (TER-503, batch B 7/N) con luxon REAL.
 *
 * Las 8 tools son funciones puras de datos — el caso canónico para
 * fast-check (properties en datetime.properties.test.ts). El dispatcher
 * devuelve content MCP: {content:[{type:'text', text}]} con JSON dentro —
 * se parsea y se asserta el shape exacto.
 */

import { describe, expect, it } from "bun:test"
import { handleToolCall } from "../../mcp/src/handlers"

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = (await handleToolCall(name, args)) as {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }
  expect(result.content[0].type).toBe("text")
  return JSON.parse(result.content[0].text)
}

async function callRaw(name: string, args: unknown) {
  return (await handleToolCall(name, args)) as {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }
}

describe("get-current", () => {
  it("timezone específica → zona y offset reales; shape exacto", async () => {
    const result = await call("get-current", { timezone: "Europe/Madrid" })
    expect(Object.keys(result)).toEqual(["datetime", "timezone", "offset", "timestamp"])
    expect(result.timezone).toBe("Europe/Madrid")
    expect(typeof result.timestamp).toBe("number")
    // junio: CEST = UTC+2
    expect(result.offset).toBe(120)
  })

  it("format custom aplica toFormat", async () => {
    const result = await call("get-current", { format: "yyyy" })
    expect(String(result.datetime)).toMatch(/^\d{4}$/)
  })

  it("zona NO-local (Asia/Tokyo) — el host corre en Europe/Madrid y no distinguiría local()", async () => {
    const result = await call("get-current", { timezone: "Asia/Tokyo" })
    expect(result.timezone).toBe("Asia/Tokyo")
    expect(result.offset).toBe(540)
  })

  it("timezone inválida → isError (luxon zone invalid revienta el toISO→null... pin del catch)", async () => {
    const raw = await callRaw("get-current", { timezone: "Marte/Cráter" })
    // setZone con zona inválida produce DateTime invalid → toISO() null → datetime null SIN error
    // (characterization: la tool no valida la zona; el agente recibe nulls)
    if (raw.isError) {
      expect(raw.content[0].text).toContain("Error")
    } else {
      const body = JSON.parse(raw.content[0].text)
      expect(body.datetime).toBeNull()
    }
  })
})

describe("format", () => {
  it("ISO → formato custom exacto", async () => {
    const raw = await callRaw("format", {
      datetime: "2026-06-05T10:30:00.000Z",
      format: "yyyy-MM-dd HH:mm",
    })
    // format devuelve el texto PLANO (no JSON)
    expect(raw.content[0].text).toMatch(/^2026-06-05 \d{2}:30$/)
    expect(raw.isError).toBeUndefined()
  })

  it("inputFormat parsea formatos no-ISO", async () => {
    const raw = await callRaw("format", {
      datetime: "05/06/2026",
      inputFormat: "dd/MM/yyyy",
      format: "yyyy-MM-dd",
    })
    expect(raw.content[0].text).toBe("2026-06-05")
  })

  it("datetime inválido → Error con invalidReason exacto de luxon", async () => {
    const raw = await callRaw("format", { datetime: "no-es-fecha", format: "yyyy" })
    expect(raw.isError).toBe(true)
    expect(raw.content[0].text).toBe("Error: Invalid datetime: unparsable")
  })
})

describe("parse", () => {
  it("ISO → {iso, timestamp, timezone, valid} exactos", async () => {
    const result = await call("parse", { datetime: "2026-06-05T10:00:00.000+02:00" })
    expect(Object.keys(result)).toEqual(["iso", "timestamp", "timezone", "valid"])
    expect(result.valid).toBe(true)
    expect(result.timestamp).toBe(Date.parse("2026-06-05T10:00:00.000+02:00"))
  })

  it("con format custom", async () => {
    const result = await call("parse", { datetime: "2026-06-05 10:00", format: "yyyy-MM-dd HH:mm" })
    expect(result.valid).toBe(true)
  })

  it("inválido → Error exacto", async () => {
    const raw = await callRaw("parse", { datetime: "garbage" })
    expect(raw.isError).toBe(true)
    expect(raw.content[0].text).toBe("Error: Invalid datetime: unparsable")
  })
})

describe("convert-timezone", () => {
  it("Madrid → New York: offsets e ISOs exactos (mismo instante)", async () => {
    const result = (await call("convert-timezone", {
      datetime: "2026-06-05T10:00:00",
      fromTimezone: "Europe/Madrid",
      toTimezone: "America/New_York",
    })) as {
      original: Record<string, unknown>
      converted: Record<string, unknown>
    }
    expect(result.original).toEqual({
      datetime: "2026-06-05T10:00:00.000+02:00",
      timezone: "Europe/Madrid",
      offset: 120,
    })
    expect(result.converted).toEqual({
      datetime: "2026-06-05T04:00:00.000-04:00",
      timezone: "America/New_York",
      offset: -240,
    })
  })

  it("datetime inválido → Error", async () => {
    const raw = await callRaw("convert-timezone", {
      datetime: "xx",
      fromTimezone: "UTC",
      toTimezone: "UTC",
    })
    expect(raw.isError).toBe(true)
  })
})

describe("add / subtract", () => {
  it("add: {days: 5, hours: 2} exacto", async () => {
    const result = await call("add", {
      datetime: "2026-06-05T10:00:00.000Z",
      duration: { days: 5, hours: 2 },
    })
    expect(result.original).toBe("2026-06-05T10:00:00.000+00:00")
    expect(result.result).toBe("2026-06-10T12:00:00.000+00:00")
    expect(result.duration).toEqual({ days: 5, hours: 2 })
  })

  it("subtract es el inverso", async () => {
    const result = await call("subtract", {
      datetime: "2026-06-10T12:00:00.000Z",
      duration: { days: 5, hours: 2 },
    })
    expect(result.result).toBe("2026-06-05T10:00:00.000+00:00")
  })

  it("add con base inválida → Error", async () => {
    const raw = await callRaw("add", { datetime: "zz", duration: { days: 1 } })
    expect(raw.isError).toBe(true)
    expect(raw.content[0].text).toBe("Error: Invalid datetime: unparsable")
  })
})

describe("diff", () => {
  it("unidad explícita → difference en esa unidad exacta", async () => {
    const result = await call("diff", {
      start: "2026-06-05T00:00:00.000Z",
      end: "2026-06-08T00:00:00.000Z",
      unit: "days",
    })
    expect(result.difference).toEqual({ days: 3 })
    expect(result.unit).toBe("days")
  })

  it("default milliseconds", async () => {
    const result = await call("diff", {
      start: "2026-06-05T00:00:00.000Z",
      end: "2026-06-05T00:00:01.000Z",
    })
    expect(result.difference).toEqual({ milliseconds: 1000 })
    expect(result.unit).toBe("milliseconds")
  })

  it("end inválido → Error específico del campo", async () => {
    const raw = await callRaw("diff", { start: "2026-06-05", end: "nope" })
    expect(raw.isError).toBe(true)
    expect(raw.content[0].text).toBe("Error: Invalid end datetime: unparsable")
  })

  it("start inválido → Error del start (no del end)", async () => {
    const raw = await callRaw("diff", { start: "nope", end: "2026-06-05" })
    expect(raw.content[0].text).toBe("Error: Invalid start datetime: unparsable")
  })
})

describe("is-valid", () => {
  it("válido → {valid: true, reason: null, explanation: null}", async () => {
    expect(await call("is-valid", { datetime: "2026-06-05" })).toEqual({
      valid: true,
      reason: null,
      explanation: null,
    })
  })

  it("inválido → valid false con reason (NO lanza — contrato distinto a format/parse)", async () => {
    const result = await call("is-valid", { datetime: "garbage" })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe("unparsable")
  })

  it("con format estricto", async () => {
    const result = await call("is-valid", { datetime: "05/06/2026", format: "dd/MM/yyyy" })
    expect(result.valid).toBe(true)
  })
})

describe("dispatcher", () => {
  it("unknown tool → isError con el nombre", async () => {
    const raw = await callRaw("no-existe", {})
    expect(raw.isError).toBe(true)
    expect(raw.content[0].text).toBe("Error: Unknown tool: no-existe")
  })

  it("error no-Error se stringifica", async () => {
    // diff con args undefined → TypeError de destructuring → catch genérico
    const raw = await callRaw("diff", undefined)
    expect(raw.isError).toBe(true)
    expect(raw.content[0].text).toStartWith("Error: ")
  })
})
